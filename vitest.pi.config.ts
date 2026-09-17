import { defineConfig } from 'vitest/config'

// Explicit opt-in; regular CI never executes a user's CLI or starts a provider fixture.
export default defineConfig({
  test: {
    environment: 'node',
    include: [
      'tests/pi-installed.probe.ts',
      'tests/pi-configuration-installed.probe.ts',
      'tests/pi-runtime-installed.probe.ts',
    ],
    testTimeout: 120_000,
  },
})
