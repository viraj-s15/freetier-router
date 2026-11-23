import type { ChatCompletionResponse } from '@freellmapi/shared/types.js';
import type { Db } from '../db/types.js';
import type { BaseProvider } from '../providers/base.js';
import { contentToString } from '../lib/content.js';
import { isKeyAuthError } from '../lib/error-classify.js';
import { withKeyProxy } from '../lib/proxy.js';
import { logRequest } from '../lib/request-log.js';
import { canMakeRequest, recordRequest, recordTokens } from './ratelimit.js';
import {
  checkState,
  claimProbe,
  cleanupChecks,
  discoveredChecksOn,
  getCheckedModel,
  isPermanentModelError,
  markInconclusive,
  markProbeFailed,
  markProbePassed,
  markToolsChecked,
  reconcileOperator,
  redactedError,
  releaseProbe,
  rowsToProbe,
  type CheckedModel,
} from './discovered-model-checks.js';

// ── Probes for discovered models (freetier-router) ──
//
// A model that an automatic discovery pass adds waits off until one small chat
// request gets an answer. A tool check then sets `supports_tools` from what the
// model really does. Each check is one entry in CHECKS, so a vision or a
// context-window check later is one new entry.

export type ProbeOutcome = 'pass' | 'fail' | 'inconclusive';

export interface ProbeResult {
  outcome: ProbeOutcome;
  error?: unknown;
}

export interface ProbeContext {
  provider: BaseProvider;
  apiKey: string;
  proxyUrl: string | undefined;
  keyId: number;
  platform: string;
  modelId: string;
}

export interface ProbeCheck {
  name: string;
  /** Whether this check still has to run for the row. */
  needed(row: CheckedModel): boolean;
  run(ctx: ProbeContext): Promise<ProbeResult>;
  /** Record the result. False stops the later checks for this row. */
  apply(db: Db, row: CheckedModel, result: ProbeResult): boolean;
}

/** Models that one pass probes for each provider. */
export const PROBE_BUDGET = 10;
const PROBE_TIMEOUT_MS = 30_000;

const PROBE_TOOL = {
  type: 'function' as const,
  function: {
    name: 'record_word',
    description: 'Record one word.',
    parameters: {
      type: 'object',
      properties: { word: { type: 'string', description: 'The word to record.' } },
      required: ['word'],
    },
  },
};

/** Send one request, and count it toward the model's limits and the request log. */
async function send(
  ctx: ProbeContext,
  messages: Parameters<BaseProvider['chatCompletion']>[1],
  options: Parameters<BaseProvider['chatCompletion']>[3],
): Promise<{ response?: ChatCompletionResponse; error?: unknown }> {
  const started = Date.now();
  recordRequest(ctx.platform, ctx.modelId, ctx.keyId);
  try {
    const response = await withKeyProxy(ctx.proxyUrl, () => ctx.provider.chatCompletion(
      ctx.apiKey, messages, ctx.modelId, { ...options, timeoutMs: PROBE_TIMEOUT_MS },
    ));
    const inputTokens = response.usage?.prompt_tokens ?? 0;
    const outputTokens = response.usage?.completion_tokens ?? 0;
    recordTokens(ctx.platform, ctx.modelId, ctx.keyId, response.usage?.total_tokens ?? inputTokens + outputTokens);
    logRequest(ctx.platform, ctx.modelId, ctx.keyId, 'success', inputTokens, outputTokens,
      Date.now() - started, null, null, ctx.modelId, null, 'model-probe');
    return { response };
  } catch (error: unknown) {
    logRequest(ctx.platform, ctx.modelId, ctx.keyId, 'error', 0, 0,
      Date.now() - started, redactedError(error), null, ctx.modelId, null, 'model-probe');
    return { error };
  }
}

