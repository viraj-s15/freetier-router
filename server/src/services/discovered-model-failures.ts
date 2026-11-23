import { getDb } from '../db/index.js';
import {
  checkState,
  clearFailureTimes,
  discoveredChecksOn,
  getCheckedModel,
  isPermanentModelError,
  reconcileOperator,
  saveFailureTimes,
} from './discovered-model-checks.js';

// ── The failure rule for discovered models (freetier-router) ──
//
// Upstream benches a failing model for 10 minutes and retires a catalog model
// only on a clear end-of-life answer, so a discovered model that always answers
// 403 or 404 comes back every 10 minutes. This turns such a model off after 3
// separate requests get a permanent model error from it within 24 hours. The
// two hooks sit in lib/fallback-loop.ts, next to the retirement signal and the
// failure-window reset.

/** Separate requests with a permanent model error that turn a model off. */
export const FAILURE_LIMIT = 3;
export const FAILURE_WINDOW_MS = 24 * 60 * 60 * 1000;

interface FailureRoute {
  modelDbId: number;
}

/**
 * Count one failed attempt against a discovered model. One request that fails
 * over across keys counts once, because the request trace identifies it.
 * Never throws: it runs on the proxy's failure path.
 */
export function noteDiscoveredModelFailure(route: FailureRoute, err: unknown, requestTrace?: unknown, now = Date.now()): void {
  if (!discoveredChecksOn() || !isPermanentModelError(err)) return;
  try {
    const db = getDb();
    const state = checkState(db);
    const found = getCheckedModel(db, route.modelDbId);
    if (!found || found.source !== 'discovered') return;
    const row = reconcileOperator(db, found);
    if (row.enabled !== 1 || (row.state !== 'pending' && row.state !== 'ok')) return;
    // A failure with no trace counts as its own request.
    if (requestTrace !== undefined && state.lastTrace.get(row.model_db_id) === requestTrace) return;
    state.lastTrace.set(row.model_db_id, requestTrace);
    const times = parseTimes(row.failure_times).filter(t => now - t < FAILURE_WINDOW_MS);
    times.push(now);
    saveFailureTimes(db, row, times, times.length >= FAILURE_LIMIT, err);
  } catch (dbErr: unknown) {
    console.warn(`[discovered-model-checks] could not count a failure for model ${route.modelDbId}: ${(dbErr as Error)?.message ?? dbErr}`);
  }
}

/** A served request clears the count. One set lookup unless the model has counted failures. */
export function noteDiscoveredModelSuccess(route: FailureRoute): void {
  try {
    const db = getDb();
    if (!checkState(db).withFailures.has(route.modelDbId)) return;
    clearFailureTimes(db, route.modelDbId);
  } catch (dbErr: unknown) {
    console.warn(`[discovered-model-checks] could not clear failures for model ${route.modelDbId}: ${(dbErr as Error)?.message ?? dbErr}`);
  }
}

function parseTimes(raw: string): number[] {
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((t): t is number => typeof t === 'number') : [];
  } catch {
    return [];
  }
}
