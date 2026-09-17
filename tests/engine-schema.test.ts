import { describe, expect, it } from 'vitest'
import {
  agentProfileSchema,
  engineInstallationSchema,
  isVerifiedCapability,
  modelConnectionSchema,
  modelProfileSchema,
  type Capability,
} from '../src/shared/engines/schema'

const connection = {
  id: 'gateway',
  name: 'Team gateway',
  protocol: null,
  baseUrl: '',
  auth: { kind: 'unconfigured' },
  headers: {},
  secretHeaders: {},
}

describe('engine configuration boundaries', () => {
  it('keeps incomplete profiles and connections as drafts without inventing defaults', () => {
    expect(modelConnectionSchema.parse(connection)).toEqual(connection)
    const model = modelProfileSchema.parse({
      id: 'model',
      name: 'Model',
      connectionId: null,
      modelId: '',
      parameters: {},
    })
    expect(model.parameters).not.toHaveProperty('temperature')
    expect(
      agentProfileSchema.parse({
        id: 'agent',
        name: 'Agent',
        description: '',
        enabled: true,
        engineInstallationId: null,
        modelProfileId: null,
        promptBindings: [{ assetId: 'role', selection: { follow: 'latest' }, mode: null }],
        mcpServerIds: [],
        skillBindings: [],
        bundleIds: [],
        nativePluginIds: [],
        engineOptions: null,
        execution: { cwd: '', approval: 'ask' },
      }).engineInstallationId,
    ).toBeNull()
  })

  it('accepts credential references but rejects inline secret fields and command resolvers', () => {
    const auth = {
      kind: 'api-key',
      header: 'X-Api-Key',
      secret: { kind: 'credential', id: 'work' },
    }
    expect(modelConnectionSchema.safeParse({ ...connection, auth }).success).toBe(true)
    expect(modelConnectionSchema.safeParse({ ...connection, apiKey: 'secret' }).success).toBe(false)
    expect(
      modelConnectionSchema.safeParse({
        ...connection,
        auth: { ...auth, secret: { kind: 'environment', name: '!secret-command' } },
      }).success,
    ).toBe(false)
  })

  it.each(['file:///etc/passwd', 'https://user:password@api.example.com'])(
    'rejects endpoint %s',
    (baseUrl) => {
      expect(modelConnectionSchema.safeParse({ ...connection, baseUrl }).success).toBe(false)
    },
  )

  it('rejects case-insensitive header collisions and newline injection', () => {
    expect(
      modelConnectionSchema.safeParse({
        ...connection,
        headers: { Authorization: 'value' },
        auth: { kind: 'bearer', secret: null },
      }).success,
    ).toBe(false)
    expect(
      modelConnectionSchema.safeParse({
        ...connection,
        headers: { 'X-Token': 'value' },
        secretHeaders: { 'x-token': { kind: 'credential', id: 'token' } },
      }).success,
    ).toBe(false)
    expect(
      modelConnectionSchema.safeParse({ ...connection, headers: { 'X-Value': 'a\r\nInjected: b' } })
        .success,
    ).toBe(false)
  })

  it('registers installations without claiming that unknown versions were probed', () => {
    const installation = {
      id: 'oc',
      name: 'OpenCode',
      kind: 'opencode',
      executable: '/opt/bin/opencode',
      prefixArgs: [],
      platform: 'darwin',
      version: null,
      modes: [],
      probedAt: null,
    }
    expect(engineInstallationSchema.safeParse(installation).success).toBe(true)
    expect(
      engineInstallationSchema.safeParse({ ...installation, executable: 'opencode' }).success,
    ).toBe(false)
    expect(
      engineInstallationSchema.safeParse({
        ...installation,
        executable: 'C:\\Tools\\opencode.exe',
        platform: 'win32',
      }).success,
    ).toBe(true)
  })
})

describe('capability evidence', () => {
  const capability: Capability = {
    feature: 'runtime.resume',
    mechanism: 'native',
    verification: 'passed',
    availability: 'ready',
    reason: '',
    installationId: 'oc',
    engineVersion: '1.18.16',
    mode: 'acp',
    profileDigest: 'a'.repeat(64),
    evidence: [{ source: 'local-probe', checkedAt: '2026-09-18T00:00:00Z' }],
  }
  it('requires successful evidence for the exact installation and effective configuration', () => {
    expect(isVerifiedCapability(capability, capability)).toBe(true)
    expect(isVerifiedCapability(capability, { ...capability, engineVersion: '1.19.0' })).toBe(false)
    expect(isVerifiedCapability(capability, { ...capability, profileDigest: 'b'.repeat(64) })).toBe(
      false,
    )
    expect(isVerifiedCapability(capability, { ...capability, installationId: 'other' })).toBe(false)
    expect(isVerifiedCapability({ ...capability, verification: 'untested' }, capability)).toBe(
      false,
    )
    expect(
      isVerifiedCapability({ ...capability, availability: 'missing-credential' }, capability),
    ).toBe(false)
    expect(isVerifiedCapability({ ...capability, evidence: [] }, capability)).toBe(false)
    expect(isVerifiedCapability({ ...capability, mechanism: 'unsupported' }, capability)).toBe(
      false,
    )
  })
})
