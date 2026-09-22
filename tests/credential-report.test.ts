import { randomUUID } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import {
  credentialReport,
  credentialSlots,
  trackCredentialResolution,
} from '../src/main/engines/credential-report'
import {
  credentialResolutionsSchema,
  type CredentialResolution,
} from '../src/shared/engines/credential-observation'
import { modelConnectionSchema } from '../src/shared/engines/schema'
import type { RunInputManifest } from '../src/shared/engines/run-inputs'
import type { CredentialVersions } from '../src/main/credentials/vault'

const reference = { kind: 'credential' as const, id: 'SENSITIVE_ID' }
const environment = { kind: 'environment' as const, name: 'SENSITIVE_ENV' }
const versionId = randomUUID(),
  changedId = randomUUID(),
  at = '2026-09-19T00:00:00.000Z'
const input = (): Pick<RunInputManifest, 'launch' | 'connection' | 'mcpServers'> => ({
  connection: modelConnectionSchema.parse({
    id: 'connection',
    name: 'Connection',
    baseUrl: 'https://example.test',
    protocol: 'openai-chat-completions',
    auth: { kind: 'bearer', secret: reference },
    headers: {},
    secretHeaders: { 'X-Private': reference },
  }),
  mcpServers: [
    {
      id: 'local',
      name: 'Local',
      enabled: true,
      description: '',
      transport: 'stdio',
      command: 'not-executed',
      args: [],
      cwd: '',
      environment: {},
      envRefs: { PRIVATE: reference },
    },
    {
      id: 'remote',
      name: 'Remote',
      enabled: true,
      description: '',
      transport: 'streamable-http',
      url: 'https://example.test',
      headers: {},
      secretHeaders: { 'X-Remote': reference },
      auth: { kind: 'bearer', secret: reference },
    },
  ],
  launch: {
    mode: 'acp',
    args: [],
    environment: {
      Z_LAST: { kind: 'secret', reference },
      A_ENV: { kind: 'secret', reference: environment },
      B_DUPLICATE: { kind: 'secret', reference, encoding: 'json-string' },
    },
  },
})
const observed: CredentialResolution[] = [
  { slot: 1, resolvedAt: at, version: { source: 'environment' } },
  { slot: 2, resolvedAt: at, version: { source: 'vault', versionId, revision: 1, updatedAt: at } },
]
const current = (patch = {}): CredentialVersions => ({
  available: true,
  entries: [{ id: reference.id, versionId, revision: 1, updatedAt: at, ...patch }],
})

describe('credential revision reports', () => {
  it('deduplicates references into stable private slots and covers model and MCP purposes', () => {
    const first = input(),
      reversed = input()
    reversed.launch.environment = Object.fromEntries(
      Object.entries(first.launch.environment).reverse(),
    )
    expect(credentialSlots(reversed)).toEqual(credentialSlots(first))
    expect(credentialSlots(first)).toEqual([
      { slot: 1, reference: environment, purposes: ['other'] },
      {
        slot: 2,
        reference,
        purposes: ['model-auth', 'model-header', 'mcp-env', 'mcp-auth', 'mcp-header'],
      },
    ])
  })
  it.each([
    ['same', current()],
    ['changed', current({ revision: 2, versionId: changedId })],
    ['changed', current({ versionId: changedId })],
    ['missing', { available: true, entries: [] }],
    ['unverified', current({ versionId: null })],
    ['unavailable', { ...current(), available: false }],
    ['unavailable', null],
  ] satisfies Array<[string, CredentialVersions | null]>)(
    'reports %s without exposing references or opaque generation tokens',
    (state, versions) => {
      const result = credentialReport(input(), observed, versions)
      expect(result.entries[0]!.state).toBe('environment')
      expect(result.entries[1]!.state).toBe(state)
      expect(result.entries[1]!.attachment).toEqual({ revision: 1, updatedAt: at, resolvedAt: at })
      for (const sensitive of ['SENSITIVE_ID', 'SENSITIVE_ENV', versionId, changedId])
        expect(JSON.stringify(result)).not.toContain(sensitive)
    },
  )
  it('keeps legacy/unattached sessions unverified and refuses mismatched slots or source kinds', () => {
    expect(credentialReport(input(), undefined, current()).entries[1]!.state).toBe('unverified')
    expect(() => credentialReport(input(), [{ ...observed[1]!, slot: 3 }], current())).toThrow(
      'report.credentials',
    )
    expect(() => credentialReport(input(), [{ ...observed[1]!, slot: 1 }], current())).toThrow(
      'report.credentials',
    )
  })
  it('bounds and validates journal metadata and never accepts raw secrets as observation fields', () => {
    expect(credentialResolutionsSchema.safeParse(observed).success).toBe(true)
    for (const value of [
      [observed[0], observed[0]],
      [{ ...observed[0], value: 'SECRET' }],
      [{ ...observed[1], version: { ...observed[1]!.version, reference } }],
      [{ ...observed[0], slot: 257 }],
    ])
      expect(credentialResolutionsSchema.safeParse(value).success).toBe(false)
  })
  it('tracks one resolution per reference and associates its exact revision rather than a later status read', async () => {
    const resolve = vi.fn(async () => ({
      value: 'private-value',
      resolvedAt: at,
      version: observed[1]!.version,
    }))
    const tracked = trackCredentialResolution(input(), resolve)
    expect(await Promise.all([tracked.resolve(reference), tracked.resolve(reference)])).toEqual([
      'private-value',
      'private-value',
    ])
    expect(resolve).toHaveBeenCalledTimes(1)
    expect(() => tracked.complete()).toThrow('credentials')
    await expect(tracked.resolve({ kind: 'credential', id: 'unplanned' })).rejects.toThrow(
      'credentials',
    )
    await expect(tracked.resolve(environment)).rejects.toThrow('credentials')
    expect(resolve).toHaveBeenCalledTimes(2)
    tracked.clear()
  })
  it('records complete revision metadata without retaining the resolved value in observations', async () => {
    const tracked = trackCredentialResolution(input(), async (reference) => ({
      value: 'private-value',
      resolvedAt: at,
      version: reference.kind === 'environment' ? { source: 'environment' } : observed[1]!.version,
    }))
    await tracked.resolve(reference)
    await tracked.resolve(environment)
    expect(tracked.complete()).toEqual(observed)
    expect(JSON.stringify(tracked.complete())).not.toContain('private-value')
    tracked.clear()
  })
  it('rejects oversized reference sets before resolving secrets or starting a native process', () => {
    const manifest = input()
    manifest.launch.environment = Object.fromEntries(
      Array.from({ length: 257 }, (_, i) => [
        `KEY_${i}`,
        { kind: 'secret', reference: { kind: 'credential', id: `credential-${i}` } },
      ]),
    )
    const resolve = vi.fn()
    expect(() => trackCredentialResolution(manifest, resolve)).toThrow('credentials')
    expect(resolve).not.toHaveBeenCalled()
  })
})
