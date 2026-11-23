import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.mock('../../services/health.js', () => ({
  checkKeyHealth: vi.fn(),
  markKeyHealthyFromRequest: vi.fn(),
}));

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { getDb, initDb } from '../../db/index.js';
import { newRequestTrace, runWithRequestTrace } from '../../lib/attempt-trace.js';
import { newFallbackState, recordRetryableFailure, recordUpstreamSuccess, resetModelFailureWindows } from '../../lib/fallback-loop.js';
import { applyCatalog } from '../../services/catalog-sync.js';
import { checkState, getCheckedModel, markProbePassed } from '../../services/discovered-model-checks.js';
import { FAILURE_WINDOW_MS, noteDiscoveredModelFailure, noteDiscoveredModelSuccess } from '../../services/discovered-model-failures.js';
import type { RouteResult } from '../../services/router.js';

// The failure rule for discovered models (freetier-router): 3 separate
// requests with a permanent model error within 24 hours turn a discovered
// model off with `auto_disabled`.

type AnyCatalog = Parameters<typeof applyCatalog>[1];

const original = process.env.DISCOVERED_MODEL_CHECKS;
const HOUR = 60 * 60 * 1000;
const forbidden = () => Object.assign(new Error('API error 403: model is not available on the free tier'), { status: 403 });
const notFound = () => Object.assign(new Error('API error 404: model not found'), { status: 404 });

function insertModel(modelId: string, source = 'discovered', enabled = 1): number {
  const info = getDb().prepare(`
    INSERT INTO models (platform, model_id, display_name, intelligence_rank, speed_rank, size_label, enabled, supports_tools, source)
    VALUES ('groq', ?, ?, 50, 50, 'Medium', ?, 1, ?)
  `).run(modelId, modelId, enabled, source);
  return Number(info.lastInsertRowid);
}

/** A discovered model that is on and passed its probe. */
function liveModel(modelId: string): number {
  const id = insertModel(modelId);
  checkState(getDb());
  markProbePassed(getDb(), getCheckedModel(getDb(), id)!);
  return id;
}

function model(id: number) {
  return getDb().prepare(`
    SELECT m.enabled, c.state, c.failure_times FROM models m LEFT JOIN discovered_model_checks c ON c.model_db_id = m.id WHERE m.id = ?
  `).get(id) as { enabled: number; state: string | null; failure_times: string | null };
}

const count = (id: number) => JSON.parse(model(id).failure_times ?? '[]').length as number;

/** One request: a fresh trace, as the fallback loop makes for each request. */
function request(id: number, err: unknown, now?: number): void {
  noteDiscoveredModelFailure({ modelDbId: id }, err, newRequestTrace(), now);
}

function routeFor(id: number, modelId: string, keyId = 1): RouteResult {
  return {
    provider: {} as any, modelId, modelDbId: id, apiKey: 'k', keyId, platform: 'groq',
    displayName: modelId, rpdLimit: null, tpdLimit: null,
  };
}

