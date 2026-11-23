import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    // The Cloudflare neuron meter asks Cloudflare's analytics API for the
    // account's own count in the background; that call would land in every
    // test's fetch mock. Its own tests switch it back on.
    // Built-in model discovery (freetier-router) runs a background pass on each
    // key save, and its /models and probe calls would land in the same mocks.
    // The discovery tests set or clear the variable themselves.
    env: { CLOUDFLARE_NEURON_ANALYTICS: '0', BUILTIN_MODEL_DISCOVERY: 'off' },
    include: ['src/__tests__/**/*.test.ts'],
    coverage: {
      enabled: process.env.COVERAGE === '1',
      provider: 'v8',
      include: ['src/**/*.ts'],
      exclude: ['src/__tests__/**', 'src/db/migrate/**', 'src/scripts/**', 'src/index.ts'],
      reporter: ['text', 'text-summary'],
    },
  },
});
