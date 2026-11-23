import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { getDb, initDb } from '../../db/index.js';
import { encrypt } from '../../lib/crypto.js';
import type { BaseProvider } from '../../providers/base.js';
import { registerDiscoveredModels, resetBuiltinDiscoveryThrottle, runBuiltinModelDiscovery } from '../../services/builtin-model-discovery.js';
import { checkState, PROBE_FAILURE_LIMIT } from '../../services/discovered-model-checks.js';
import { chatCheck, PROBE_BUDGET, runProbeStep, toolCheck, type ProbeContext } from '../../services/discovered-model-probe.js';
import { canMakeRequest } from '../../services/ratelimit.js';

// Probes for discovered models (freetier-router): the chat check, the tool
// check, the runner that applies their outcomes, and the probe step inside a
// discovery pass.

const realFetch = globalThis.fetch;
const original = process.env.DISCOVERED_MODEL_CHECKS;

type Answer = { content?: string; finish?: string; toolCall?: boolean } | Error;

function completion(answer: Exclude<Answer, Error>) {
  return {
    id: 'x', object: 'chat.completion' as const, created: 0, model: 'm',
    choices: [{
      index: 0,
      finish_reason: answer.finish ?? (answer.toolCall ? 'tool_calls' : 'stop'),
      message: {
        role: 'assistant' as const,
        content: answer.content ?? '',
        ...(answer.toolCall ? { tool_calls: [{ id: 't', type: 'function' as const, function: { name: 'record_word', arguments: '{"word":"ping"}' } }] } : {}),
      },
    }],
    usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 },
  };
}

/** A fake adapter: `answers(call)` decides what each request gets. Tool requests are the ones with `tools`. */
function fakeProvider(answers: (opts: { tools: boolean; modelId: string }) => Answer) {
  const chatCompletion = vi.fn(async (_key: string, _messages: unknown, modelId: string, options?: { tools?: unknown[] }) => {
    const answer = answers({ tools: Boolean(options?.tools?.length), modelId });
    if (answer instanceof Error) throw answer;
    return completion(answer);
  });
  return { provider: { chatCompletion } as unknown as BaseProvider, chatCompletion };
}

const err = (status: number, message: string) => Object.assign(new Error(`API error ${status}: ${message}`), { status });
const KEY = { keyId: 0, apiKey: 'sk-test', proxyUrl: undefined };

function addKey(platform: string): number {
  const { encrypted, iv, authTag } = encrypt('sk-test');
  const info = getDb().prepare(`INSERT INTO api_keys (platform, label, encrypted_key, iv, auth_tag, status, enabled)
                                VALUES (?, '', ?, ?, ?, 'healthy', 1)`).run(platform, encrypted, iv, authTag);
  return Number(info.lastInsertRowid);
}

function register(platform: string, ids: string[]): number[] {
  registerDiscoveredModels(getDb(), platform, ids.map(modelId => ({ modelId })), { explicit: false });
  return ids.map(id => (getDb().prepare('SELECT id FROM models WHERE platform = ? AND model_id = ?').get(platform, id) as { id: number }).id);
}

function insertExisting(platform: string, modelId: string): number {
  const info = getDb().prepare(`
    INSERT INTO models (platform, model_id, display_name, intelligence_rank, speed_rank, size_label, enabled, supports_tools, source, rpm_limit, rpd_limit)
    VALUES (?, ?, ?, 50, 50, 'Medium', 1, 1, 'discovered', 10, 250)
  `).run(platform, modelId, modelId);
  return Number(info.lastInsertRowid);
}

function state(id: number) {
  return getDb().prepare(`
    SELECT c.state, c.held_off, c.probe_failures, c.tools_checked, m.enabled, m.supports_tools
      FROM discovered_model_checks c JOIN models m ON m.id = c.model_db_id WHERE c.model_db_id = ?
  `).get(id) as { state: string; held_off: number; probe_failures: number; tools_checked: number; enabled: number; supports_tools: number };
}

function ctxFor(provider: BaseProvider): ProbeContext {
  return { provider, apiKey: 'sk-test', proxyUrl: undefined, keyId: 0, platform: 'groq', modelId: 'm' };
}

