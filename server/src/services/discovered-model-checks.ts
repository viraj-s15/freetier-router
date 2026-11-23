import { getDb } from '../db/index.js';
import type { Db } from '../db/types.js';
import {
  isAccountSuspendedError,
  isClientAbortError,
  isKeyAuthError,
  isModelAccessForbiddenError,
  isModelNotFoundError,
} from '../lib/error-classify.js';
import { summarizeAttemptError } from '../lib/error-redaction.js';
import { providerLog } from '../lib/server-logs.js';
import { getModelGroups, isUnifyEnabled } from './model-groups.js';

// ── Health checks for discovered models (freetier-router) ──
//
// Built-in discovery adds models that nobody tested. This file keeps one check
// row for each discovered model in its own table, `discovered_model_checks`,
// and owns every write that the probe (discovered-model-probe.ts) and the
// failure rule (discovered-model-failures.ts) make to `models.enabled` and
// `models.supports_tools`. The fork turns a model off with `models.enabled`,
// so the router needs no change, and it never touches the chain switches.
//
// The table is created on demand and is not in db/migrate/defaults.ts, because
// upstream appends to that list in most releases and a fork entry there would
// conflict on most syncs.

export type CheckState = 'pending' | 'ok' | 'probe_failed' | 'auto_disabled' | 'operator';
export type DisableReason = 'probe_failed' | 'auto_disabled';

export interface CheckRow {
  model_db_id: number;
  state: CheckState;
  held_off: number;
  probe_failures: number;
  tools_checked: number;
  tools_value: number;
  failure_times: string;
  last_error: string | null;
  updated_at: number;
}

/** A check row joined with the model columns that the checks read. */
export interface CheckedModel extends CheckRow {
  platform: string;
  model_id: string;
  source: string;
  enabled: number;
  supports_tools: number;
  rpm_limit: number | null;
  rpd_limit: number | null;
}

/** Failed probes after which a model stays off. */
export const PROBE_FAILURE_LIMIT = 3;

const DISCOVERED_SOURCE = 'discovered';

interface HandleState {
  /** Model ids whose `failure_times` isn't empty, so the success hook is one lookup. */
  withFailures: Set<number>;
  /** Listed id (as /v1/models shows it) → the reason the checks turned it off. */
  reasons: Map<string, DisableReason>;
  /** Platforms whose probe step is in progress. */
  probing: Set<string>;
  /** Model id → the request trace that last counted a failure. */
  lastTrace: Map<number, unknown>;
}

const handles = new WeakMap<Db, HandleState>();

// ── Setting ──

export type DiscoveredChecksMode = 'on' | 'off';

let warnedValue: string | undefined;

/** `DISCOVERED_MODEL_CHECKS`: 'on' (the default) or 'off'. Any other value counts as 'on'. */
export function discoveredChecksMode(): DiscoveredChecksMode {
  const raw = process.env.DISCOVERED_MODEL_CHECKS?.trim().toLowerCase();
  if (!raw || raw === 'on') return 'on';
  if (raw === 'off') return 'off';
  if (warnedValue !== raw) {
    warnedValue = raw;
    console.warn(`[discovered-model-checks] unknown DISCOVERED_MODEL_CHECKS value "${raw}"; using "on"`);
  }
  return 'on';
}

export function discoveredChecksOn(): boolean {
  return discoveredChecksMode() === 'on';
}

// ── Errors ──

/**
 * An error that says this model won't work for this account, as opposed to a
 * busy provider or a bad key. The probe and the failure rule both use it, so
 * the two can't disagree on what counts.
 */
export function isPermanentModelError(err: unknown): boolean {
  if (isClientAbortError(err) || isAccountSuspendedError(err) || isKeyAuthError(err)) return false;
  return isModelNotFoundError(err) || isModelAccessForbiddenError(err);
}

export function redactedError(err: unknown): string {
  const message = (err as { message?: unknown })?.message ?? err;
  return summarizeAttemptError(typeof message === 'string' ? message : String(message));
}

// ── Table ──

/**
 * Create the table on first use for this handle. When the table is new, give
 * each discovered model that exists a row: a model that is on is probed while
 * it stays on, and a model that is off is an operator choice and is left alone.
 */
