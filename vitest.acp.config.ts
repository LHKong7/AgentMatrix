import { defineConfig } from 'vitest/config'

// Explicit opt-in: normal CI never launches a user's installed CLI.
export default defineConfig({
  test: { environment: 'node', include: ['tests/acp-installed.probe.ts'], testTimeout: 25_000 },
})
