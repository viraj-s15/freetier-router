import type { Platform } from '@freellmapi/shared/types.js';
import type { DiscoveredModel } from './model-discovery.js';

// ── Free policy for built-in model discovery (freetier-router) ──────────────
//
// An automatic discovery pass adds models nobody looked at, so each provider
// gets one rule for what counts as free. A provider with no entry gets the
// default, which accepts nothing: a new adapter can never route traffic to a
// paid model just because its /models lists one.
//
// Adding a provider is one entry in FREE_POLICIES. Adding a policy kind is one
// union member plus one evaluator; the mapped type below makes the compiler
// reject a kind without an evaluator.

export type FreePolicy =
  | { kind: 'free-key' }
  | { kind: 'priced-listing' }
  | { kind: 'pattern'; patterns: readonly string[] };

export type FreePolicyKind = FreePolicy['kind'];

/** Each entry names the source that shows the provider's key can't be billed,
 *  or how the /models reply marks free models. `free-key` assumes an account
 *  with no payment method; the README states this. */
export const FREE_POLICIES: Readonly<Partial<Record<Platform, FreePolicy>>> = {
  // console.groq.com/docs/billing-faqs: Free tier answers 429 at its limits;
  // billing starts only after an upgrade with a payment method.
  groq: { kind: 'free-key' },
  // Mistral Experiment plan: free, no card; billing starts only when a
  // payment method is added (Scale plan).
  mistral: { kind: 'free-key' },
  // docs.sea-lion.ai: the API issues only a free trial key, 10 RPM.
  sealion: { kind: 'free-key' },
  // OpenRouter's /models carries a `pricing` object; free routes price at 0.
  openrouter: { kind: 'priced-listing' },
  // docs/en/providers/01-supported-platforms.md: free models carry `:free`.
  unorouter: { kind: 'pattern', patterns: ['*:free'] },
  // Same doc: only the `auto:free` route is free, direct ids are paid (#385).
  bazaarlink: { kind: 'pattern', patterns: ['auto:free'] },
};

export const DEFAULT_FREE_POLICY: FreePolicy = { kind: 'pattern', patterns: [] };

/** Model families that answer /chat/completions but aren't general chat
 *  models, which the id classifier in model-discovery.ts lets through: safety
 *  classifiers, moderation, OCR and speech. A pass that added them would let
 *  the router send a normal request to a classifier. Matched case-blind
 *  against the whole id, for every policy. */
export const NON_CHAT_PATTERNS: readonly string[] = [
  '*guard*',
  '*moderation*',
  '*-ocr*',
  '*orpheus*',
  '*-tts*',
];

/** Glob match where `*` matches any run of chars (incl. empty). */
export function patternMatches(pattern: string, id: string): boolean {
  const escaped = pattern.split('*').map(seg => seg.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  return new RegExp(`^${escaped.join('.*')}$`).test(id);
}

export function isNonChatFamily(id: string): boolean {
  const lower = id.toLowerCase();
  return NON_CHAT_PATTERNS.some(p => patternMatches(p, lower));
}

/** A listed price that is not free. Unknown price is not "priced". */
function listedAsPaid(model: DiscoveredModel): boolean {
  return model.priceNote !== undefined && model.isFree !== true;
}

type Evaluators = {
  [K in FreePolicyKind]: (model: DiscoveredModel, policy: Extract<FreePolicy, { kind: K }>) => boolean;
};

const evaluators: Evaluators = {
  'free-key': (model) => !listedAsPaid(model),
  'priced-listing': (model) => model.isFree === true,
  pattern: (model, policy) => !listedAsPaid(model) && policy.patterns.some(p => patternMatches(p, model.id)),
};

export function freePolicyFor(platform: string): FreePolicy {
  return FREE_POLICIES[platform as Platform] ?? DEFAULT_FREE_POLICY;
}

/** False when the platform's policy can accept no model at all, so callers
 *  don't promise the operator that models are on their way. */
export function policyCanAccept(platform: string): boolean {
  const policy = freePolicyFor(platform);
  return policy.kind !== 'pattern' || policy.patterns.length > 0;
}

/** Whether an automatic pass may add this model for this platform. Callers
 *  filter non-chat models first; this judges price only. */
export function acceptsModel(platform: string, model: DiscoveredModel): boolean {
  if (isNonChatFamily(model.id)) return false;
  const policy = freePolicyFor(platform);
  return (evaluators[policy.kind] as (m: DiscoveredModel, p: FreePolicy) => boolean)(model, policy);
}
