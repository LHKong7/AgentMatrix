import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/opencode-installed.probe.ts', 'tests/opencode-plugin-installed.probe.ts'],
    testTimeout: 120_000,
  },
})
