import type { Db } from '../db/types.js';
import type { Scheduler } from '../lib/scheduler.js';
import type { Platform } from '@freellmapi/shared/types.js';
import { getAllProviders, getProvider } from '../providers/index.js';
import type { BaseProvider } from '../providers/base.js';
import { OpenAICompatProvider } from '../providers/openai-compat.js';
import { decrypt } from '../lib/crypto.js';
import { decryptProxyUrl } from '../lib/key-proxy.js';
import { withKeyProxy } from '../lib/proxy.js';
import { discoverProviderModels, type DiscoveredModel } from './model-discovery.js';
import { catalogRuledOutPlatforms, DISCOVERED_MODEL_SOURCE } from './catalog-sync.js';
import { blocksAutomaticDiscovery, clearCatalogModelTombstone } from './model-state.js';
import { customModelSeed } from './custom-model-seed.js';
import { ensureModelInProfiles } from './profile-models.js';
import { customModelSyncFreePatterns } from './custom-model-sync.js';
import { acceptsModel, patternMatches, policyCanAccept } from './free-policy.js';

// ── Model discovery for built-in providers (#1348, widened by freetier-router) ──
//
// The free catalog reaches free installs 30 days after a model launches, while
// each provider's own /models lists it on day zero. This asks every built-in
// provider that can list its models (through the registered adapter, with the
// operator's own key) and registers what its free policy allows, the same way
// custom-endpoint discovery (#488) does.
//
// The signed, audited catalog still outranks discovery:
//  - A platform the applied catalog rules out (it carries chat rows for the
//    platform and disables every one) is not eligible.
//  - Which discovered models an automatic pass may add is decided per
//    provider in free-policy.ts. A provider with no entry gets none.
//  - Rows are written with models.source = 'discovered', never 'user': a
//    'user' row outranks the catalog on a collision, a discovered row never
//    does. catalog-sync adopts a discovered row once the catalog lists it, and
//    leaves every other discovered row alone. Writes are INSERT-only: an
//    existing row (catalog, user or an earlier discovery the operator has
//    since tuned) is never touched.
//  - An automatic pass skips a model the operator deleted and a model the
//    catalog removed (both are tombstones). Only an explicit pick in the
//    dashboard lifts them.

/** Starting limits for a discovered row until the catalog adopts it. A NULL
 *  limit escapes pre-throttling, and these sit at the low end of documented
 *  free tiers, so a new model can't set off a 429 storm. */
export const DISCOVERED_RPM_LIMIT = 10;
export const DISCOVERED_RPD_LIMIT = 250;

const DEFAULT_DISCOVERY_INTERVAL_MS = 6 * 60 * 60 * 1000;

/** `BUILTIN_MODEL_DISCOVERY`: 'auto' (default) discovers on key save, after a
 *  healthy check and on its own schedule; 'manual' keeps only the dashboard's
 *  Fetch models action; 'off' disables both. Auto is safe as the default
 *  because the free policy, not the mode, decides what gets added. */
export type BuiltinDiscoveryMode = 'auto' | 'manual' | 'off';

export function builtinDiscoveryMode(): BuiltinDiscoveryMode {
  const raw = process.env.BUILTIN_MODEL_DISCOVERY?.trim().toLowerCase();
  if (raw === 'manual' || raw === 'off') return raw;
  if (raw === '0' || raw === 'false' || raw === 'disabled') return 'off';
  return 'auto';
}

/** Interval in ms from `BUILTIN_MODEL_DISCOVERY_INTERVAL_MS`; 0 disables the
 *  scheduled pass, and anything unset or malformed falls back to 6 hours. */
export function builtinDiscoveryIntervalMs(): number {
  const raw = process.env.BUILTIN_MODEL_DISCOVERY_INTERVAL_MS;
  if (raw === undefined || raw.trim() === '') return DEFAULT_DISCOVERY_INTERVAL_MS;
  const ms = Number(raw);
  return Number.isFinite(ms) && ms >= 0 ? ms : DEFAULT_DISCOVERY_INTERVAL_MS;
}

/** The adapter that can list this provider's models, when it can. Google and
 *  other native adapters get a branch here (and in discoverBuiltinModels) when
 *  they gain a lister; the discovery loop stays as it is. */
export function modelLister(provider: BaseProvider | undefined): OpenAICompatProvider | undefined {
  return provider instanceof OpenAICompatProvider ? provider : undefined;
}

export type IneligibleReason = 'disabled' | 'not_openai_compatible' | 'catalog_ruled_out';

