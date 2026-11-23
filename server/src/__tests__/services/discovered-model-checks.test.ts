import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Express } from 'express';
import { createApp } from '../../app.js';
import { getDb, getUnifiedApiKey, initDb } from '../../db/index.js';
import { encrypt } from '../../lib/crypto.js';
import { mintDashboardToken } from '../helpers/auth.js';
import { registerDiscoveredModels } from '../../services/builtin-model-discovery.js';
import { applyCatalog } from '../../services/catalog-sync.js';
import {
  checkState,
  cleanupChecks,
  discoveredChecksMode,
  getCheckedModel,
  isPermanentModelError,
  markProbeFailed,
  markProbePassed,
  reconcileOperator,
  saveFailureTimes,
  startDiscoveredModelChecks,
} from '../../services/discovered-model-checks.js';

// Health checks for discovered models (freetier-router): the check table, the
// setting, the error predicate, operator changes, the backfill, the cleanup
// and the reason that /v1/models shows.

type AnyCatalog = Parameters<typeof applyCatalog>[1];

const ENV = ['DISCOVERED_MODEL_CHECKS', 'BUILTIN_MODEL_DISCOVERY'] as const;
const original = Object.fromEntries(ENV.map(name => [name, process.env[name]]));

function insertModel(platform: string, modelId: string, options: { enabled?: number; tools?: number; source?: string } = {}): number {
  const info = getDb().prepare(`
    INSERT INTO models (platform, model_id, display_name, intelligence_rank, speed_rank, size_label, enabled, supports_tools, source)
    VALUES (?, ?, ?, 50, 50, 'Medium', ?, ?, ?)
  `).run(platform, modelId, modelId, options.enabled ?? 1, options.tools ?? 1, options.source ?? 'discovered');
  return Number(info.lastInsertRowid);
}

function modelRow(id: number) {
  return getDb().prepare('SELECT enabled, supports_tools, source FROM models WHERE id = ?').get(id) as
    { enabled: number; supports_tools: number; source: string } | undefined;
}

function checkRow(id: number) {
  return getDb().prepare('SELECT * FROM discovered_model_checks WHERE model_db_id = ?').get(id) as
    { state: string; held_off: number; tools_checked: number; tools_value: number; probe_failures: number } | undefined;
}

function registerOne(platform: string, modelId: string, explicit = false): number {
  registerDiscoveredModels(getDb(), platform, [{ modelId }], { explicit });
  return (getDb().prepare('SELECT id FROM models WHERE platform = ? AND model_id = ?').get(platform, modelId) as { id: number }).id;
}

function catalogModel(platform: string, modelId: string, enabled = true): AnyCatalog['models'][number] {
  return {
    platform, modelId, displayName: modelId, intelligenceRank: 10, speedRank: 5, sizeLabel: 'Large',
    limits: { rpm: 30, rpd: 1000, tpm: null, tpd: null }, monthlyTokenBudget: '~1M', contextWindow: 131072,
    enabled, supportsVision: false, supportsTools: true,
  };
}

function catalogWith(extra: AnyCatalog['models']): AnyCatalog {
  const baseline = (getDb().prepare("SELECT platform, model_id FROM models WHERE source = 'catalog'").all() as Array<{ platform: string; model_id: string }>)
    .map(r => catalogModel(r.platform, r.model_id));
  return { version: '2099.01.01', generatedAt: new Date().toISOString(), tier: 'monthly', models: [...baseline, ...extra], quirks: [] };
}

