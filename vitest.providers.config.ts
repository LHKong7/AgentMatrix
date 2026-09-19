import { defineConfig } from 'vitest/config'

// Explicit local-provider acceptance; no CLI or server runs in ordinary unit tests.
export default defineConfig({
  test: {
    environment: 'node',
    include: [
      'tests/anthropic-provider-installed.probe.ts',
      'tests/responses-provider-installed.probe.ts',
    ],
    testTimeout: 120_000,
  },
})
