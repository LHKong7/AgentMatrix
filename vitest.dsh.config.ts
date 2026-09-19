import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'node',
    include: [
      'tests/dsh-installed.probe.ts',
      'tests/dsh-configuration-installed.probe.ts',
      'tests/dsh-runtime-installed.probe.ts',
      'tests/dsh-plugin-installed.probe.ts',
      'tests/dsh-plugin-activation.probe.ts',
      'tests/dsh-skill-sources-installed.probe.ts',
    ],
    testTimeout: 120_000,
  },
})