export interface DiscoveryEligibility {
  eligible: boolean;
  reason?: IneligibleReason;
  /** The registered adapter, when eligible. */
  provider?: OpenAICompatProvider;
}

/** Whether `platform` may fill its model list from its own /models. */
export function builtinDiscoveryEligibility(db: Db, platform: string): DiscoveryEligibility {
  if (builtinDiscoveryMode() === 'off') return { eligible: false, reason: 'disabled' };
  if (platform === 'custom') return { eligible: false, reason: 'not_openai_compatible' };
  const provider = modelLister(getProvider(platform as Platform));
  if (!provider) return { eligible: false, reason: 'not_openai_compatible' };
  if (catalogRuledOutPlatforms(db).has(platform)) return { eligible: false, reason: 'catalog_ruled_out' };
  return { eligible: true, provider };
}

/** Every built-in platform with a model lister, in registry order. */
export function builtinDiscoveryPlatforms(): string[] {
  return getAllProviders()
    .filter(p => p.platform !== 'custom' && modelLister(p) !== undefined)
    .map(p => p.platform);
}

export function isBuiltinDiscoveryEligible(db: Db, platform: string): boolean {
  return builtinDiscoveryEligibility(db, platform).eligible;
}

/** A human sentence for an ineligible platform, for route errors. */
export function ineligibleMessage(platform: string, reason: IneligibleReason | undefined): string {
  switch (reason) {
    case 'disabled':
      return 'Model discovery for built-in providers is turned off (BUILTIN_MODEL_DISCOVERY=off).';
    case 'catalog_ruled_out':
      return `The catalog disables every ${platform} model, so ${platform} models are not fetched from the provider.`;
    default:
      return `${platform} can't list its models, so its models come from the catalog only.`;
  }
}

interface KeyRow {
  id: number;
  platform: string;
  encrypted_key: string;
  iv: string;
  auth_tag: string;
  proxy_encrypted?: string | null;
  proxy_iv?: string | null;
  proxy_auth_tag?: string | null;
}

/** Fetch the platform's /models with one of its keys, through that key's own
 *  proxy (#590), exactly as the health check reaches it. */
export async function discoverBuiltinModels(
  provider: OpenAICompatProvider,
  key: KeyRow,
  apiKeyOverride?: string,
): Promise<DiscoveredModel[]> {
  const apiKey = apiKeyOverride?.trim() || decrypt(key.encrypted_key, key.iv, key.auth_tag);
  return withKeyProxy(decryptProxyUrl(key), () => discoverProviderModels(provider, apiKey, provider.modelsUrl.replace(/\/models\/?$/, '')));
}

/** Discovered model ids already present on this platform, in any provenance. */
export function registeredModelIds(db: Db, platform: string): Set<string> {
  return new Set(
    (db.prepare("SELECT model_id FROM models WHERE platform = ? AND endpoint_scope = ''").all(platform) as { model_id: string }[])
      .map(r => r.model_id),
  );
}

export interface DiscoveredEntry {
  modelId: string;
  contextWindow?: number;
  vision?: boolean;
}

export interface RegisterDiscoveredResult {
  created: string[];
  /** Already present (catalog, user or earlier discovery): left untouched. */
  existing: string[];
  /** Deleted by the operator and not lifted (automatic passes only). */
  tombstoned: string[];
}

/**
 * Insert discovered chat models for a built-in platform. INSERT-only: a row
 * that already exists for (platform, model_id) in the built-in scope is never
 * updated, so catalog rows, user rows and anything the operator tuned by hand
 * all win. `explicit` marks a pick the operator made in the dashboard, which
 * lifts a previous deletion, the way re-adding a custom model does (#926).
 */
