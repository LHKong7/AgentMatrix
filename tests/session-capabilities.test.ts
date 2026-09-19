import { describe, expect, it } from 'vitest'
import { buildSessionCapabilities } from '../src/main/engines/session-capabilities'
import { engineContracts, type SupportedEngine } from '../src/shared/engines/contracts'
import { runInputManifestSchema } from '../src/shared/engines/run-inputs'
import { capabilitySchema, isVerifiedCapability } from '../src/shared/engines/schema'
import {
  configurationCheckSchema,
  type ConfigurationCheck,
} from '../src/shared/engines/configuration-report'
import {
  isCurrentSessionCapability,
  nativeRuntimeSchema,
  type NativeRuntimeObservation,
  type SessionCapabilityFeature,
} from '../src/shared/engines/session-capabilities'
import { applySessionEvent, createSessionSnapshot } from '../src/shared/sessions/state'
import { sessionEventDataSchema } from '../src/shared/sessions/schema'
import { isMessageKey, catalogs } from '../src/shared/i18n'
import { openCodeWorkspace } from './helpers/opencode-fixture'
import { piWorkspace } from './helpers/pi-fixture'
import { dshWorkspace } from './helpers/dsh-fixture'

const at = '2026-09-19T00:00:00.000Z'
function fixture(kind: SupportedEngine = 'opencode') {
  const workspace = {
    opencode: openCodeWorkspace,
    pi: piWorkspace,
    'deepseek-harness': dshWorkspace,
  }[kind]('/fixture/cli', '/fixture/project')
  const contract = engineContracts[kind]
  // Schema-valid captured inputs for pure aggregation; this fixture never executes an engine.
  const manifest = runInputManifestSchema.parse({
    schemaVersion: 1,
    id: 'snapshot',
    digest: 'a'.repeat(64),
    createdAt: at,
    workspaceRevision: 1,
    adapter: { id: contract.id, version: contract.version },
    agent: workspace.agents[0],
    installation: workspace.installations[0],
    executable: { path: '/fixture/cli', sha256: 'b'.repeat(64), bytes: 1 },
    cwd: '/fixture/project',
    connection: workspace.connections[0],
    model: workspace.models[0],
    mcpServers: [],
    nativePlugins: [],
    files: [],
    externalSources: { coverage: 'partial', files: [] },
    prompts: [{ assetId: 'role', version: 1, source: 'agent', mode: 'replace', path: 'role.md' }],
    skills: [
      {
        assetId: 'skill',
        version: 1,
        source: 'agent',
        name: 'test',
        path: 'skills/test',
        directoryDigest: null,
      },
    ],
    launch: {
      mode: contract.mode,
      args: [],
      environment: {
        PRIVATE: { kind: 'secret', reference: { kind: 'environment', name: 'PROBE_KEY' } },
      },
    },
  })
  const initial = createSessionSnapshot({
    id: 'session',
    agentId: manifest.agent.id,
    installationId: manifest.installation.id,
    engineVersion: contract.engineVersion,
    mode: contract.mode,
    cwd: manifest.cwd,
    snapshotId: manifest.id,
    snapshotDigest: manifest.digest,
    createdAt: at,
  })
  const starting = applySessionEvent(initial, {
    sessionId: initial.id,
    cursor: 1,
    timestamp: at,
    runId: 'run',
    turnId: null,
    data: { kind: 'run.starting' },
  })
  const native: NativeRuntimeObservation =
    kind === 'pi'
      ? { protocol: 'pi-rpc', restoration: 'switch-session', restored: false }
      : { protocol: 'acp', version: 1, restoration: 'resume', restored: false }
  const ready = (
    checks: ConfigurationCheck[] = configurationCheckSchema.options,
    protocol: NativeRuntimeObservation | undefined = native,
  ) =>
    applySessionEvent(starting, {
      sessionId: initial.id,
      cursor: 2,
      timestamp: at,
      runId: 'run',
      turnId: null,
      data: {
        kind: 'run.ready',
        nativeSessionId: 'native',
        configurationChecks: checks,
        ...(protocol ? { nativeRuntime: protocol } : {}),
        credentialResolutions: [{ slot: 1, resolvedAt: at, version: { source: 'environment' } }],
      },
    })
  return { manifest, initial, starting, ready, native }
}
const row = (
  report: ReturnType<typeof buildSessionCapabilities>,
  feature: SessionCapabilityFeature,
) => report.capabilities.find((item) => item.feature === feature)!