export function checkState(db: Db): HandleState {
  const existing = handles.get(db);
  if (existing) return existing;
  const isNew = !db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'discovered_model_checks'").get();
  db.exec(`
    CREATE TABLE IF NOT EXISTS discovered_model_checks (
      model_db_id INTEGER PRIMARY KEY REFERENCES models(id) ON DELETE CASCADE,
      state TEXT NOT NULL,
      held_off INTEGER NOT NULL,
      probe_failures INTEGER NOT NULL,
      tools_checked INTEGER NOT NULL,
      tools_value INTEGER NOT NULL,
      failure_times TEXT NOT NULL,
      last_error TEXT,
      updated_at INTEGER NOT NULL
    )
  `);
  if (isNew) backfill(db);
  const state: HandleState = { withFailures: new Set(), reasons: new Map(), probing: new Set(), lastTrace: new Map() };
  handles.set(db, state);
  for (const row of db.prepare("SELECT model_db_id FROM discovered_model_checks WHERE failure_times != '[]'").all() as { model_db_id: number }[]) {
    state.withFailures.add(row.model_db_id);
  }
  rebuildReasons(db, state);
  return state;
}

function backfill(db: Db): void {
  db.prepare(`
    INSERT INTO discovered_model_checks
      (model_db_id, state, held_off, probe_failures, tools_checked, tools_value, failure_times, last_error, updated_at)
    SELECT id, CASE WHEN enabled = 1 THEN 'pending' ELSE 'operator' END, 0, 0, 0, supports_tools, '[]', NULL, ?
      FROM models
     WHERE source = ? AND id NOT IN (SELECT model_db_id FROM discovered_model_checks)
  `).run(Date.now(), DISCOVERED_SOURCE);
}

/**
 * The check row for a model that discovery just inserted. It replaces the row
 * that the backfill gives the model when this call creates the table. A new model from an
 * automatic pass waits off for its probe. A model added with the checks off
 * is on, and gets probed while on if the checks come back.
 */
export function addCheckRow(db: Db, modelDbId: number, kind: 'held' | 'on' | 'operator', supportsTools: number): void {
  checkState(db);
  const state: CheckState = kind === 'operator' ? 'operator' : 'pending';
  db.prepare(`
    INSERT INTO discovered_model_checks
      (model_db_id, state, held_off, probe_failures, tools_checked, tools_value, failure_times, last_error, updated_at)
    VALUES (?, ?, ?, 0, 0, ?, '[]', NULL, ?)
    ON CONFLICT(model_db_id) DO UPDATE SET
      state = excluded.state, held_off = excluded.held_off, tools_value = excluded.tools_value, updated_at = excluded.updated_at
  `).run(modelDbId, state, kind === 'held' ? 1 : 0, supportsTools, Date.now());
}

export function getCheckedModel(db: Db, modelDbId: number): CheckedModel | undefined {
  return db.prepare(`
    SELECT c.*, m.platform, m.model_id, m.source, m.enabled, m.supports_tools, m.rpm_limit, m.rpd_limit
      FROM discovered_model_checks c JOIN models m ON m.id = c.model_db_id
     WHERE c.model_db_id = ?
  `).get(modelDbId) as CheckedModel | undefined;
}

/** Rows that need a probe on this platform: no chat verdict yet, or a tool check still to do. Oldest first. */
export function rowsToProbe(db: Db, platform: string, limit: number): CheckedModel[] {
  return db.prepare(`
    SELECT c.*, m.platform, m.model_id, m.source, m.enabled, m.supports_tools, m.rpm_limit, m.rpd_limit
      FROM discovered_model_checks c JOIN models m ON m.id = c.model_db_id
     WHERE m.platform = ? AND m.source = ? AND m.endpoint_scope = ''
       AND (c.state = 'pending' OR (c.state = 'ok' AND c.tools_checked = 0))
     ORDER BY m.id
     LIMIT ?
  `).all(platform, DISCOVERED_SOURCE, limit) as CheckedModel[];
}

// ── Operator changes ──

/**
 * Notice what another writer (the dashboard, the declarative config) changed
 * since the checks last wrote. A model that the checks held off and that is
 * now on was turned on by the operator, so the checks leave it alone from now
 * on. A tool flag that differs from the value the checks last wrote was set by
 * the operator, so the tool check stops. Returns the row after the change.
 */