export function registerDiscoveredModels(
  db: Db,
  platform: string,
  entries: DiscoveredEntry[],
  options: { explicit: boolean },
): RegisterDiscoveredResult {
  return db.transaction(() => {
    const result: RegisterDiscoveredResult = { created: [], existing: [], tombstoned: [] };
    const seed = customModelSeed(db);
    const exists = db.prepare("SELECT 1 FROM models WHERE platform = ? AND model_id = ? AND endpoint_scope = ''");
    const insert = db.prepare(`
      INSERT INTO models
        (platform, model_id, display_name, intelligence_rank, speed_rank, size_label,
         rpm_limit, rpd_limit, tpm_limit, tpd_limit, monthly_token_budget, context_window, enabled, key_id,
         supports_tools, supports_vision, source, endpoint_scope)
      VALUES (@platform, @modelId, @modelId, @intelligenceRank, @speedRank, @sizeLabel,
         @rpmLimit, @rpdLimit, NULL, NULL, '', @contextWindow, 1, NULL,
         1, @vision, @source, '')
      ON CONFLICT(platform, model_id, endpoint_scope) DO NOTHING
    `);
    const selectId = db.prepare("SELECT id FROM models WHERE platform = ? AND model_id = ? AND endpoint_scope = ''");
    const inChain = db.prepare('SELECT 1 FROM fallback_config WHERE model_db_id = ?');
    const maxPriority = db.prepare('SELECT COALESCE(MAX(priority), 0) AS m FROM fallback_config');
    const addToChain = db.prepare('INSERT INTO fallback_config (model_db_id, priority, enabled) VALUES (?, ?, 1)');

    for (const entry of entries) {
      if (exists.get(platform, entry.modelId)) {
        result.existing.push(entry.modelId);
        continue;
      }
      if (blocksAutomaticDiscovery(db, 'chat', platform, entry.modelId)) {
        if (!options.explicit) {
          result.tombstoned.push(entry.modelId);
          continue;
        }
        clearCatalogModelTombstone(db, 'chat', platform, entry.modelId);
      }
      insert.run({
        platform,
        modelId: entry.modelId,
        intelligenceRank: seed.intelligenceRank,
        speedRank: seed.speedRank,
        sizeLabel: seed.sizeLabel,
        rpmLimit: DISCOVERED_RPM_LIMIT,
        rpdLimit: DISCOVERED_RPD_LIMIT,
        contextWindow: entry.contextWindow ?? null,
        vision: entry.vision ? 1 : 0,
        source: DISCOVERED_MODEL_SOURCE,
      });
      const row = selectId.get(platform, entry.modelId) as { id: number };
      if (!inChain.get(row.id)) {
        addToChain.run(row.id, (maxPriority.get() as { m: number }).m + 1);
      }
      ensureModelInProfiles(db, row.id);
      result.created.push(entry.modelId);
    }
    return result;
  })();
}

/**
 * Which discovered models an AUTOMATIC pass may register for `platform`.
 * Stricter than a dashboard pick, because nobody looked at the list:
 *  - chat only: embedding, image, audio, transcription and video ids are
 *    skipped (#1051), as in the custom-model sync;
 *  - the platform's free policy (free-policy.ts) must accept the model;
 *  - CUSTOM_MODEL_SYNC_FREE_PATTERNS, when set, narrows every policy (#746).
 */
export function autoRegistrable(
  platform: string,
  models: DiscoveredModel[],
): { accepted: DiscoveredModel[]; nonChat: number; paid: number } {
  const freePatterns = customModelSyncFreePatterns();
  const accepted: DiscoveredModel[] = [];
  let nonChat = 0;
  let paid = 0;
  for (const model of models) {
    if (model.kind !== undefined) { nonChat += 1; continue; }
    if (!acceptsModel(platform, model)) { paid += 1; continue; }
    if (freePatterns.length > 0 && !freePatterns.some(p => patternMatches(p, model.id))) { paid += 1; continue; }
    accepted.push(model);
  }
  return { accepted, nonChat, paid };
}

export interface BuiltinDiscoveryResult {
  platforms: number;
  added: number;
  skipped: number;
  tombstoned: number;
  nonChatSkipped: number;
  paidSkipped: number;
  failures: Array<{ platform: string; error: string }>;
}

function usableKeys(db: Db, platform: string): KeyRow[] {
  return db.prepare(`
    SELECT id, platform, encrypted_key, iv, auth_tag, proxy_encrypted, proxy_iv, proxy_auth_tag
      FROM api_keys
     WHERE platform = ? AND enabled = 1 AND status != 'invalid'
     ORDER BY CASE status WHEN 'healthy' THEN 0 ELSE 1 END, id
  `).all(platform) as KeyRow[];
}

/**
 * One automatic discovery pass over every eligible platform that has a usable
 * key (or just `only`, when given). ADD-ONLY, like the custom-model sync: a
 * model that vanishes upstream is left for the health and retirement paths.
 */
