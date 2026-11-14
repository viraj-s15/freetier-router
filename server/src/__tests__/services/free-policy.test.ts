import { describe, it, expect } from 'vitest';
import {
  acceptsModel,
  DEFAULT_FREE_POLICY,
  FREE_POLICIES,
  freePolicyFor,
  isNonChatFamily,
  patternMatches,
} from '../../services/free-policy.js';
import type { DiscoveredModel } from '../../services/model-discovery.js';

function model(id: string, price?: { note: string; isFree: boolean }): DiscoveredModel {
  const m: DiscoveredModel = { id, ownedBy: null };
  if (price) {
    m.priceNote = price.note;
    m.isFree = price.isFree;
  }
  return m;
}

const FREE = { note: 'free', isFree: true };
const PAID = { note: '$1/M in', isFree: false };

describe('freePolicyFor', () => {
  it('gives a provider with no entry the default pattern policy with no patterns', () => {
    expect(FREE_POLICIES.reka).toBeUndefined();
    expect(freePolicyFor('reka')).toEqual(DEFAULT_FREE_POLICY);
    expect(DEFAULT_FREE_POLICY).toEqual({ kind: 'pattern', patterns: [] });
  });

  it('gives an unknown platform string the default policy', () => {
    expect(freePolicyFor('not-a-platform')).toEqual(DEFAULT_FREE_POLICY);
  });
});

describe('acceptsModel: provider with no entry', () => {
  it('accepts nothing, whatever the price', () => {
    expect(acceptsModel('reka', model('reka-flash'))).toBe(false);
    expect(acceptsModel('reka', model('reka-flash', FREE))).toBe(false);
  });
});

describe('acceptsModel: free-key', () => {
  it('accepts a chat model with no price', () => {
    expect(freePolicyFor('groq').kind).toBe('free-key');
    expect(acceptsModel('groq', model('new-model'))).toBe(true);
  });

  it('accepts a model the list marks free', () => {
    expect(acceptsModel('groq', model('new-model', FREE))).toBe(true);
  });

  it('rejects a model the list prices as paid', () => {
    expect(acceptsModel('groq', model('new-model', PAID))).toBe(false);
  });
});

describe('acceptsModel: priced-listing', () => {
  it('accepts a model priced at zero', () => {
    expect(freePolicyFor('openrouter').kind).toBe('priced-listing');
    expect(acceptsModel('openrouter', model('vendor/model:free', FREE))).toBe(true);
  });

  it('rejects a model with no price', () => {
    expect(acceptsModel('openrouter', model('vendor/model:free'))).toBe(false);
  });

  it('rejects a model with a non-zero price', () => {
    expect(acceptsModel('openrouter', model('vendor/model', PAID))).toBe(false);
  });
});

describe('acceptsModel: pattern', () => {
  it('accepts only ids that match a pattern', () => {
    expect(freePolicyFor('unorouter')).toEqual({ kind: 'pattern', patterns: ['*:free'] });
    expect(acceptsModel('unorouter', model('vendor/model:free'))).toBe(true);
    expect(acceptsModel('unorouter', model('vendor/model'))).toBe(false);
  });

  it('matches the whole id, not a part of it', () => {
    expect(acceptsModel('bazaarlink', model('auto:free'))).toBe(true);
    expect(acceptsModel('bazaarlink', model('x-auto:free'))).toBe(false);
    expect(acceptsModel('bazaarlink', model('auto:free-extra'))).toBe(false);
  });

  it('rejects a matching id that the list prices as paid', () => {
    expect(acceptsModel('unorouter', model('vendor/model:free', PAID))).toBe(false);
  });
});

describe('acceptsModel: non-chat families', () => {
  it('rejects safety, moderation, OCR and speech models that the id classifier lets through', () => {
    for (const id of [
      'meta-llama/llama-guard-4-12b',
      'meta-llama/llama-prompt-guard-2-86m',
      'openai/gpt-oss-safeguard-20b',
      'mistral-moderation-latest',
      'mistral-ocr-latest',
      'canopylabs/orpheus-v1-english',
      'Some-Vendor/Model-TTS-1',
    ]) {
      expect(isNonChatFamily(id), id).toBe(true);
      expect(acceptsModel('groq', model(id)), id).toBe(false);
    }
  });

  it('keeps general chat models', () => {
    for (const id of ['mistral-large-latest', 'pixtral-large-latest', 'groq/compound', 'openai/gpt-oss-120b', 'qwen/qwen3-32b']) {
      expect(isNonChatFamily(id), id).toBe(false);
      expect(acceptsModel('groq', model(id)), id).toBe(true);
    }
  });

  it('applies to an explicit-free listing too', () => {
    expect(acceptsModel('openrouter', model('meta-llama/llama-guard-4-12b:free', FREE))).toBe(false);
  });
});

describe('patternMatches', () => {
  it('treats * as any run of characters, including none', () => {
    expect(patternMatches('llama-*', 'llama-')).toBe(true);
    expect(patternMatches('llama-*', 'llama-4-scout')).toBe(true);
    expect(patternMatches('*:free', ':free')).toBe(true);
  });

  it('treats regex characters in the pattern as literal text', () => {
    expect(patternMatches('a.b', 'a.b')).toBe(true);
    expect(patternMatches('a.b', 'axb')).toBe(false);
    expect(patternMatches('model(1)', 'model(1)')).toBe(true);
  });
});
