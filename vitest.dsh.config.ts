import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/dsh-installed.probe.ts', 'tests/dsh-configuration-installed.probe.ts'],
    testTimeout: 120_000,
  },
})