export function reconcileOperator(db: Db, row: CheckedModel): CheckedModel {
  let next = row;
  if (row.held_off === 1 && row.enabled === 1 && row.state !== 'operator') {
    db.prepare("UPDATE discovered_model_checks SET state = 'operator', held_off = 0, failure_times = '[]', updated_at = ? WHERE model_db_id = ?")
      .run(Date.now(), row.model_db_id);
    next = { ...next, state: 'operator', held_off: 0, failure_times: '[]' };
    const state = checkState(db);
    state.withFailures.delete(row.model_db_id);
    rebuildReasons(db, state);
  }
  if (next.tools_checked === 0 && next.supports_tools !== next.tools_value) {
    db.prepare('UPDATE discovered_model_checks SET tools_checked = 1, tools_value = ?, updated_at = ? WHERE model_db_id = ?')
      .run(next.supports_tools, Date.now(), row.model_db_id);
    next = { ...next, tools_checked: 1, tools_value: next.supports_tools };
  }
  return next;
}

// ── Verdicts ──
// Each verdict writes `models` and the check row in one transaction, so a
// write by the checks never looks like an operator change.

function logVerdict(row: { platform: string; model_id: string }, verdict: string, lastError: string | null): void {
  providerLog(
    'warn',
    `[discovered-model-checks] ${row.platform}/${row.model_id}: ${verdict}${lastError ? ` (last error: ${lastError})` : ''}`,
    { provider: row.platform, model: row.model_id, event: `discovered_model_${verdict}` },
  );
}

/** The chat probe passed: the model is on and `ok`. */
export function markProbePassed(db: Db, row: CheckedModel): void {
  db.transaction(() => {
    if (row.held_off === 1) db.prepare('UPDATE models SET enabled = 1 WHERE id = ?').run(row.model_db_id);
    db.prepare("UPDATE discovered_model_checks SET state = 'ok', held_off = 0, last_error = NULL, updated_at = ? WHERE model_db_id = ?")
      .run(Date.now(), row.model_db_id);
  })();
  console.log(`[discovered-model-checks] ${row.platform}/${row.model_id}: probe passed`);
}

/** One more failed probe. At the limit the model goes off with `probe_failed`. */
export function markProbeFailed(db: Db, row: CheckedModel, err: unknown): CheckState {
  const lastError = redactedError(err);
  const failures = row.probe_failures + 1;
  const final = failures >= PROBE_FAILURE_LIMIT;
  db.transaction(() => {
    if (final) {
      db.prepare('UPDATE models SET enabled = 0 WHERE id = ?').run(row.model_db_id);
      db.prepare(`UPDATE discovered_model_checks SET state = 'probe_failed', held_off = 1, probe_failures = ?, last_error = ?, updated_at = ?
                  WHERE model_db_id = ?`).run(failures, lastError, Date.now(), row.model_db_id);
    } else {
      db.prepare('UPDATE discovered_model_checks SET probe_failures = ?, last_error = ?, updated_at = ? WHERE model_db_id = ?')
        .run(failures, lastError, Date.now(), row.model_db_id);
    }
  })();
  if (final) {
    rebuildReasons(db, checkState(db));
    logVerdict(row, 'probe_failed', lastError);
  }
  return final ? 'probe_failed' : row.state;
}

/** A probe that gave no verdict: keep the error for the log, change nothing else. */
export function markInconclusive(db: Db, row: CheckedModel, err: unknown): void {
  db.prepare('UPDATE discovered_model_checks SET last_error = ?, updated_at = ? WHERE model_db_id = ?')
    .run(redactedError(err), Date.now(), row.model_db_id);
}

/** The tool check gave a verdict. */
export function markToolsChecked(db: Db, row: CheckedModel, supportsTools: boolean): void {
  const value = supportsTools ? 1 : 0;
  db.transaction(() => {
    db.prepare('UPDATE models SET supports_tools = ? WHERE id = ?').run(value, row.model_db_id);
    db.prepare('UPDATE discovered_model_checks SET tools_checked = 1, tools_value = ?, updated_at = ? WHERE model_db_id = ?')
      .run(value, Date.now(), row.model_db_id);
  })();
  console.log(`[discovered-model-checks] ${row.platform}/${row.model_id}: tool check ${supportsTools ? 'passed' : 'failed'}`);
}

