import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/run-isolation-installed.probe.ts'],
    maxWorkers: 1,
    testTimeout: 180_000,
  },
})