export async function runBuiltinModelDiscovery(db: Db, only?: string): Promise<BuiltinDiscoveryResult> {
  const result: BuiltinDiscoveryResult = {
    platforms: 0, added: 0, skipped: 0, tombstoned: 0, nonChatSkipped: 0, paidSkipped: 0, failures: [],
  };
  if (builtinDiscoveryMode() !== 'auto') return result;

  const platforms = only ? [only] : builtinDiscoveryPlatforms();
  for (const platform of platforms) {
    const eligibility = builtinDiscoveryEligibility(db, platform);
    if (!eligibility.eligible || !eligibility.provider) continue;
    // Nothing could pass the policy, so don't spend a /models call (some
    // catalog-only gateways meter it) on a list that would all be dropped.
    if (!policyCanAccept(platform)) continue;
    const keys = usableKeys(db, platform);
    if (keys.length === 0) continue;
    result.platforms += 1;
    try {
      const discovered = await discoverBuiltinModels(eligibility.provider, keys[0]!);
      // Re-check after the network round-trip: a catalog sync may have landed
      // in between, and the catalog always wins.
      if (!isBuiltinDiscoveryEligible(db, platform)) continue;
      const { accepted, nonChat, paid } = autoRegistrable(platform, discovered);
      result.nonChatSkipped += nonChat;
      result.paidSkipped += paid;
      const registered = registerDiscoveredModels(
        db,
        platform,
        accepted.map(m => ({ modelId: m.id, contextWindow: m.contextWindow, vision: m.vision })),
        { explicit: false },
      );
      result.added += registered.created.length;
      result.skipped += registered.existing.length;
      result.tombstoned += registered.tombstoned.length;
      if (registered.created.length > 0) {
        console.log(`[builtin-model-discovery] ${platform}: registered ${registered.created.length} discovered model(s)`);
      }
    } catch (err: any) {
      const message = err?.message ?? String(err);
      result.failures.push({ platform, error: message });
      console.error(`[builtin-model-discovery] ${platform}: ${message}`);
    }
  }
  return result;
}

// Event-driven passes (key saved, key checked healthy) for one platform. At
// most one in flight per platform, and a platform that already has models is
// left to the scheduled pass, so the 5-minute health cycle never turns into a
// 5-minute /models poll.
const inFlight = new Map<string, Promise<BuiltinDiscoveryResult>>();
const lastEventRunMs = new Map<string, number>();
const EVENT_MIN_GAP_MS = 60 * 60 * 1000;

export function triggerBuiltinModelDiscovery(
  db: Db,
  platform: string,
  reason: 'key_added' | 'healthy',
): Promise<BuiltinDiscoveryResult> | null {
  if (builtinDiscoveryMode() !== 'auto') return null;
  // Callers (the health check, key save) fire and forget: a failure here must
  // never change their own result, so the synchronous checks can't throw out.
  try {
    if (!policyCanAccept(platform) || !isBuiltinDiscoveryEligible(db, platform)) return null;
  } catch (err: unknown) {
    console.error(`[builtin-model-discovery] ${platform}: ${(err as Error)?.message ?? err}`);
    return null;
  }
  const pending = inFlight.get(platform);
  if (pending) return pending;
  if (reason === 'healthy') {
    const hasModels = db.prepare('SELECT 1 FROM models WHERE platform = ? LIMIT 1').get(platform);
    if (hasModels) return null;
    const last = lastEventRunMs.get(platform) ?? 0;
    if (Date.now() - last < EVENT_MIN_GAP_MS) return null;
  }
  lastEventRunMs.set(platform, Date.now());
  const run = runBuiltinModelDiscovery(db, platform)
    .catch((err: unknown): BuiltinDiscoveryResult => {
      console.error(`[builtin-model-discovery] ${platform}: ${(err as Error)?.message ?? err}`);
      return { platforms: 0, added: 0, skipped: 0, tombstoned: 0, nonChatSkipped: 0, paidSkipped: 0, failures: [] };
    })
    .finally(() => inFlight.delete(platform));
  inFlight.set(platform, run);
  return run;
}

/** Test hook: forget event throttling between cases. */
export function resetBuiltinDiscoveryThrottle(): void {
  inFlight.clear();
  lastEventRunMs.clear();
}

/** Run the pass on its own cadence (BUILTIN_MODEL_DISCOVERY_INTERVAL_MS, every
 *  6 hours by default; 0 disables the scheduled pass). On a platform that
 *  already has models the event trigger stays quiet, so this is what finds a
 *  new model there. */
export function startBuiltinModelDiscovery(db: Db, scheduler: Scheduler): (() => void) | null {
  const intervalMs = builtinDiscoveryIntervalMs();
  if (intervalMs <= 0 || builtinDiscoveryMode() !== 'auto') return null;
  return scheduler.every(intervalMs, () => { void runBuiltinModelDiscovery(db); }, { name: 'builtin-model-discovery' });
}