describe('native session capability aggregation', () => {
  it.each(['opencode', 'pi', 'deepseek-harness'] as const)(
    'separates %s configuration evidence from model/Prompt/MCP/policy acceptance',
    (kind) => {
      const f = fixture(kind),
        session = f.ready(),
        before = structuredClone({ manifest: f.manifest, session })
      const report = buildSessionCapabilities(f.manifest, session)
      expect(report.capabilities).toHaveLength(18)
      expect(report.current).toBe(true)
      for (const feature of [
        'installation-version',
        'session-protocol',
        'model-selection',
        'connection-mapping',
        'credential-resolution',
        'skill-mapping',
      ] as const) {
        expect(row(report, feature)).toMatchObject({
          verification: 'passed',
          availability: 'ready',
        })
        expect(isCurrentSessionCapability(report, feature, report.identity)).toBe(true)
      }
      for (const feature of [
        'model-service',
        'prompt-loading',
        'mcp-connectivity',
        'policy-enforcement',
      ] as const)
        expect(isCurrentSessionCapability(report, feature, report.identity)).toBe(false)
      expect(row(report, 'model-service').verification).toBe('untested')
      expect(row(report, 'skill-discovery').verification).toBe(
        kind === 'pi' ? 'passed' : 'untested',
      )
      expect(row(report, 'prompt-mapping').verification).toBe(kind === 'pi' ? 'untested' : 'passed')
      expect(row(report, 'plugin-activation')).toMatchObject({
        requested: false,
        verification: 'untested',
      })
      expect({ manifest: f.manifest, session }).toEqual(before)
      for (const capability of report.capabilities) {
        const { requested, advertised, checks, ...descriptor } = capability
        expect(typeof requested).toBe('boolean')
        expect(advertised === null || typeof advertised === 'boolean').toBe(true)
        expect(checks.every((check) => session.configuration!.checks.includes(check))).toBe(true)
        expect(capabilitySchema.safeParse(descriptor).success).toBe(true)
        expect(isMessageKey(capability.reason)).toBe(true)
        for (const locale of ['en', 'zh-CN'] as const) {
          expect(Object.hasOwn(catalogs[locale], `capability.feature.${capability.feature}`)).toBe(
            true,
          )
          expect(Object.hasOwn(catalogs[locale], `capability.scope.${capability.feature}`)).toBe(
            true,
          )
        }
      }
    },
  )
  it('does not turn an advertised restore method into verified restoration', () => {
    const f = fixture(),
      report = buildSessionCapabilities(f.manifest, f.ready())
    const restore = row(report, 'native-restore')
    expect(restore).toMatchObject({
      advertised: true,
      verification: 'untested',
      availability: 'ready',
    })
    expect(restore.evidence.some((entry) => entry.kind === 'advertisement')).toBe(true)
    expect(isVerifiedCapability({ ...restore, verification: 'passed' }, restore)).toBe(false)
    const unavailable = buildSessionCapabilities(
      f.manifest,
      f.ready([], { protocol: 'acp', version: 1, restoration: 'unavailable', restored: false }),
    )
    expect(row(unavailable, 'native-restore')).toMatchObject({
      advertised: false,
      verification: 'untested',
      availability: 'blocked',
    })
  })
  it.each(['opencode', 'pi', 'deepseek-harness'] as const)(
    'requires a fresh successful %s restore and preserves only historical availability after interruption',
    (kind) => {
      const f = fixture(kind),
        ready = f.ready()
      const interrupted = applySessionEvent(ready, {
        sessionId: ready.id,
        cursor: 3,
        timestamp: at,
        runId: ready.runId,
        turnId: null,
        data: { kind: 'run.interrupted', failure: { code: 'interrupted', detail: '' } },
      })
      const historical = buildSessionCapabilities(f.manifest, interrupted)
      expect(row(historical, 'model-selection')).toMatchObject({
        verification: 'passed',
        availability: 'unknown',
      })
      expect(isCurrentSessionCapability(historical, 'model-selection', historical.identity)).toBe(
        false,
      )
      const resuming = applySessionEvent(interrupted, {
        sessionId: ready.id,
        cursor: 4,
        timestamp: at,
        runId: 'next-run',
        turnId: null,
        data: { kind: 'run.resuming' },
      })
      expect(buildSessionCapabilities(f.manifest, resuming).current).toBe(false)
      const resumed = applySessionEvent(resuming, {
        sessionId: ready.id,
        cursor: 5,
        timestamp: at,
        runId: 'next-run',
        turnId: null,
        data: {
          kind: 'run.ready',
          nativeSessionId: 'native',
          configurationChecks: ready.configuration!.checks,
          nativeRuntime: { ...f.native, restored: true },
        },
      })
      const report = buildSessionCapabilities(f.manifest, resumed)
      expect(report.identity.runId).toBe('next-run')
      expect(row(report, 'native-restore')).toMatchObject({
        verification: 'passed',
        availability: 'ready',
      })
      expect(isCurrentSessionCapability(report, 'native-restore', report.identity)).toBe(true)
      expect(isCurrentSessionCapability(report, 'native-restore', historical.identity)).toBe(false)
    },
  )
  it('keeps Pi MCP extension dependence separate from optional configuration and tool approval', () => {
    const f = fixture('pi'),
      report = buildSessionCapabilities(f.manifest, f.ready())
    expect(row(report, 'mcp-mapping')).toMatchObject({
      mechanism: 'extension-required',
      requested: false,
      availability: 'missing-dependency',
      verification: 'untested',
    })
    expect(row(report, 'policy-enforcement')).toMatchObject({
      mechanism: 'unsupported',
      availability: 'blocked',
      verification: 'untested',
    })
    expect(row(report, 'native-restore')).toMatchObject({
      advertised: null,
      verification: 'untested',
      availability: 'unknown',
    })
  })
  it('requires complete matching native checks and respects separate DSH reasoning routes', () => {
    const f = fixture(),
      partial = buildSessionCapabilities(f.manifest, f.ready(['opencode.session-model']))
    expect(row(partial, 'model-selection')).toMatchObject({
      verification: 'untested',
      availability: 'unknown',
    })
    const dsh = fixture('deepseek-harness')
    expect(
      row(buildSessionCapabilities(dsh.manifest, dsh.ready()), 'reasoning-selection').mechanism,
    ).toBe('unsupported')
    dsh.manifest.connection.protocol = 'deepseek-official'
    expect(
      row(buildSessionCapabilities(dsh.manifest, dsh.ready()), 'reasoning-selection').verification,
    ).toBe('passed')
  })
  it('keeps created and legacy records unverified instead of inferring a protocol from Ready state', () => {
    const f = fixture()
    const created = buildSessionCapabilities(f.manifest, f.initial)
    expect(created.capabilities.every((capability) => capability.verification === 'untested')).toBe(
      true,
    )
    const legacy = f.ready()
    delete legacy.configuration!.nativeRuntime
    delete legacy.configuration!.credentialResolutions
    const report = buildSessionCapabilities(f.manifest, legacy)
    for (const feature of ['session-protocol', 'native-restore', 'credential-resolution'] as const)
      expect(row(report, feature).verification).toBe('untested')
  })
  it('invalidates adapter changes and rejects another snapshot/session/native identity', () => {
    const f = fixture(),
      ready = f.ready(),
      report = buildSessionCapabilities(f.manifest, ready)
    for (const [key, value] of Object.entries({
      sessionId: 'different',
      profileId: 'different',
      snapshotDigest: 'c'.repeat(64),
      installationId: 'different',
      engineVersion: '2.0',
      mode: 'pi-rpc',
      adapter: { id: 'other', version: '2' },
      connectionId: 'other',
      protocol: 'gemini',
      modelId: 'other',
      runId: 'other',
      nativeSessionId: 'other',
    }))
      expect(
        isCurrentSessionCapability(report, 'model-selection', { ...report.identity, [key]: value }),
      ).toBe(false)
    f.manifest.adapter.version = 'future'
    const changed = buildSessionCapabilities(f.manifest, ready)
    expect(changed.contractMatches).toBe(false)
    expect(
      changed.capabilities.every(
        (entry) => entry.verification === 'untested' && entry.availability === 'unknown',
      ),
    ).toBe(true)
    expect(() =>
      buildSessionCapabilities(f.manifest, { ...ready, snapshotDigest: 'c'.repeat(64) }),
    ).toThrow('identity')
    expect(() =>
      buildSessionCapabilities(f.manifest, { ...ready, nativeSessionId: 'other' }),
    ).toThrow('identity')
  })
  it('does not disclose captured paths, prompts, key references, headers, or raw protocol metadata', () => {
    const f = fixture()
    f.manifest.connection.headers.Authorization = 'PRIVATE_HEADER'
    f.manifest.connection.baseUrl =
      'https://user:PRIVATE_KEY@example.test/PRIVATE_PATH?key=PRIVATE_QUERY'
    const output = JSON.stringify(buildSessionCapabilities(f.manifest, f.ready()))
    for (const secret of [
      'PROBE_KEY',
      '/fixture/',
      'PRIVATE_HEADER',
      'PRIVATE_KEY',
      'PRIVATE_PATH',
      'PRIVATE_QUERY',
      'role.md',
    ])
      expect(output).not.toContain(secret)
    expect(
      nativeRuntimeSchema.safeParse({ ...f.native, authMethods: ['RAW_SECRET'] }).success,
    ).toBe(false)
    expect(
      nativeRuntimeSchema.safeParse({
        protocol: 'acp',
        version: 1,
        restoration: 'unavailable',
        restored: true,
      }).success,
    ).toBe(false)
    expect(
      sessionEventDataSchema.safeParse({
        kind: 'run.ready',
        nativeSessionId: 'native',
        nativeRuntime: { ...f.native, extra: 'RAW_SECRET' },
      }).success,
    ).toBe(false)
  })
  it('rejects a fabricated restoration receipt on an initial start or the wrong protocol', () => {
    const f = fixture()
    expect(() => f.ready([], { ...f.native, restored: true })).toThrow('sessionStale')
    expect(() =>
      f.ready([], { protocol: 'pi-rpc', restoration: 'switch-session', restored: false }),
    ).toThrow('sessionStale')
  })
  it.each(['opencode', 'pi', 'deepseek-harness'] as const)(
    'requires selected %s plugin activation rather than configuration or another engine check',
    (kind) => {
      const f = fixture(kind)
      f.manifest.nativePlugins.push({
        id: 'selected',
        name: 'Selected',
        engineInstallationId: f.manifest.installation.id,
        nativeId: 'selected',
        source: '',
        version: '1',
        path: '/fixture/plugin',
      })
      const expected: ConfigurationCheck =
        kind === 'opencode' ? 'opencode.plugins' : kind === 'pi' ? 'pi.plugins' : 'dsh.plugins'
      const missing = f.ready(
        configurationCheckSchema.options.filter((check) => check !== expected),
      )
      expect(
        row(buildSessionCapabilities(f.manifest, missing), 'plugin-activation').verification,
      ).toBe('untested')
      const ready = f.ready([expected])
      expect(row(buildSessionCapabilities(f.manifest, ready), 'plugin-activation')).toMatchObject({
        verification: 'passed',
        availability: 'ready',
      })
      for (const status of ['failed', 'closed', 'closing'] as const) {
        const report = buildSessionCapabilities(f.manifest, { ...ready, status })
        expect(row(report, 'plugin-activation')).toMatchObject({
          verification: 'passed',
          availability: 'unknown',
        })
        expect(isCurrentSessionCapability(report, 'plugin-activation', report.identity)).toBe(false)
      }
    },
  )
  it('does not promote incomplete launch-secret observations or partial model checks into availability', () => {
    const f = fixture()
    f.manifest.launch.environment.SECOND = {
      kind: 'secret',
      reference: { kind: 'credential', id: 'SECOND_SECRET_REFERENCE' },
    }
    const report = buildSessionCapabilities(f.manifest, f.ready())
    expect(row(report, 'credential-resolution')).toMatchObject({
      verification: 'untested',
      availability: 'unknown',
    })
    expect(JSON.stringify(report)).not.toContain('SECOND_SECRET_REFERENCE')
  })
})
