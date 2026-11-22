#!/usr/bin/env node
// Live checks against a running router. The sync script runs them on the new
// build before and after it replaces the router on port 6969.
//
//   node scripts/fork/smoke.mjs --base http://127.0.0.1:6970 [--baseline http://127.0.0.1:6969] [--no-chat]
//
// The unified key comes from FREETIER_API_KEY or ~/.pi/agent/secrets/freetier-api-key.
// Each chat check uses one free-tier request. The script never prints the key.
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const args = process.argv.slice(2);
const opt = name => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
const base = (opt('--base') ?? 'http://127.0.0.1:6969').replace(/\/+$/, '');
const baseline = opt('--baseline')?.replace(/\/+$/, '');
const chat = !args.includes('--no-chat');
// Upstream can retire models, so a small drop is allowed. A large drop means
// that a migration or catalog change lost the user's models.
const MIN_MODEL_SHARE = 0.8;
const TIMEOUT_MS = 90_000;

const key = process.env.FREETIER_API_KEY?.trim()
  || readFileSync(join(homedir(), '.pi', 'agent', 'secrets', 'freetier-api-key'), 'utf8').trim();
const auth = { Authorization: `Bearer ${key}` };

let failed = 0;
async function check(name, fn) {
  const started = Date.now();
  try {
    const note = await fn();
    console.log(`ok    ${name}${note ? ` (${note})` : ''} ${Date.now() - started}ms`);
  } catch (err) {
    failed += 1;
    console.log(`FAIL  ${name}: ${err.message}`);
  }
}

function assert(cond, message) { if (!cond) throw new Error(message); }

async function get(url, headers = {}) {
  const res = await fetch(url, { headers, signal: AbortSignal.timeout(TIMEOUT_MS) });
  return { status: res.status, text: await res.text() };
}

async function availableModels(root) {
  const res = await get(`${root}/v1/models`, auth);
  assert(res.status === 200, `GET ${root}/v1/models answered ${res.status}`);
  return JSON.parse(res.text).data.filter(m => m.available !== false).map(m => m.id);
}

// Pi sends this shape: model auto, streaming, a system message, tools and
// max_tokens, with no developer role, store or reasoning_effort fields.
const PI_REQUEST = {
  model: 'auto',
  stream: true,
  max_tokens: 64,
  messages: [
    { role: 'system', content: 'You are a test. Answer in one word.' },
    { role: 'user', content: 'Say the word pong.' },
  ],
  tools: [{
    type: 'function',
    function: {
      name: 'read_file',
      description: 'Read a file.',
      parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
    },
  }],
};

await check('dashboard serves the FreeTier Router page', async () => {
  const res = await get(`${base}/`);
  assert(res.status === 200, `GET / answered ${res.status}`);
  assert(res.text.includes('FreeTier Router'), 'the page title does not name FreeTier Router');
});

await check('/v1/models needs the unified key', async () => {
  const res = await get(`${base}/v1/models`);
  assert(res.status === 401, `GET /v1/models without a key answered ${res.status}, not 401`);
});

let models = [];
await check('/v1/models lists auto as available', async () => {
  models = await availableModels(base);
  assert(models.includes('auto'), 'auto is missing or not available, and pi uses it');
  return `${models.length} available`;
});

if (baseline) {
  await check(`keeps at least ${MIN_MODEL_SHARE * 100}% of the models that ${baseline} lists`, async () => {
    const old = await availableModels(baseline);
    const now = new Set(models);
    const lost = old.filter(id => !now.has(id));
    assert(models.length >= old.length * MIN_MODEL_SHARE,
      `${models.length} available now, ${old.length} before; lost: ${lost.slice(0, 20).join(', ')}`);
    return `${old.length} before, ${models.length} now, ${lost.length} gone`;
  });
}

if (chat) {
  await check('a streaming chat request shaped like pi gets an answer', async () => {
    const res = await fetch(`${base}/v1/chat/completions`, {
      method: 'POST',
      headers: { ...auth, 'Content-Type': 'application/json' },
      body: JSON.stringify(PI_REQUEST),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    const body = await res.text();
    assert(res.status === 200, `answered ${res.status}: ${body.slice(0, 300)}`);
    const events = body.split('\n').filter(l => l.startsWith('data: ')).map(l => l.slice(6));
    assert(events.at(-1) === '[DONE]', 'the stream did not end with [DONE]');
    const chunks = events.slice(0, -1).map(e => JSON.parse(e));
    const text = chunks.map(c => c.choices?.[0]?.delta?.content ?? '').join('');
    const tool = chunks.some(c => c.choices?.[0]?.delta?.tool_calls);
    assert(text.trim().length > 0 || tool, 'the stream had no text and no tool call');
    return `model ${chunks.find(c => c.model)?.model ?? 'unknown'}`;
  });
}

console.log(failed === 0 ? 'smoke: all checks passed' : `smoke: ${failed} check(s) failed`);
process.exit(failed === 0 ? 0 : 1);
