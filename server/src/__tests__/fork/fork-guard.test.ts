import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getProvider } from '../../providers/index.js';
import type { Platform } from '@freellmapi/shared/types.js';
import {
  builtinDiscoveryIntervalMs,
  builtinDiscoveryMode,
  builtinDiscoveryPlatforms,
  DISCOVERED_RPD_LIMIT,
  DISCOVERED_RPM_LIMIT,
  modelLister,
} from '../../services/builtin-model-discovery.js';
import { FREE_POLICIES } from '../../services/free-policy.js';

// freetier-router: checks that an upstream sync keeps the fork's features.
// The feature tests live in the files that FORK_TEST_FILES lists. This file
// makes sure that those files still exist, and it locks the defaults and the
// rebrand that no other test covers. scripts/fork/sync-upstream.sh runs it.

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');
const read = (file: string) => readFileSync(join(ROOT, file), 'utf8');

// The minimum counts stop a merge from emptying a test file without notice.
const FORK_TEST_FILES: Record<string, number> = {
  'server/src/__tests__/services/free-policy.test.ts': 17,
  'server/src/__tests__/services/builtin-model-discovery.test.ts': 33,
  'server/src/__tests__/services/catalog-sync-discovered.test.ts': 10,
  'server/src/__tests__/routes/builtin-model-discovery.test.ts': 10,
};

describe('fork test files', () => {
  for (const [file, min] of Object.entries(FORK_TEST_FILES)) {
    it(`keeps ${file} with at least ${min} tests`, () => {
      expect(existsSync(join(ROOT, file))).toBe(true);
      const count = read(file).match(/\bit(\.each\([^)]*\))?\(/g)?.length ?? 0;
      expect(count).toBeGreaterThanOrEqual(min);
    });
  }
});

describe('built-in model discovery defaults', () => {
  const saved = { ...process.env };
  beforeEach(() => {
    delete process.env.BUILTIN_MODEL_DISCOVERY;
    delete process.env.BUILTIN_MODEL_DISCOVERY_INTERVAL_MS;
  });
  afterEach(() => { process.env = { ...saved }; });

  it('turns discovery on (auto) when the variable is unset', () => {
    expect(builtinDiscoveryMode()).toBe('auto');
  });

  it('runs the scheduled pass every 6 hours by default', () => {
    expect(builtinDiscoveryIntervalMs()).toBe(6 * 60 * 60 * 1000);
  });

  it('gives a discovered model limits of 10 rpm and 250 a day', () => {
    expect(DISCOVERED_RPM_LIMIT).toBe(10);
    expect(DISCOVERED_RPD_LIMIT).toBe(250);
  });
});

describe('free policy providers', () => {
  const platforms = Object.keys(FREE_POLICIES) as Platform[];

  it('keeps a policy for each provider that the README names', () => {
    expect(platforms.sort()).toEqual(['bazaarlink', 'groq', 'mistral', 'openrouter', 'sealion', 'unorouter']);
  });

  // An upstream change that moves one of these providers to a native adapter
  // would stop discovery for it with no failing test anywhere else.
  for (const platform of platforms) {
    it(`can still list ${platform} models, so discovery reaches it`, () => {
      const provider = getProvider(platform);
      expect(provider, `${platform} is not registered`).toBeDefined();
      expect(modelLister(provider), `${platform} has no model lister`).toBeDefined();
      expect(builtinDiscoveryPlatforms()).toContain(platform);
    });
  }
});

describe('local setup', () => {
  it('points opencode at the router on port 6969', () => {
    const config = JSON.parse(read('opencode.json'));
    const providers = Object.values(config.provider ?? {}) as { options?: { baseURL?: string } }[];
    expect(providers.map(p => p.options?.baseURL)).toContain('http://127.0.0.1:6969/v1');
  });

  it('names the CLI package and its command freetier-router', () => {
    const pkg = JSON.parse(read('cli/package.json'));
    expect(pkg.name).toBe('freetier-router');
    expect(Object.keys(pkg.bin)).toEqual(['freetier-router']);
  });
});

describe('rebrand', () => {
  const manifest = JSON.parse(read('scripts/fork/rebrand-manifest.json')) as Record<string, string[]>;

  it('has a manifest of branded lines', () => {
    expect(Object.keys(manifest).length).toBeGreaterThan(0);
  });

  for (const [file, lines] of Object.entries(manifest)) {
    it(`keeps the branded lines in ${file}`, () => {
      expect(existsSync(join(ROOT, file)), `${file} is gone`).toBe(true);
      const present = new Set(read(file).split('\n').map(l => l.trim()));
      const missing = lines.filter(l => !present.has(l));
      expect(missing, `run "node scripts/fork/gen-rebrand-manifest.mjs" only if you changed these lines on purpose`).toEqual([]);
    });
  }
});