/** Save the counted request failures. At the limit the model goes off with `auto_disabled`. */
export function saveFailureTimes(db: Db, row: CheckedModel, times: number[], disable: boolean, err: unknown): void {
  const state = checkState(db);
  const lastError = redactedError(err);
  db.transaction(() => {
    if (disable) {
      db.prepare('UPDATE models SET enabled = 0 WHERE id = ?').run(row.model_db_id);
      db.prepare(`UPDATE discovered_model_checks SET state = 'auto_disabled', held_off = 1, failure_times = '[]', last_error = ?, updated_at = ?
                  WHERE model_db_id = ?`).run(lastError, Date.now(), row.model_db_id);
    } else {
      db.prepare('UPDATE discovered_model_checks SET failure_times = ?, last_error = ?, updated_at = ? WHERE model_db_id = ?')
        .run(JSON.stringify(times), lastError, Date.now(), row.model_db_id);
    }
  })();
  if (disable || times.length === 0) state.withFailures.delete(row.model_db_id);
  else state.withFailures.add(row.model_db_id);
  if (disable) {
    state.lastTrace.delete(row.model_db_id);
    rebuildReasons(db, state);
    logVerdict(row, 'auto_disabled', lastError);
  }
}

/** A served request: forget the counted failures. */
export function clearFailureTimes(db: Db, modelDbId: number): void {
  const state = checkState(db);
  db.prepare("UPDATE discovered_model_checks SET failure_times = '[]', updated_at = ? WHERE model_db_id = ?").run(Date.now(), modelDbId);
  state.withFailures.delete(modelDbId);
  state.lastTrace.delete(modelDbId);
}

// ── Cleanup and startup ──

export interface CatalogEntry {
  platform: string;
  modelId: string;
  enabled?: boolean;
  modality?: string;
}

function appliedCatalogModels(db: Db): CatalogEntry[] {
  const row = db.prepare("SELECT value FROM settings WHERE key = 'catalog_applied_json'").get() as { value: string } | undefined;
  if (!row) return [];
  try {
    return (JSON.parse(row.value) as { models?: CatalogEntry[] }).models ?? [];
  } catch {
    return [];
  }
}

function catalogEntryEnabled(models: CatalogEntry[], platform: string, modelId: string): boolean {
  const entry = models.find(m => m.platform === platform && m.modelId === modelId && (!m.modality || m.modality === 'text'));
  return entry?.enabled !== false;
}

/**
 * Drop check rows for models that are gone (the migrate CLI turns foreign keys
 * off, so the cascade can't be trusted) and for models that catalog sync took
 * over. An adopted model that still waited off for its first probe turns on,
 * because the catalog lists it. A model with a verdict stays off, like any
 * local disable.
 */
export function cleanupChecks(db: Db, catalogModels?: CatalogEntry[]): void {
  const state = checkState(db);
  const adopted = db.prepare(`
    SELECT c.model_db_id, c.state, c.held_off, m.platform, m.model_id
      FROM discovered_model_checks c JOIN models m ON m.id = c.model_db_id
     WHERE m.source != ?
  `).all(DISCOVERED_SOURCE) as Array<{ model_db_id: number; state: CheckState; held_off: number; platform: string; model_id: string }>;
  const catalog = adopted.length > 0 ? catalogModels ?? appliedCatalogModels(db) : [];
  db.transaction(() => {
    db.prepare('DELETE FROM discovered_model_checks WHERE model_db_id NOT IN (SELECT id FROM models)').run();
    for (const row of adopted) {
      if (row.state === 'pending' && row.held_off === 1 && catalogEntryEnabled(catalog, row.platform, row.model_id)) {
        db.prepare('UPDATE models SET enabled = 1 WHERE id = ?').run(row.model_db_id);
      }
      db.prepare('DELETE FROM discovered_model_checks WHERE model_db_id = ?').run(row.model_db_id);
    }
  })();
  const live = new Set((db.prepare('SELECT model_db_id FROM discovered_model_checks').all() as { model_db_id: number }[]).map(r => r.model_db_id));
  for (const id of [...state.withFailures]) if (!live.has(id)) state.withFailures.delete(id);
  for (const id of [...state.lastTrace.keys()]) if (!live.has(id)) state.lastTrace.delete(id);
  rebuildReasons(db, state);
}

/**
 * Turn on the models that wait off for a probe that will never come: the
 * checks are off, or no automatic pass runs. They stay `pending` and on, so
 * they get probed while on if the checks and the passes come back. With the
 * checks off they are also marked tool-capable, as discovery did before the
 * checks.
 */