describe('discovered-model probe', () => {
  beforeEach(() => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    delete process.env.DISCOVERED_MODEL_CHECKS;
    delete process.env.BUILTIN_MODEL_DISCOVERY;
    initDb(':memory:');
    resetBuiltinDiscoveryThrottle();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    globalThis.fetch = realFetch;
    vi.restoreAllMocks();
    if (original === undefined) delete process.env.DISCOVERED_MODEL_CHECKS;
    else process.env.DISCOVERED_MODEL_CHECKS = original;
  });

  describe('chatCheck', () => {
    it('passes on a text answer', async () => {
      expect((await chatCheck.run(ctxFor(fakeProvider(() => ({ content: 'pong' })).provider))).outcome).toBe('pass');
    });

    it('passes on an empty answer that stopped at the token limit', async () => {
      expect((await chatCheck.run(ctxFor(fakeProvider(() => ({ content: '', finish: 'length' })).provider))).outcome).toBe('pass');
    });

    it('fails on an empty answer that did not stop at the token limit', async () => {
      expect((await chatCheck.run(ctxFor(fakeProvider(() => ({ content: '', finish: 'stop' })).provider))).outcome).toBe('fail');
    });

    it('stays inconclusive on a 400 that rejects the key', async () => {
      expect((await chatCheck.run(ctxFor(fakeProvider(() => err(400, 'API key not valid')).provider))).outcome).toBe('inconclusive');
    });

    it.each([[404, 'model not found'], [403, 'forbidden on this tier'], [400, 'Provider returned error']])('fails on %i', async (status, message) => {
      expect((await chatCheck.run(ctxFor(fakeProvider(() => err(status, message)).provider))).outcome).toBe('fail');
    });

    it.each([
      ['429', err(429, 'rate limited')],
      ['503', err(503, 'overloaded')],
      ['a timeout', new Error('Request timed out after 30000ms')],
    ])('is inconclusive on %s', async (_name, error) => {
      expect((await chatCheck.run(ctxFor(fakeProvider(() => error).provider))).outcome).toBe('inconclusive');
    });
  });

  describe('toolCheck', () => {
    it('passes on a tool call', async () => {
      expect((await toolCheck.run(ctxFor(fakeProvider(() => ({ toolCall: true })).provider))).outcome).toBe('pass');
    });

    it('fails on a text answer and on a 400 that names tools', async () => {
      expect((await toolCheck.run(ctxFor(fakeProvider(() => ({ content: 'ping' })).provider))).outcome).toBe('fail');
      expect((await toolCheck.run(ctxFor(fakeProvider(() => err(400, 'tools are not supported')).provider))).outcome).toBe('fail');
    });

    it('is inconclusive on a 429', async () => {
      expect((await toolCheck.run(ctxFor(fakeProvider(() => err(429, 'slow down')).provider))).outcome).toBe('inconclusive');
    });
  });

  describe('runProbeStep', () => {
    it('turns a passing model on and sets its tool flag from the tool check', async () => {
      const [a, b] = register('groq', ['calls-tools', 'text-only']);
      const { provider } = fakeProvider(({ tools, modelId }) => (tools && modelId === 'calls-tools' ? { toolCall: true } : { content: 'pong' }));
      await runProbeStep(getDb(), 'groq', provider, KEY);
      expect(state(a!)).toMatchObject({ state: 'ok', held_off: 0, enabled: 1, supports_tools: 1, tools_checked: 1 });
      expect(state(b!)).toMatchObject({ state: 'ok', enabled: 1, supports_tools: 0, tools_checked: 1 });
    });

    it('counts a failed probe, and turns the model off with probe_failed at the limit', async () => {
      const [id] = register('groq', ['dead']);
      const { provider, chatCompletion } = fakeProvider(() => err(404, 'model not found'));
      await runProbeStep(getDb(), 'groq', provider, KEY);
      expect(state(id!)).toMatchObject({ state: 'pending', probe_failures: 1, enabled: 0 });
      for (let i = 1; i < PROBE_FAILURE_LIMIT; i++) await runProbeStep(getDb(), 'groq', provider, KEY);
      expect(state(id!)).toMatchObject({ state: 'probe_failed', probe_failures: 3, enabled: 0, held_off: 1 });
      await runProbeStep(getDb(), 'groq', provider, KEY);
      expect(chatCompletion).toHaveBeenCalledTimes(3);
    });

    it('does not count an inconclusive probe, and tries again on the next pass', async () => {
      const [id] = register('groq', ['busy']);
      const { provider, chatCompletion } = fakeProvider(() => err(429, 'rate limited'));
      await runProbeStep(getDb(), 'groq', provider, KEY);
      await runProbeStep(getDb(), 'groq', provider, KEY);
      expect(state(id!)).toMatchObject({ state: 'pending', probe_failures: 0, enabled: 0 });
      expect(chatCompletion).toHaveBeenCalledTimes(2);
    });

    it('counts a key error as inconclusive', async () => {
      const [id] = register('groq', ['bad-key']);
      await runProbeStep(getDb(), 'groq', fakeProvider(() => err(401, 'Unauthorized')).provider, KEY);
      expect(state(id!)).toMatchObject({ state: 'pending', probe_failures: 0 });
    });

    it('keeps a new model not tool-capable and retries the tool check after an inconclusive one', async () => {
      const [id] = register('groq', ['tool-busy']);
      let toolsBusy = true;
      const { provider } = fakeProvider(({ tools }) => (tools ? (toolsBusy ? err(503, 'overloaded') : { toolCall: true }) : { content: 'pong' }));
      await runProbeStep(getDb(), 'groq', provider, KEY);
      expect(state(id!)).toMatchObject({ state: 'ok', enabled: 1, supports_tools: 0, tools_checked: 0 });
      toolsBusy = false;
      await runProbeStep(getDb(), 'groq', provider, KEY);
      expect(state(id!)).toMatchObject({ supports_tools: 1, tools_checked: 1 });
    });

    it('keeps the tool flag of an existing model after an inconclusive tool check', async () => {
      const id = insertExisting('groq', 'old-model');
      checkState(getDb());
      await runProbeStep(getDb(), 'groq', fakeProvider(({ tools }) => (tools ? err(503, 'overloaded') : { content: 'pong' })).provider, KEY);
      expect(state(id)).toMatchObject({ state: 'ok', supports_tools: 1, tools_checked: 0 });
    });

    it('keeps an existing model on until its third failed probe', async () => {
      const id = insertExisting('groq', 'old-dead');
      checkState(getDb());
      const { provider } = fakeProvider(() => err(403, 'forbidden on this tier'));
      await runProbeStep(getDb(), 'groq', provider, KEY);
      await runProbeStep(getDb(), 'groq', provider, KEY);
      expect(state(id)).toMatchObject({ state: 'pending', enabled: 1, probe_failures: 2 });
      await runProbeStep(getDb(), 'groq', provider, KEY);
      expect(state(id)).toMatchObject({ state: 'probe_failed', enabled: 0 });
    });

    it('probes at most 10 models for each pass, oldest first', async () => {
      const ids = register('groq', Array.from({ length: 25 }, (_, i) => `m-${String(i).padStart(2, '0')}`));
      const { provider } = fakeProvider(() => ({ toolCall: true, content: 'pong' }));
      expect(PROBE_BUDGET).toBe(10);
      await runProbeStep(getDb(), 'groq', provider, KEY);
      expect(ids.filter(id => state(id).state === 'ok')).toEqual(ids.slice(0, 10));
      await runProbeStep(getDb(), 'groq', provider, KEY);
      await runProbeStep(getDb(), 'groq', provider, KEY);
      expect(ids.every(id => state(id).state === 'ok')).toBe(true);
    });

    it('skips a model with no rate-limit budget left, and counts the skip as inconclusive', async () => {
      const [id] = register('groq', ['no-budget']);
      getDb().prepare('UPDATE models SET rpd_limit = 0 WHERE id = ?').run(id);
      const { provider, chatCompletion } = fakeProvider(() => ({ content: 'pong' }));
      await runProbeStep(getDb(), 'groq', provider, KEY);
      expect(chatCompletion).not.toHaveBeenCalled();
      expect(state(id!)).toMatchObject({ state: 'pending', probe_failures: 0, enabled: 0 });
    });

    it('returns at once when another probe step for the platform is in progress', async () => {
      register('groq', ['slow']);
      let release: () => void = () => {};
      const gate = new Promise<void>(resolve => { release = resolve; });
      const chatCompletion = vi.fn(async () => { await gate; return completion({ content: 'pong' }); });
      const provider = { chatCompletion } as unknown as BaseProvider;
      const first = runProbeStep(getDb(), 'groq', provider, KEY);
      const second = await runProbeStep(getDb(), 'groq', provider, KEY);
      expect(second.skipped).toBe(true);
      release();
      await first;
      expect(chatCompletion).toHaveBeenCalledTimes(2);
    });

    it('counts a probe toward the model rate limit', async () => {
      const [id] = register('groq', ['counted']);
      getDb().prepare('UPDATE models SET rpm_limit = 1 WHERE id = ?').run(id);
      expect(canMakeRequest('groq', 'counted', 0, { rpm: 1, rpd: null, tpm: null, tpd: null })).toBe(true);
      await runProbeStep(getDb(), 'groq', fakeProvider(() => err(429, 'rate limited')).provider, KEY);
      expect(canMakeRequest('groq', 'counted', 0, { rpm: 1, rpd: null, tpm: null, tpd: null })).toBe(false);
    });

    it('logs each probe with the client model-probe', async () => {
      register('groq', ['logged']);
      await runProbeStep(getDb(), 'groq', fakeProvider(() => ({ content: 'pong' })).provider, KEY);
      const rows = getDb().prepare("SELECT model_id FROM requests WHERE caller = 'model-probe'").all() as { model_id: string }[];
      expect(rows.map(r => r.model_id)).toContain('logged');
    });

    it('does nothing when the checks are off', async () => {
      process.env.DISCOVERED_MODEL_CHECKS = 'off';
      const { provider, chatCompletion } = fakeProvider(() => ({ content: 'pong' }));
      expect((await runProbeStep(getDb(), 'groq', provider, KEY)).skipped).toBe(true);
      expect(chatCompletion).not.toHaveBeenCalled();
    });
  });

  describe('probe step in a discovery pass', () => {
    function stubFetch(models: () => Response) {
      const mock = vi.fn(async (input: unknown) => {
        const url = String(input);
        if (url.endsWith('/models')) return models();
        return new Response(JSON.stringify(completion({ content: 'pong', toolCall: true })), { status: 200, headers: { 'content-type': 'application/json' } });
      });
      globalThis.fetch = mock as any;
      return mock;
    }
    const list = (ids: string[]) => () => new Response(JSON.stringify({ object: 'list', data: ids.map(id => ({ id })) }),
      { status: 200, headers: { 'content-type': 'application/json' } });

    it('probes the new models after it registers them', async () => {
      addKey('groq');
      stubFetch(list(['fresh-model']));
      await runBuiltinModelDiscovery(getDb(), 'groq');
      const id = (getDb().prepare("SELECT id FROM models WHERE model_id = 'fresh-model'").get() as { id: number }).id;
      expect(state(id)).toMatchObject({ state: 'ok', enabled: 1 });
    });

    it('still probes pending models when the pass adds no new models', async () => {
      addKey('groq');
      const [id] = register('groq', ['waiting']);
      stubFetch(list(['waiting']));
      const result = await runBuiltinModelDiscovery(getDb(), 'groq');
      expect(result.added).toBe(0);
      expect(state(id!)).toMatchObject({ state: 'ok', enabled: 1 });
    });

    it('still probes pending models when the model-list call fails', async () => {
      addKey('groq');
      const [id] = register('groq', ['waiting']);
      stubFetch(() => new Response('{"error":{"message":"overloaded"}}', { status: 503 }));
      const result = await runBuiltinModelDiscovery(getDb(), 'groq');
      expect(result.failures).toHaveLength(1);
      expect(state(id!)).toMatchObject({ state: 'ok', enabled: 1 });
    });
  });
});