async function call(app: Express, method: string, urlPath: string, auth: string, body?: unknown) {
  const server = app.listen(0, '127.0.0.1');
  if (!server.listening) await new Promise<void>(resolve => server.once('listening', () => resolve()));
  const { port } = server.address() as { port: number };
  const res = await fetch(`http://127.0.0.1:${port}${urlPath}`, {
    method,
    headers: { Authorization: `Bearer ${auth}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => null);
  server.close();
  return { status: res.status, body: data as any };
}

const http403 = () => Object.assign(new Error('API error 403: model is not available on the free tier'), { status: 403 });

describe('discovered-model checks', () => {
  beforeEach(() => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    for (const name of ENV) delete process.env[name];
    initDb(':memory:');
  });

  afterEach(() => {
    vi.restoreAllMocks();
    for (const name of ENV) {
      if (original[name] === undefined) delete process.env[name];
      else process.env[name] = original[name];
    }
  });

  describe('table', () => {
    it('creates the table on a fresh database, and a second setup call does not fail', () => {
      checkState(getDb());
      expect(getDb().prepare("SELECT name FROM sqlite_master WHERE name = 'discovered_model_checks'").get()).toBeTruthy();
      expect(() => checkState(getDb())).not.toThrow();
    });
  });

  describe('setting', () => {
    it('is on by default and when set to on', () => {
      expect(discoveredChecksMode()).toBe('on');
      process.env.DISCOVERED_MODEL_CHECKS = 'on';
      expect(discoveredChecksMode()).toBe('on');
    });

    it('is off when set to off', () => {
      process.env.DISCOVERED_MODEL_CHECKS = 'OFF';
      expect(discoveredChecksMode()).toBe('off');
    });

    it('treats an unknown value as on and logs a warning that names it', () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      process.env.DISCOVERED_MODEL_CHECKS = 'maybe-later';
      expect(discoveredChecksMode()).toBe('on');
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('maybe-later'));
    });
  });

  describe('isPermanentModelError', () => {
    it.each([
      ['404', Object.assign(new Error('API error 404: model not found'), { status: 404 })],
      ['410', Object.assign(new Error('API error 410: gone'), { status: 410 })],
      ['403', http403()],
      ['a model-level 400', Object.assign(new Error('API error 400: No model found: x'), { status: 400 })],
    ])('counts %s', (_name, err) => {
      expect(isPermanentModelError(err)).toBe(true);
    });

    it.each([
      ['429', Object.assign(new Error('API error 429: rate limited'), { status: 429 })],
      ['503', Object.assign(new Error('API error 503: overloaded'), { status: 503 })],
      ['a timeout', new Error('Request timed out after 30000ms')],
      ['a client cancel', Object.assign(new Error('client disconnected'), { clientAbort: true })],
      ['an account suspension', Object.assign(new Error('API error 403: your account has been suspended'), { status: 403 })],
      ['a bare 401', Object.assign(new Error('API error 401: Unauthorized'), { status: 401 })],
    ])('does not count %s', (_name, err) => {
      expect(isPermanentModelError(err)).toBe(false);
    });
  });

  describe('backfill', () => {
    it('gives an existing model that is on a pending row, and one that is off an operator row', () => {
      const on = insertModel('groq', 'old-on');
      const off = insertModel('groq', 'old-off', { enabled: 0 });
      const catalog = insertModel('groq', 'from-catalog', { source: 'catalog' });
      checkState(getDb());
      expect(checkRow(on)).toMatchObject({ state: 'pending', held_off: 0, tools_value: 1 });
      expect(modelRow(on)?.enabled).toBe(1);
      expect(checkRow(off)).toMatchObject({ state: 'operator' });
      expect(modelRow(off)?.enabled).toBe(0);
      expect(checkRow(catalog)).toBeUndefined();
    });

    it('runs only when the table first appears, so a second start adds no rows', () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dmc-'));
      const file = path.join(dir, 'test.db');
      try {
        initDb(file);
        const first = insertModel('groq', 'old-on');
        checkState(getDb());
        getDb().close();

        initDb(file);
        const later = insertModel('groq', 'added-later');
        checkState(getDb());
        const count = (getDb().prepare('SELECT COUNT(*) AS n FROM discovered_model_checks').get() as { n: number }).n;
        expect(count).toBe(1);
        expect(checkRow(first)?.state).toBe('pending');
        expect(checkRow(later)).toBeUndefined();
        getDb().close();
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    });
  });

  describe('registration', () => {
    it('adds a model from an automatic pass off and not tool-capable, waiting for its probe', () => {
      const id = registerOne('groq', 'new-model');
      expect(modelRow(id)).toMatchObject({ enabled: 0, supports_tools: 0 });
      expect(checkRow(id)).toMatchObject({ state: 'pending', held_off: 1, tools_value: 0 });
    });

    it('adds a dashboard pick on and tool-capable, as an operator choice', () => {
      const id = registerOne('groq', 'picked', true);
      expect(modelRow(id)).toMatchObject({ enabled: 1, supports_tools: 1 });
      expect(checkRow(id)).toMatchObject({ state: 'operator', held_off: 0 });
    });

    it('adds a model on and tool-capable when the checks are off', () => {
      process.env.DISCOVERED_MODEL_CHECKS = 'off';
      const id = registerOne('groq', 'unchecked');
      expect(modelRow(id)).toMatchObject({ enabled: 1, supports_tools: 1 });
      expect(checkRow(id)).toMatchObject({ state: 'pending', held_off: 0, tools_value: 1 });
    });
  });

  describe('operator changes', () => {
    it('marks a held model that the operator turns on as operator', async () => {
      const id = registerOne('groq', 'held');
      const app = createApp();
      const res = await call(app, 'PATCH', `/api/models/${id}`, mintDashboardToken(), { enabled: true });
      expect(res.status).toBe(200);
      const row = reconcileOperator(getDb(), getCheckedModel(getDb(), id)!);
      expect(row.state).toBe('operator');
      expect(checkRow(id)).toMatchObject({ state: 'operator', held_off: 0 });
    });

    it('does not read its own probe pass as an operator change', () => {
      const id = registerOne('groq', 'held');
      markProbePassed(getDb(), getCheckedModel(getDb(), id)!);
      const row = reconcileOperator(getDb(), getCheckedModel(getDb(), id)!);
      expect(row.state).toBe('ok');
      expect(modelRow(id)?.enabled).toBe(1);
    });

    it('stops the tool check when the operator sets the tool flag', async () => {
      const id = registerOne('groq', 'held');
      const app = createApp();
      await call(app, 'PATCH', `/api/models/${id}`, mintDashboardToken(), { supportsTools: true });
      const row = reconcileOperator(getDb(), getCheckedModel(getDb(), id)!);
      expect(row).toMatchObject({ tools_checked: 1, tools_value: 1 });
      expect(modelRow(id)?.supports_tools).toBe(1);
    });
  });

  describe('cleanup', () => {
    it('turns on a pending model that catalog sync adopts, and drops its check row', () => {
      const id = registerOne('groq', 'adopted');
      applyCatalog(getDb(), catalogWith([catalogModel('groq', 'adopted')]));
      expect(modelRow(id)).toMatchObject({ source: 'catalog', enabled: 1 });
      expect(checkRow(id)).toBeUndefined();
    });

    it('keeps a pending model off when the catalog lists it as off', () => {
      const id = registerOne('groq', 'adopted-off');
      applyCatalog(getDb(), catalogWith([catalogModel('groq', 'adopted-off', false)]));
      expect(modelRow(id)).toMatchObject({ source: 'catalog', enabled: 0 });
    });

    it('keeps a model with a verdict off when catalog sync adopts it', () => {
      const id = registerOne('groq', 'failed');
      for (let i = 0; i < 3; i++) markProbeFailed(getDb(), getCheckedModel(getDb(), id)!, http403());
      expect(checkRow(id)?.state).toBe('probe_failed');
      applyCatalog(getDb(), catalogWith([catalogModel('groq', 'failed')]));
      expect(modelRow(id)).toMatchObject({ source: 'catalog', enabled: 0 });
      expect(checkRow(id)).toBeUndefined();
    });

    it('drops the check row of a deleted model even with foreign keys off', () => {
      const id = registerOne('groq', 'deleted');
      getDb().pragma('foreign_keys = OFF');
      getDb().prepare('DELETE FROM models WHERE id = ?').run(id);
      getDb().pragma('foreign_keys = ON');
      expect(checkRow(id)).toBeDefined();
      cleanupChecks(getDb());
      expect(checkRow(id)).toBeUndefined();
    });
  });

  describe('startup', () => {
    function failedThreeTimes(modelId: string): number {
      const id = registerOne('groq', modelId);
      for (let i = 0; i < 3; i++) markProbeFailed(getDb(), getCheckedModel(getDb(), id)!, http403());
      return id;
    }

    it('turns on pending models when the checks are off, and keeps verdicts off', () => {
      const pending = registerOne('groq', 'pending');
      const failed = failedThreeTimes('failed');
      process.env.DISCOVERED_MODEL_CHECKS = 'off';
      startDiscoveredModelChecks(getDb(), true);
      expect(modelRow(pending)).toMatchObject({ enabled: 1, supports_tools: 1 });
      expect(checkRow(pending)).toMatchObject({ state: 'pending', held_off: 0 });
      expect(modelRow(failed)?.enabled).toBe(0);
    });

    it('turns on pending models when no automatic pass runs', () => {
      const pending = registerOne('groq', 'pending');
      process.env.BUILTIN_MODEL_DISCOVERY = 'manual';
      startDiscoveredModelChecks(getDb(), false);
      expect(modelRow(pending)).toMatchObject({ enabled: 1, supports_tools: 0 });
    });

    it('keeps pending models off when the checks run, also for an unknown setting', () => {
      vi.spyOn(console, 'warn').mockImplementation(() => {});
      const pending = registerOne('groq', 'pending');
      process.env.DISCOVERED_MODEL_CHECKS = 'sometimes';
      startDiscoveredModelChecks(getDb(), true);
      expect(modelRow(pending)?.enabled).toBe(0);
    });
  });

  describe('reason in /v1/models', () => {
    function addKey(platform: string): void {
      const { encrypted, iv, authTag } = encrypt('sk-test');
      getDb().prepare(`INSERT INTO api_keys (platform, label, encrypted_key, iv, auth_tag, status, enabled)
                       VALUES (?, '', ?, ?, ?, 'healthy', 1)`).run(platform, encrypted, iv, authTag);
    }

    async function listed(): Promise<Map<string, string | null>> {
      const res = await call(createApp(), 'GET', '/v1/models', getUnifiedApiKey());
      expect(res.status).toBe(200);
      return new Map((res.body.data as Array<{ id: string; unavailable_reason: string | null }>).map(m => [m.id, m.unavailable_reason]));
    }

    it('shows probe_failed and auto_disabled, and disabled for other models that are off', async () => {
      addKey('groq');
      const failed = registerOne('groq', 'zz-probe-failed-model');
      for (let i = 0; i < 3; i++) markProbeFailed(getDb(), getCheckedModel(getDb(), failed)!, http403());
      const disabled = registerOne('groq', 'zz-auto-disabled-model');
      markProbePassed(getDb(), getCheckedModel(getDb(), disabled)!);
      saveFailureTimes(getDb(), getCheckedModel(getDb(), disabled)!, [1, 2, 3], true, http403());
      insertModel('groq', 'zz-operator-off-model', { enabled: 0, source: 'user' });

      const reasons = await listed();
      expect(reasons.get('zz-probe-failed-model')).toBe('probe_failed');
      expect(reasons.get('zz-auto-disabled-model')).toBe('auto_disabled');
      expect(reasons.get('zz-operator-off-model')).toBe('disabled');
    });

    it('shows disabled for a merged entry where one row is off for another reason', async () => {
      addKey('groq');
      addKey('openrouter');
      const failed = registerOne('groq', 'zz-shared-model');
      insertModel('openrouter', 'zz-shared-model', { enabled: 0, source: 'user' });
      for (let i = 0; i < 3; i++) markProbeFailed(getDb(), getCheckedModel(getDb(), failed)!, http403());

      const reasons = await listed();
      const entry = [...reasons.entries()].find(([id]) => id.includes('zz-shared-model'));
      expect(entry?.[1]).toBe('disabled');
    });

    it('logs each verdict with the model, the verdict and the redacted last error', () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const id = registerOne('groq', 'logged');
      const leak = Object.assign(new Error('API error 403: forbidden for key sk-abcdefghijklmnopqrstuvwxyz123456'), { status: 403 });
      for (let i = 0; i < 3; i++) markProbeFailed(getDb(), getCheckedModel(getDb(), id)!, leak);
      const line = warn.mock.calls.map(c => String(c[0])).find(l => l.includes('groq/logged'));
      expect(line).toContain('probe_failed');
      expect(line).toContain('403');
      expect(line).not.toContain('sk-abcdefghijklmnopqrstuvwxyz123456');
    });
  });
});
