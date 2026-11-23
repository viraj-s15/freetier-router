import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { getDb, initDb } from '../../db/index.js';
import { encrypt } from '../../lib/crypto.js';
import type { Scheduler } from '../../lib/scheduler.js';
import {
  builtinDiscoveryMode,
  builtinDiscoveryIntervalMs,
  builtinDiscoveryPlatforms,
  DISCOVERED_RPD_LIMIT,
  DISCOVERED_RPM_LIMIT,
  autoRegistrable,
  builtinDiscoveryEligibility,
  registerDiscoveredModels,
  resetBuiltinDiscoveryThrottle,
  runBuiltinModelDiscovery,
  startBuiltinModelDiscovery,
  triggerBuiltinModelDiscovery,
} from '../../services/builtin-model-discovery.js';
import { applyCatalog } from '../../services/catalog-sync.js';
import { recordCatalogModelTombstone, isCatalogManagedModel, getCatalogModelTombstone } from '../../services/model-state.js';

// Built-in model discovery (#1348, widened by freetier-router): every built-in
// provider with an OpenAI-compatible /models is eligible unless the applied
// catalog rules it out, and the provider's free policy decides what an
// automatic pass adds. These tests pin eligibility, the schedule, the default
// limits, tombstones, and how catalog sync adopts and keeps discovered rows.

type AnyCatalog = Parameters<typeof applyCatalog>[1];

const realFetch = globalThis.fetch;
const ORIGINAL_MODE = process.env.BUILTIN_MODEL_DISCOVERY;
const ORIGINAL_PATTERNS = process.env.CUSTOM_MODEL_SYNC_FREE_PATTERNS;
const ORIGINAL_INTERVAL = process.env.BUILTIN_MODEL_DISCOVERY_INTERVAL_MS;
const ORIGINAL_CUSTOM_INTERVAL = process.env.CUSTOM_MODEL_SYNC_INTERVAL_MS;
const ORIGINAL_CHECKS = process.env.DISCOVERED_MODEL_CHECKS;

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

function catalogModel(platform: string, modelId: string, enabled = true): AnyCatalog['models'][number] {
  return {
    platform,
    modelId,
    displayName: `${modelId} (catalog)`,
    intelligenceRank: 10,
    speedRank: 5,
    sizeLabel: 'Large',
    limits: { rpm: 30, rpd: 1000, tpm: null, tpd: null },
    monthlyTokenBudget: '~1M',
    contextWindow: 131072,
    enabled,
    supportsVision: false,
    supportsTools: true,
  };
}

function catalogOf(models: AnyCatalog['models'], extra: Partial<AnyCatalog> = {}): AnyCatalog {
  return { version: '2099.01.01', generatedAt: new Date().toISOString(), tier: 'monthly', models, quirks: [], ...extra };
}

/** Pretend `catalog` was the last one applied (what the eligibility check reads). */
function cacheAppliedCatalog(catalog: AnyCatalog): void {
  getDb().prepare(`
    INSERT INTO settings (key, value) VALUES ('catalog_applied_json', ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value
  `).run(JSON.stringify(catalog));
}

function addKey(platform: string, secret = 'sk-test', status = 'healthy'): number {
  const { encrypted, iv, authTag } = encrypt(secret);
  const info = getDb().prepare(`
    INSERT INTO api_keys (platform, label, encrypted_key, iv, auth_tag, status, enabled)
    VALUES (?, '', ?, ?, ?, ?, 1)
  `).run(platform, encrypted, iv, authTag, status);
  return Number(info.lastInsertRowid);
}