describe('discovered-model failure rule', () => {
  beforeEach(() => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    delete process.env.DISCOVERED_MODEL_CHECKS;
    initDb(':memory:');
    resetModelFailureWindows();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
    if (original === undefined) delete process.env.DISCOVERED_MODEL_CHECKS;
    else process.env.DISCOVERED_MODEL_CHECKS = original;
  });

  it('turns a model off with auto_disabled after 3 separate requests in a day', () => {
    const id = liveModel('flaky');
    request(id, forbidden());
    request(id, forbidden());
    expect(model(id)).toMatchObject({ enabled: 1, state: 'ok' });
    request(id, forbidden());
    expect(model(id)).toMatchObject({ enabled: 0, state: 'auto_disabled' });
  });

  it('counts one request that fails over across keys once', () => {
    const id = liveModel('three-keys');
    const trace = newRequestTrace();
    for (let key = 0; key < 3; key++) noteDiscoveredModelFailure({ modelDbId: id }, notFound(), trace);
    expect(count(id)).toBe(1);
    expect(model(id).enabled).toBe(1);
  });

  it('keeps the model on when the first and third failures are more than 24 hours apart', () => {
    const id = liveModel('slow-burn');
    const start = Date.now() - FAILURE_WINDOW_MS - 2 * HOUR;
    request(id, forbidden(), start);
    request(id, forbidden(), start + 2 * HOUR);
    request(id, forbidden(), start + FAILURE_WINDOW_MS + HOUR);
    expect(model(id)).toMatchObject({ enabled: 1, state: 'ok' });
    expect(count(id)).toBe(2);
  });

  it('keeps the count across a server restart', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dmf-'));
    const file = path.join(dir, 'test.db');
    try {
      initDb(file);
      const id = liveModel('restarted');
      request(id, forbidden());
      request(id, forbidden());
      getDb().close();
      initDb(file);
      request(id, forbidden());
      expect(model(id)).toMatchObject({ enabled: 0, state: 'auto_disabled' });
      getDb().close();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('counts a failure with no trace as its own request', () => {
    const id = liveModel('no-trace');
    for (let i = 0; i < 3; i++) noteDiscoveredModelFailure({ modelDbId: id }, forbidden());
    expect(model(id).state).toBe('auto_disabled');
  });

  it('ignores server errors, rate limits and a bare 401', () => {
    const id = liveModel('busy');
    for (let i = 0; i < 5; i++) request(id, Object.assign(new Error('API error 503: overloaded'), { status: 503 }));
    for (let i = 0; i < 3; i++) request(id, Object.assign(new Error('API error 429: slow down'), { status: 429 }));
    for (let i = 0; i < 3; i++) request(id, Object.assign(new Error('API error 401: Unauthorized'), { status: 401 }));
    expect(model(id)).toMatchObject({ enabled: 1, state: 'ok' });
    expect(count(id)).toBe(0);
  });

  it('clears the count when the model serves a request', () => {
    const id = liveModel('recovers');
    request(id, forbidden());
    request(id, forbidden());
    noteDiscoveredModelSuccess({ modelDbId: id });
    request(id, forbidden());
    expect(model(id)).toMatchObject({ enabled: 1, state: 'ok' });
    expect(count(id)).toBe(1);
  });

  it('applies to an existing model whose probes still run', () => {
    const id = insertModel('old-model');
    checkState(getDb());
    for (let i = 0; i < 3; i++) request(id, forbidden());
    expect(model(id)).toMatchObject({ enabled: 0, state: 'auto_disabled' });
  });

  it('leaves a model alone after the operator turns it back on', () => {
    const id = liveModel('operator-choice');
    for (let i = 0; i < 3; i++) request(id, forbidden());
    getDb().prepare('UPDATE models SET enabled = 1 WHERE id = ?').run(id);
    for (let i = 0; i < 3; i++) request(id, forbidden());
    expect(model(id)).toMatchObject({ enabled: 1, state: 'operator' });
  });

  it('never turns off a catalog model', () => {
    const id = insertModel('catalog-model', 'catalog');
    for (let i = 0; i < 3; i++) request(id, forbidden());
    expect(model(id)).toMatchObject({ enabled: 1, state: null });
  });

  it('stops counting when catalog sync adopts the model', () => {
    const id = liveModel('adopted');
    request(id, forbidden());
    request(id, forbidden());
    const baseline = (getDb().prepare("SELECT platform, model_id FROM models WHERE source = 'catalog'").all() as Array<{ platform: string; model_id: string }>);
    const entry = (platform: string, modelId: string): AnyCatalog['models'][number] => ({
      platform, modelId, displayName: modelId, intelligenceRank: 10, speedRank: 5, sizeLabel: 'Large',
      limits: { rpm: 30, rpd: 1000, tpm: null, tpd: null }, monthlyTokenBudget: '~1M', contextWindow: 131072,
      enabled: true, supportsVision: false, supportsTools: true,
    });
    applyCatalog(getDb(), {
      version: '2099.01.01', generatedAt: new Date().toISOString(), tier: 'monthly', quirks: [],
      models: [...baseline.map(r => entry(r.platform, r.model_id)), entry('groq', 'adopted')],
    });
    request(id, forbidden());
    expect(model(id)).toMatchObject({ enabled: 1, state: null });
  });

  it('does nothing when the checks are off', () => {
    const id = liveModel('unchecked');
    process.env.DISCOVERED_MODEL_CHECKS = 'off';
    for (let i = 0; i < 3; i++) request(id, forbidden());
    expect(model(id)).toMatchObject({ enabled: 1, state: 'ok' });
  });

  describe('hooks in the fallback loop', () => {
    it('turns a discovered model off after 3 requests with 403, and leaves a catalog model on', () => {
      const discovered = liveModel('proxied');
      const catalog = insertModel('proxied-catalog', 'catalog');
      for (let i = 0; i < 3; i++) {
        runWithRequestTrace(newRequestTrace(), () => {
          recordRetryableFailure(routeFor(discovered, 'proxied'), forbidden(), newFallbackState());
          recordRetryableFailure(routeFor(catalog, 'proxied-catalog'), forbidden(), newFallbackState());
        });
      }
      expect(model(discovered)).toMatchObject({ enabled: 0, state: 'auto_disabled' });
      expect(model(catalog).enabled).toBe(1);
    });

    it('clears the count on a served request', () => {
      const id = liveModel('served');
      runWithRequestTrace(newRequestTrace(), () => recordRetryableFailure(routeFor(id, 'served'), forbidden(), newFallbackState()));
      expect(count(id)).toBe(1);
      recordUpstreamSuccess(routeFor(id, 'served'), 10);
      expect(count(id)).toBe(0);
    });

    it('writes nothing on a served request for a model with no counted failures', () => {
      const id = liveModel('quiet');
      const prepare = vi.spyOn(getDb(), 'prepare');
      noteDiscoveredModelSuccess({ modelDbId: id });
      expect(prepare).not.toHaveBeenCalled();
    });
  });
});