export const chatCheck: ProbeCheck = {
  name: 'chat',
  needed: row => row.state === 'pending',
  async run(ctx) {
    const { response, error } = await send(ctx, [{ role: 'user', content: 'ping' }], { max_tokens: 16 });
    if (error !== undefined) return { outcome: isPermanentModelError(error) || isProbeRejected(error) ? 'fail' : 'inconclusive', error };
    const choice = response?.choices?.[0];
    if (contentToString(choice?.message?.content ?? '').trim()) return { outcome: 'pass' };
    // A reasoning model can spend the whole small limit on reasoning.
    if (choice?.finish_reason === 'length') return { outcome: 'pass' };
    // A chat model that answers "ping" with nothing can't serve chat.
    return { outcome: 'fail', error: new Error('empty answer') };
  },
  apply(db, row, result) {
    if (result.outcome === 'pass') {
      markProbePassed(db, row);
      return true;
    }
    if (result.outcome === 'fail') markProbeFailed(db, row, result.error);
    else markInconclusive(db, row, result.error);
    return false;
  },
};

/** A 400 to a one-word chat request means the model can't take a plain chat request. A key error stays inconclusive. */
function isProbeRejected(err: unknown): boolean {
  return (err as { status?: unknown })?.status === 400 && !isKeyAuthError(err);
}

function namesTools(err: unknown): boolean {
  const status = (err as { status?: unknown })?.status;
  const message = String((err as { message?: unknown })?.message ?? '');
  return status === 400 && /tool|function/i.test(message);
}

export const toolCheck: ProbeCheck = {
  name: 'tools',
  needed: row => row.tools_checked === 0,
  async run(ctx) {
    const { response, error } = await send(ctx, [
      { role: 'user', content: 'Call the record_word tool with the word "ping". Do not answer with text.' },
    ], { tools: [PROBE_TOOL], tool_choice: 'auto', max_tokens: 128 });
    if (error !== undefined) return namesTools(error) ? { outcome: 'fail', error } : { outcome: 'inconclusive', error };
    const message = response?.choices?.[0]?.message;
    if (message?.tool_calls?.length) return { outcome: 'pass' };
    if (contentToString(message?.content ?? '').trim()) return { outcome: 'fail' };
    return { outcome: 'inconclusive', error: new Error('empty answer') };
  },
  apply(db, row, result) {
    if (result.outcome === 'inconclusive') markInconclusive(db, row, result.error);
    else markToolsChecked(db, row, result.outcome === 'pass');
    return true;
  },
};

export const CHECKS: readonly ProbeCheck[] = [chatCheck, toolCheck];

export interface ProbeKey {
  keyId: number;
  apiKey: string;
  proxyUrl: string | undefined;
}

export interface ProbeStepResult {
  probed: number;
  skipped: boolean;
}

/**
 * Probe up to PROBE_BUDGET models of one platform that still need a check,
 * oldest first, with one key. A second step for the same platform returns at
 * once while the first one runs.
 */
export async function runProbeStep(db: Db, platform: string, provider: BaseProvider | undefined, key: ProbeKey): Promise<ProbeStepResult> {
  if (!discoveredChecksOn() || !provider) return { probed: 0, skipped: true };
  checkState(db);
  if (!claimProbe(db, platform)) return { probed: 0, skipped: true };
  try {
    cleanupChecks(db);
    const rows = rowsToProbe(db, platform, PROBE_BUDGET);
    for (const found of rows) {
      let row = reconcileOperator(db, found);
      const ctx: ProbeContext = { provider, apiKey: key.apiKey, proxyUrl: key.proxyUrl, keyId: key.keyId, platform, modelId: row.model_id };
      for (const check of CHECKS) {
        if (row.state === 'operator' || !check.needed(row)) continue;
        if (!canMakeRequest(platform, row.model_id, key.keyId, { rpm: row.rpm_limit, rpd: row.rpd_limit, tpm: null, tpd: null })) {
          markInconclusive(db, row, new Error('no rate-limit budget left on the probe key'));
          break;
        }
        const result = await check.run(ctx);
        if (!check.apply(db, row, result)) break;
        row = getCheckedModel(db, row.model_db_id) ?? row;
      }
    }
    return { probed: rows.length, skipped: false };
  } finally {
    releaseProbe(db, platform);
  }
}