function stubModels(ids: Array<string | Record<string, unknown>>) {
  const mock = vi.fn(async () => new Response(
    JSON.stringify({ object: 'list', data: ids.map(id => typeof id === 'string' ? { id } : id) }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  ));
  globalThis.fetch = mock as any;
  return mock;
}

function rows(platform: string, source?: string) {
  const all = getDb().prepare(
    `SELECT id, model_id, source, display_name, enabled, key_id, rpm_limit, rpd_limit, tpm_limit, tpd_limit
       FROM models WHERE platform = ? ORDER BY model_id`,
  ).all(platform) as Array<{
    id: number; model_id: string; source: string; display_name: string; enabled: number; key_id: number | null;
    rpm_limit: number | null; rpd_limit: number | null; tpm_limit: number | null; tpd_limit: number | null;
  }>;
  return source === undefined ? all : all.filter(r => r.source === source);
}

/** Every catalog row the bundled baseline wrote, so an apply exercises only the rows under test. */
function baselineCatalogRows(): AnyCatalog['models'] {
  return (getDb().prepare("SELECT platform, model_id FROM models WHERE source = 'catalog'").all() as Array<{ platform: string; model_id: string }>)
    .map(r => catalogModel(r.platform, r.model_id));
}

function fakeScheduler() {
  const every = vi.fn((_ms: number, _fn: () => void | Promise<void>, _opts?: { name?: string }) => () => {});
  return { scheduler: { every, after: vi.fn() } as unknown as Scheduler, every };
}

describe('built-in model discovery', () => {
  beforeEach(() => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    delete process.env.BUILTIN_MODEL_DISCOVERY;
    delete process.env.CUSTOM_MODEL_SYNC_FREE_PATTERNS;
    delete process.env.BUILTIN_MODEL_DISCOVERY_INTERVAL_MS;
    delete process.env.CUSTOM_MODEL_SYNC_INTERVAL_MS;
    delete process.env.DISCOVERED_MODEL_CHECKS;
    initDb(':memory:');
    resetBuiltinDiscoveryThrottle();
  });

  afterEach(() => {
    globalThis.fetch = realFetch;
    vi.restoreAllMocks();
    restoreEnv('BUILTIN_MODEL_DISCOVERY', ORIGINAL_MODE);
    restoreEnv('CUSTOM_MODEL_SYNC_FREE_PATTERNS', ORIGINAL_PATTERNS);
    restoreEnv('BUILTIN_MODEL_DISCOVERY_INTERVAL_MS', ORIGINAL_INTERVAL);
    restoreEnv('CUSTOM_MODEL_SYNC_INTERVAL_MS', ORIGINAL_CUSTOM_INTERVAL);
    restoreEnv('DISCOVERED_MODEL_CHECKS', ORIGINAL_CHECKS);
  });

  describe('mode', () => {
    it('defaults to auto when unset', () => {
      expect(builtinDiscoveryMode()).toBe('auto');
    });

    it('keeps manual and off', () => {
      process.env.BUILTIN_MODEL_DISCOVERY = 'manual';
      expect(builtinDiscoveryMode()).toBe('manual');
      process.env.BUILTIN_MODEL_DISCOVERY = 'off';
      expect(builtinDiscoveryMode()).toBe('off');
      process.env.BUILTIN_MODEL_DISCOVERY = 'false';
      expect(builtinDiscoveryMode()).toBe('off');
    });
  });

  describe('schedule', () => {
    it('runs every 6 hours by default', () => {
      expect(builtinDiscoveryIntervalMs()).toBe(6 * 60 * 60 * 1000);
      const { scheduler, every } = fakeScheduler();
      expect(startBuiltinModelDiscovery(getDb(), scheduler)).not.toBeNull();
      expect(every).toHaveBeenCalledWith(6 * 60 * 60 * 1000, expect.any(Function), { name: 'builtin-model-discovery' });
    });

    it('takes its interval from BUILTIN_MODEL_DISCOVERY_INTERVAL_MS and turns off at 0', () => {
      process.env.BUILTIN_MODEL_DISCOVERY_INTERVAL_MS = '60000';
      expect(builtinDiscoveryIntervalMs()).toBe(60000);
      process.env.BUILTIN_MODEL_DISCOVERY_INTERVAL_MS = '0';
      const { scheduler, every } = fakeScheduler();
      expect(startBuiltinModelDiscovery(getDb(), scheduler)).toBeNull();
      expect(every).not.toHaveBeenCalled();
    });

    it('falls back to the default on a malformed value', () => {
      process.env.BUILTIN_MODEL_DISCOVERY_INTERVAL_MS = 'soon';
      expect(builtinDiscoveryIntervalMs()).toBe(6 * 60 * 60 * 1000);
    });

    it('does not depend on CUSTOM_MODEL_SYNC_INTERVAL_MS', () => {
      process.env.CUSTOM_MODEL_SYNC_INTERVAL_MS = '0';
      const { scheduler, every } = fakeScheduler();
      expect(startBuiltinModelDiscovery(getDb(), scheduler)).not.toBeNull();
      expect(every).toHaveBeenCalledWith(6 * 60 * 60 * 1000, expect.any(Function), expect.anything());
    });

    it('schedules nothing in manual mode', () => {
      process.env.BUILTIN_MODEL_DISCOVERY = 'manual';
      const { scheduler } = fakeScheduler();
      expect(startBuiltinModelDiscovery(getDb(), scheduler)).toBeNull();
    });
  });

  describe('eligibility', () => {
    it('covers catalog-managed providers that can list their models', () => {
      cacheAppliedCatalog(catalogOf([catalogModel('groq', 'llama-x')]));
      expect(builtinDiscoveryEligibility(getDb(), 'groq')).toMatchObject({ eligible: true });
      expect(builtinDiscoveryEligibility(getDb(), 'siliconflow').eligible).toBe(true);
    });

    it('lists every OpenAI-compatible built-in platform, and not custom or native adapters', () => {
      const platforms = builtinDiscoveryPlatforms();
      expect(platforms).toEqual(expect.arrayContaining(['groq', 'mistral', 'openrouter', 'siliconflow', 'longcat']));
      expect(platforms).not.toContain('custom');
      expect(platforms).not.toContain('google');
      expect(platforms).not.toContain('cohere');
      expect(platforms).not.toContain('cloudflare');
    });

    it('rejects a provider whose adapter cannot list models', () => {
      expect(builtinDiscoveryEligibility(getDb(), 'google')).toMatchObject({ eligible: false, reason: 'not_openai_compatible' });
      expect(builtinDiscoveryEligibility(getDb(), 'custom').eligible).toBe(false);
    });

    it('rules out a provider whose catalog chat rows are all disabled', () => {
      cacheAppliedCatalog(catalogOf([catalogModel('opencode', 'a', false), catalogModel('opencode', 'b', false)]));
      expect(builtinDiscoveryEligibility(getDb(), 'opencode')).toMatchObject({ eligible: false, reason: 'catalog_ruled_out' });
    });

    it('keeps a provider eligible when at least one catalog row is enabled', () => {
      cacheAppliedCatalog(catalogOf([catalogModel('requesty', 'a', false), catalogModel('requesty', 'b', true)]));
      expect(builtinDiscoveryEligibility(getDb(), 'requesty').eligible).toBe(true);
    });

    it('ignores models the operator disabled locally', () => {
      cacheAppliedCatalog(catalogOf([catalogModel('groq', 'llama-x')]));
      getDb().prepare("UPDATE models SET enabled = 0 WHERE platform = 'groq'").run();
      expect(builtinDiscoveryEligibility(getDb(), 'groq').eligible).toBe(true);
    });

    it('does not count a names-only managedPlatforms entry as a ruling', () => {
      cacheAppliedCatalog(catalogOf([], { managedPlatforms: ['longcat'] }));
      expect(builtinDiscoveryEligibility(getDb(), 'longcat').eligible).toBe(true);
    });

    it('can be switched off', () => {
      process.env.BUILTIN_MODEL_DISCOVERY = 'off';
      expect(builtinDiscoveryEligibility(getDb(), 'groq')).toMatchObject({ eligible: false, reason: 'disabled' });
    });
  });

  describe('registration', () => {
    it('writes discovered rows with default limits at the end of the chain, off until a probe', () => {
      const db = getDb();
      const before = (db.prepare('SELECT COALESCE(MAX(priority), 0) AS m FROM fallback_config').get() as { m: number }).m;
      const result = registerDiscoveredModels(db, 'groq', [{ modelId: 'brand-new', contextWindow: 65536 }], { explicit: false });
      expect(result.created).toEqual(['brand-new']);
      const [row] = rows('groq', 'discovered');
      expect(row).toMatchObject({
        model_id: 'brand-new', enabled: 0, key_id: null,
        rpm_limit: DISCOVERED_RPM_LIMIT, rpd_limit: DISCOVERED_RPD_LIMIT, tpm_limit: null, tpd_limit: null,
      });
      expect(DISCOVERED_RPM_LIMIT).toBe(10);
      expect(DISCOVERED_RPD_LIMIT).toBe(250);
      const fb = db.prepare('SELECT priority FROM fallback_config WHERE model_db_id = ?').get(row!.id) as { priority: number };
      expect(fb.priority).toBeGreaterThan(before);
      expect(isCatalogManagedModel({ platform: 'groq', key_id: null, source: 'discovered' })).toBe(true);
    });

    it('never overwrites an existing row, from any source', () => {
      const db = getDb();
      db.prepare(`INSERT INTO models (platform, model_id, display_name, intelligence_rank, speed_rank, size_label, source, enabled)
                  VALUES ('groq', 'from-catalog', 'Catalog', 1, 1, 'Large', 'catalog', 0)`).run();
      const result = registerDiscoveredModels(db, 'groq', [{ modelId: 'from-catalog' }, { modelId: 'fresh' }], { explicit: false });
      expect(result.existing).toEqual(['from-catalog']);
      expect(result.created).toEqual(['fresh']);
      expect(rows('groq').find(r => r.model_id === 'from-catalog')).toMatchObject({ source: 'catalog', enabled: 0, display_name: 'Catalog' });
    });

    it('skips an operator deletion on automatic passes; an explicit pick lifts it', () => {
      const db = getDb();
      recordCatalogModelTombstone(db, 'chat', 'groq', 'gone');
      expect(registerDiscoveredModels(db, 'groq', [{ modelId: 'gone' }], { explicit: false }).tombstoned).toEqual(['gone']);
      expect(rows('groq', 'discovered')).toEqual([]);
      expect(registerDiscoveredModels(db, 'groq', [{ modelId: 'gone' }], { explicit: true }).created).toEqual(['gone']);
      expect(getCatalogModelTombstone(db, 'chat', 'groq', 'gone')).toBeUndefined();
    });

    it('skips a model the catalog removed; an explicit pick adds it and clears the tombstone', () => {
      const db = getDb();
      recordCatalogModelTombstone(db, 'chat', 'groq', 'old-model', { source: 'catalog_removed' });
      expect(registerDiscoveredModels(db, 'groq', [{ modelId: 'old-model' }], { explicit: false }).tombstoned).toEqual(['old-model']);
      expect(rows('groq', 'discovered')).toEqual([]);
      expect(registerDiscoveredModels(db, 'groq', [{ modelId: 'old-model' }], { explicit: true }).created).toEqual(['old-model']);
      expect(getCatalogModelTombstone(db, 'chat', 'groq', 'old-model')).toBeUndefined();
    });
  });

  describe('automatic filtering', () => {
    it('adds chat models a free-key provider lists, and skips non-chat and priced ones', () => {
      const { accepted, nonChat, paid } = autoRegistrable('groq', [
        { id: 'chat-a', ownedBy: null },
        { id: 'text-embedding-3', ownedBy: null, kind: 'embedding' },
        { id: 'whisper-x', ownedBy: null, kind: 'transcription' },
        { id: 'paid-chat', ownedBy: null, priceNote: '$1/M in $2/M out', isFree: false },
        { id: 'free-chat', ownedBy: null, priceNote: 'free', isFree: true },
      ]);
      expect(accepted.map(m => m.id)).toEqual(['chat-a', 'free-chat']);
      expect(nonChat).toBe(2);
      expect(paid).toBe(1);
    });

    it('adds nothing for a provider with no free policy', () => {
      const { accepted, paid } = autoRegistrable('siliconflow', [
        { id: 'deepseek-ai/DeepSeek-V3', ownedBy: null },
        { id: 'free-one', ownedBy: null, priceNote: 'free', isFree: true },
      ]);
      expect(accepted).toEqual([]);
      expect(paid).toBe(2);
    });

    it('adds only priced-free models for a priced-listing provider', () => {
      const { accepted } = autoRegistrable('openrouter', [
        { id: 'vendor/a:free', ownedBy: null, priceNote: 'free', isFree: true },
        { id: 'vendor/b:free', ownedBy: null },
        { id: 'vendor/c', ownedBy: null, priceNote: '$1/M in', isFree: false },
      ]);
      expect(accepted.map(m => m.id)).toEqual(['vendor/a:free']);
    });

    it('lets CUSTOM_MODEL_SYNC_FREE_PATTERNS narrow every policy', () => {
      process.env.CUSTOM_MODEL_SYNC_FREE_PATTERNS = 'llama-*';
      const { accepted } = autoRegistrable('groq', [{ id: 'llama-4', ownedBy: null }, { id: 'qwen-3', ownedBy: null }]);
      expect(accepted.map(m => m.id)).toEqual(['llama-4']);
    });
  });

  describe('runBuiltinModelDiscovery', () => {
    it('reads a catalog-managed provider with the stored key and adds new models the policy accepts', async () => {
      cacheAppliedCatalog(catalogOf([catalogModel('groq', 'llama-x')]));
      addKey('groq', 'gsk-test');
      const mock = stubModels(['brand-new-model', 'distil-whisper-large-v3-en', { id: 'paid-one', pricing: { prompt: '0.000001', completion: '0.000002' } }]);

      const result = await runBuiltinModelDiscovery(getDb());

      expect(String(mock.mock.calls[0]![0])).toBe('https://api.groq.com/openai/v1/models');
      const init = mock.mock.calls[0]![1] as RequestInit;
      expect((init.headers as Record<string, string>).Authorization).toBe('Bearer gsk-test');
      expect(rows('groq', 'discovered').map(r => r.model_id)).toEqual(['brand-new-model']);
      expect(result.added).toBe(1);
      expect(result.paidSkipped).toBe(1);
    });

    it('does nothing for a platform without a usable key, or in manual mode', async () => {
      const mock = stubModels(['x']);
      expect((await runBuiltinModelDiscovery(getDb())).platforms).toBe(0);
      addKey('groq', 'sk', 'invalid');
      expect((await runBuiltinModelDiscovery(getDb())).platforms).toBe(0);
      addKey('groq');
      process.env.BUILTIN_MODEL_DISCOVERY = 'manual';
      expect((await runBuiltinModelDiscovery(getDb())).platforms).toBe(0);
      expect(mock).not.toHaveBeenCalled();
    });

    it('never calls a provider whose free policy can accept nothing', async () => {
      addKey('siliconflow');
      const mock = stubModels(['deepseek-ai/DeepSeek-V3']);
      expect((await runBuiltinModelDiscovery(getDb(), 'siliconflow')).platforms).toBe(0);
      expect(triggerBuiltinModelDiscovery(getDb(), 'siliconflow', 'key_added')).toBeNull();
      expect(mock).not.toHaveBeenCalled();
    });

    it('never calls a provider the catalog rules out', async () => {
      cacheAppliedCatalog(catalogOf([catalogModel('opencode', 'a', false)]));
      addKey('opencode');
      const mock = stubModels(['a']);
      await runBuiltinModelDiscovery(getDb(), 'opencode');
      expect(triggerBuiltinModelDiscovery(getDb(), 'opencode', 'key_added')).toBeNull();
      expect(mock).not.toHaveBeenCalled();
    });

    it('records upstream failures without throwing', async () => {
      addKey('groq');
      globalThis.fetch = vi.fn(async () => new Response('{"error":{"message":"bad key"}}', { status: 401 })) as any;
      const result = await runBuiltinModelDiscovery(getDb());
      expect(result.failures).toEqual([{ platform: 'groq', error: expect.stringContaining('rejected the key') }]);
    });

    it('the healthy-check trigger runs once for an empty platform and then stays quiet', async () => {
      addKey('sealion');
      const mock = stubModels(['aisingapore/Qwen-SEA-LION-v4.5-27B-IT']);
      await triggerBuiltinModelDiscovery(getDb(), 'sealion', 'healthy');
      expect(rows('sealion', 'discovered').map(r => r.model_id)).toEqual(['aisingapore/Qwen-SEA-LION-v4.5-27B-IT']);
      expect(triggerBuiltinModelDiscovery(getDb(), 'sealion', 'healthy')).toBeNull();
      expect(mock.mock.calls.filter(c => String(c[0]).endsWith('/models'))).toHaveLength(1);
    });
  });

  describe('catalog precedence on sync', () => {
    it('adopts a discovered row the catalog lists and keeps the unlisted ones', () => {
      const db = getDb();
      registerDiscoveredModels(db, 'groq', [{ modelId: 'listed' }, { modelId: 'unlisted' }], { explicit: false });
      const listedId = rows('groq').find(r => r.model_id === 'listed')!.id;

      applyCatalog(db, catalogOf([...baselineCatalogRows(), catalogModel('groq', 'listed')]));

      const groq = rows('groq');
      expect(groq.find(r => r.model_id === 'listed')).toMatchObject({
        id: listedId, source: 'catalog', display_name: 'listed (catalog)', rpm_limit: 30, rpd_limit: 1000,
      });
      expect(groq.find(r => r.model_id === 'unlisted')).toMatchObject({
        source: 'discovered', rpm_limit: DISCOVERED_RPM_LIMIT, rpd_limit: DISCOVERED_RPD_LIMIT, enabled: 0,
      });
    });

    it('keeps discovered rows when the catalog manages the platform by name only', () => {
      const db = getDb();
      registerDiscoveredModels(db, 'longcat', [{ modelId: 'a' }], { explicit: false });
      applyCatalog(db, catalogOf(baselineCatalogRows(), { managedPlatforms: ['longcat'] }));
      expect(rows('longcat', 'discovered').map(r => r.model_id)).toEqual(['a']);
    });

    it('keeps a local disable when the catalog adopts a discovered row', () => {
      // With the checks on, a new row is already off, so the disable is tested on a row that started on.
      process.env.DISCOVERED_MODEL_CHECKS = 'off';
      const db = getDb();
      registerDiscoveredModels(db, 'groq', [{ modelId: 'listed' }], { explicit: false });
      db.prepare("UPDATE models SET enabled = 0 WHERE platform = 'groq' AND model_id = 'listed'").run();
      applyCatalog(db, catalogOf([...baselineCatalogRows(), catalogModel('groq', 'listed')]));
      expect(rows('groq').find(r => r.model_id === 'listed')).toMatchObject({ source: 'catalog', enabled: 0 });
    });

    it('does not let discovery add back a model the catalog dropped', async () => {
      const db = getDb();
      const baseline = baselineCatalogRows();
      registerDiscoveredModels(db, 'groq', [{ modelId: 'short-lived' }], { explicit: false });
      applyCatalog(db, catalogOf([...baseline, catalogModel('groq', 'short-lived')]));
      applyCatalog(db, catalogOf(baseline));
      expect(rows('groq').find(r => r.model_id === 'short-lived')).toBeUndefined();
      expect(getCatalogModelTombstone(db, 'chat', 'groq', 'short-lived')?.source).toBe('catalog_removed');

      addKey('groq');
      stubModels(['short-lived']);
      const result = await runBuiltinModelDiscovery(db, 'groq');
      expect(result.tombstoned).toBe(1);
      expect(rows('groq').find(r => r.model_id === 'short-lived')).toBeUndefined();
    });
  });
});