export function releaseHeldPending(db: Db, options: { markTools: boolean }): number {
  checkState(db);
  const held = db.prepare("SELECT model_db_id, tools_checked FROM discovered_model_checks WHERE state = 'pending' AND held_off = 1")
    .all() as { model_db_id: number; tools_checked: number }[];
  db.transaction(() => {
    for (const row of held) {
      db.prepare('UPDATE models SET enabled = 1 WHERE id = ?').run(row.model_db_id);
      if (options.markTools && row.tools_checked === 0) {
        db.prepare('UPDATE models SET supports_tools = 1 WHERE id = ?').run(row.model_db_id);
        db.prepare('UPDATE discovered_model_checks SET tools_value = 1 WHERE model_db_id = ?').run(row.model_db_id);
      }
      db.prepare('UPDATE discovered_model_checks SET held_off = 0, updated_at = ? WHERE model_db_id = ?').run(Date.now(), row.model_db_id);
    }
  })();
  return held.length;
}

/** Startup: create the table, clean up, and release held models that no probe will reach. */
export function startDiscoveredModelChecks(db: Db, discoveryAuto: boolean): void {
  try {
    checkState(db);
    cleanupChecks(db);
    const checksOn = discoveredChecksOn();
    if (!checksOn || !discoveryAuto) {
      const released = releaseHeldPending(db, { markTools: !checksOn });
      if (released > 0) console.log(`[discovered-model-checks] turned on ${released} model(s) that waited for a probe`);
    }
  } catch (err: unknown) {
    console.error(`[discovered-model-checks] startup failed: ${(err as Error)?.message ?? err}`);
  }
}

/** Hook for catalog sync: settle the check rows of the models it just adopted. Returns `result`. */
export function afterCatalogApply<T>(db: Db, catalog: { models: CatalogEntry[] }, result: T): T {
  try {
    cleanupChecks(db, catalog.models);
  } catch (err: unknown) {
    console.error(`[discovered-model-checks] cleanup after catalog sync failed: ${(err as Error)?.message ?? err}`);
  }
  return result;
}

// ── Probe lock ──

/** Claim the probe step for a platform. False when another step already runs it. */
export function claimProbe(db: Db, platform: string): boolean {
  const state = checkState(db);
  if (state.probing.has(platform)) return false;
  state.probing.add(platform);
  return true;
}

export function releaseProbe(db: Db, platform: string): void {
  checkState(db).probing.delete(platform);
}

// ── Reasons for /v1/models ──

/**
 * Rebuild the listed id → reason map. An entry gets a reason only when every
 * model row behind it is off for a check verdict, so a row that the operator
 * turned off makes the entry plain `disabled`.
 */
function rebuildReasons(db: Db, state: HandleState): void {
  state.reasons.clear();
  const verdicts = new Map<number, DisableReason>();
  for (const row of db.prepare(`
    SELECT c.model_db_id, c.state FROM discovered_model_checks c JOIN models m ON m.id = c.model_db_id
     WHERE c.held_off = 1 AND m.enabled = 0 AND c.state IN ('probe_failed', 'auto_disabled')
  `).all() as { model_db_id: number; state: DisableReason }[]) {
    verdicts.set(row.model_db_id, row.state);
  }
  if (verdicts.size === 0) return;

  const groups = new Map<string, number[]>();
  if (isUnifyEnabled()) {
    for (const group of getModelGroups()) groups.set(group.canonicalId, group.members.map(m => m.model_db_id));
  } else {
    for (const row of db.prepare('SELECT id, model_id FROM models').all() as { id: number; model_id: string }[]) {
      const ids = groups.get(row.model_id) ?? [];
      ids.push(row.id);
      groups.set(row.model_id, ids);
    }
  }
  for (const [listedId, ids] of groups) {
    if (ids.length === 0 || !ids.every(id => verdicts.has(id))) continue;
    state.reasons.set(listedId, ids.some(id => verdicts.get(id) === 'auto_disabled') ? 'auto_disabled' : 'probe_failed');
  }
}

/** The reason that /v1/models shows for a disabled entry that the checks turned off. */
export function discoveredDisableReason(listedId: string, db: Db = getDb()): DisableReason | undefined {
  return handles.get(db)?.reasons.get(listedId);
}

/** Test seam for the failure rule's trace map. */
export function lastCountedTrace(db: Db): Map<number, unknown> {
  return checkState(db).lastTrace;
}
