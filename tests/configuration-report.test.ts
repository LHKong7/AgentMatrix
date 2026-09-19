import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { buildConfigurationReport } from '../src/main/engines/configuration-report'
import { RunInputStore } from '../src/main/engines/run-input-store'
import { SkillDirectoryStore } from '../src/main/assets/skill-directory-store'
import { planOpenCode } from '../src/main/engines/adapters/opencode/configuration'
import { openCodeWorkspace } from './helpers/opencode-fixture'
import { createSessionSnapshot, applySessionEvent } from '../src/shared/sessions/state'
import {
  configurationChecksSchema,
  configurationDiagnosticSchema,
  type ConfigurationCheck,
} from '../src/shared/engines/configuration-report'
import { sessionFailureSchema, sessionSnapshotSchema } from '../src/shared/sessions/schema'
import { SessionJournal } from '../src/main/sessions/journal'
import { observeResourceDirectory } from '../src/main/engines/external-sources'
import { observeInstructionSearches } from '../src/main/engines/instruction-sources'

const roots: string[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})
async function fixture(credential = false, mcp = false) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'agentmatrix-config-report-')))
  roots.push(root)
  const cwd = join(root, 'project'),
    executable = join(root, 'opencode')
  await mkdir(cwd)
  await writeFile(executable, 'Never executed by this fixture.')
  const workspace = openCodeWorkspace(executable, cwd)
  if (mcp) {
    workspace.mcpServers = [
      {
        id: 'http',
        name: 'Captured HTTP',
        description: '',
        enabled: true,
        transport: 'streamable-http',
        url: 'https://private.invalid/SECRET',
        headers: {},
        secretHeaders: {},
        auth: { kind: 'none' },
      },
    ]
    workspace.agents[0]!.mcpServerIds = ['http']
  }
  if (credential)
    workspace.connections[0]!.auth = {
      kind: 'bearer',
      secret: { kind: 'credential', id: 'private-vault-reference' },
    }
  const store = new RunInputStore(join(root, 'runs'), new SkillDirectoryStore(join(root, 'skills')))
  const manifest = await store.create('inputs', workspace, 'reviewer', (configuration, paths) =>
    planOpenCode(configuration, paths, {
      configHome: join(root, 'config'),
      sources: { coverage: 'partial', files: [{ path: join(cwd, 'AGENTS.md'), exists: false }] },
      readSkillEntry: async () => {
        throw new Error('Unexpected Skill directory')
      },
    }),
  )
  const initial = createSessionSnapshot({
    id: 'session',
    agentId: manifest.agent.id,
    installationId: manifest.installation.id,
    engineVersion: manifest.installation.version!,
    mode: manifest.launch.mode,
    cwd: manifest.cwd,
    snapshotId: manifest.id,
    snapshotDigest: manifest.digest,
    createdAt: manifest.createdAt,
  })
  const ready = (checks?: ConfigurationCheck[]) => {
    const starting = applySessionEvent(initial, {
      sessionId: initial.id,
      cursor: 1,
      timestamp: initial.createdAt,
      runId: 'run',
      turnId: null,
      data: { kind: 'run.starting' },
    })
    return applySessionEvent(starting, {
      sessionId: initial.id,
      cursor: 2,
      timestamp: initial.createdAt,
      runId: 'run',
      turnId: null,
      data: {
        kind: 'run.ready',
        nativeSessionId: 'native-id',
        ...(checks ? { configurationChecks: checks } : {}),
      },
    })
  }
  return { root, manifest, workspace, initial, ready, store }
}
describe('configuration report evidence and updates', () => {
  it('preserves attachment MCP evidence across restart and failed resume, then replaces it on successful resume', async () => {
    const f = await fixture(false, true),
      directory = join(f.root, 'journal')
    const journal = new SessionJournal(directory)
    await journal.create(f.initial)
    await journal.append('session', 0, {
      runId: 'run',
      turnId: null,
      data: { kind: 'run.starting' },
    })
    const checkedAt = f.initial.createdAt
    await journal.append('session', 1, {
      runId: 'run',
      turnId: null,
      data: {
        kind: 'run.ready',
        nativeSessionId: 'native-id',
        configurationChecks: ['opencode.instance-config'],
        mcpConnections: { source: 'opencode-acp', checkedAt, statuses: ['connected'] },
      },
    })
    const restarted = new SessionJournal(directory)
    const previous = await restarted.get('session')
    f.workspace.mcpServers[0]!.name = 'Edited library label'
    const report = buildConfigurationReport(f.manifest, previous, f.workspace)
    expect(report.mcp).toEqual({
      source: 'opencode-acp',
      checkedAt,
      entries: [
        { slot: 0, name: 'Captured HTTP', transport: 'streamable-http', status: 'connected' },
      ],
    })
    expect(report.observationIsCurrent).toBe(false)
    expect(report.observation).not.toHaveProperty('mcpConnections')
    expect(JSON.stringify(report.mcp)).not.toContain('SECRET')
    await restarted.append('session', previous.cursor, {
      runId: 'failed-resume',
      turnId: null,
      data: { kind: 'run.resuming' },
    })
    const resuming = await restarted.get('session')
    await restarted.append('session', resuming.cursor, {
      runId: 'failed-resume',
      turnId: null,
      data: { kind: 'run.failed', failure: { code: 'engine', detail: '' } },
    })
    const failed = await restarted.get('session')
    expect(buildConfigurationReport(f.manifest, failed, f.workspace).mcp).toEqual(report.mcp)
    await restarted.append('session', failed.cursor, {
      runId: 'resume',
      turnId: null,
      data: { kind: 'run.resuming' },
    })
    const next = await restarted.get('session')
    await restarted.append('session', next.cursor, {
      runId: 'resume',
      turnId: null,
      data: {
        kind: 'run.ready',
        nativeSessionId: 'native-id',
        configurationChecks: ['opencode.instance-config'],
        mcpConnections: {
          source: 'opencode-acp',
          checkedAt: new Date().toISOString(),
          statuses: ['authentication-required'],
        },
      },
    })
    const current = buildConfigurationReport(
      f.manifest,
      await restarted.get('session'),
      f.workspace,
    )
    expect(current.observationIsCurrent).toBe(true)
    expect(current.observation?.runId).toBe('resume')
    expect(current.mcp.entries[0]!.status).toBe('authentication-required')
    const older = f.ready(['opencode.config'])
    expect(buildConfigurationReport(f.manifest, older, f.workspace).mcp).toMatchObject({
      source: 'unknown',
      checkedAt: null,
      entries: [{ status: 'unknown' }],
    })
  })
  it('preserves instance configuration scope and historical ownership without upgrading old receipts', async () => {
    const f = await fixture()
    const old = buildConfigurationReport(f.manifest, f.ready(['opencode.config']), f.workspace)
    expect(old.fields.find((field) => field.id === 'prompts')!.checks).toEqual(['opencode.config'])
    const state = f.ready(['opencode.config', 'opencode.instance-config', 'opencode.session-model'])
    state.status = 'interrupted'
    const report = buildConfigurationReport(f.manifest, state, f.workspace)
    expect(report.observationIsCurrent).toBe(false)
    expect(report.fields.find((field) => field.id === 'prompts')!.checks).toEqual([
      'opencode.instance-config',
    ])
    expect(report.fields.find((field) => field.id === 'model')!.checks).toEqual([
      'opencode.instance-config',
      'opencode.session-model',
    ])
    expect(
      report.capabilities.capabilities.find((item) => item.feature === 'prompt-mapping'),
    ).toMatchObject({ checks: ['opencode.instance-config'], availability: 'unknown' })
    expect(report.capabilities.current).toBe(false)
  })
  it('keeps Skill source evidence scoped to its engine, process, and recorded attachment', async () => {
    const f = await fixture()
    const sources = (checks: ConfigurationCheck[]) =>
      buildConfigurationReport(f.manifest, f.ready(checks), f.workspace)
    expect(
      sources(['pi.skill-sources'])
        .assets.filter((asset) => asset.kind === 'skill')
        .every((asset) => asset.nativeSourceVerification === 'unknown'),
    ).toBe(true)
    expect(
      sources(['opencode.config'])
        .assets.filter((asset) => asset.kind === 'skill')
        .every((asset) => asset.nativeSourceVerification === 'unknown'),
    ).toBe(true)
    const session = f.ready(['opencode.config', 'opencode.skill-sources'])
    session.status = 'interrupted'
    const historical = buildConfigurationReport(f.manifest, session, f.workspace)
    expect(historical.observationIsCurrent).toBe(false)
    expect(
      historical.assets
        .filter((asset) => asset.kind === 'skill')
        .every((asset) => asset.nativeSourceVerification === 'opencode-probe'),
    ).toBe(true)
    expect(historical.fields.find((field) => field.id === 'skills')?.checks).not.toContain(
      'opencode.instance-skills',
    )
    const current = sources(['opencode.config', 'opencode.instance-skills'])
    expect(current.observationIsCurrent).toBe(true)
    expect(
      current.assets
        .filter((asset) => asset.kind === 'skill')
        .map((asset) => asset.nativeSourceVerification),
    ).toEqual(f.manifest.skills.map(() => 'opencode-acp'))
    expect(current.fields.find((field) => field.id === 'skills')?.checks).toContain(
      'opencode.instance-skills',
    )
    const interrupted = f.ready(['opencode.instance-skills'])
    interrupted.status = 'interrupted'
    const recorded = buildConfigurationReport(f.manifest, interrupted, f.workspace)
    expect(recorded.observationIsCurrent).toBe(false)
    expect(
      recorded.assets
        .filter((asset) => asset.kind === 'skill')
        .every((asset) => asset.nativeSourceVerification === 'opencode-acp'),
    ).toBe(true)
    expect(
      historical.assets
        .filter((asset) => asset.kind === 'prompt')
        .every((asset) => asset.nativeSourceVerification === null),
    ).toBe(true)
    f.manifest.installation.kind = 'pi'
    expect(
      sources(['opencode.instance-skills'])
        .assets.filter((asset) => asset.kind === 'skill')
        .every((asset) => asset.nativeSourceVerification === 'unknown'),
    ).toBe(true)
    expect(
      sources(['pi.skills', 'pi.skill-sources'])
        .assets.filter((asset) => asset.kind === 'skill')
        .every((asset) => asset.nativeSourceVerification === 'pi-rpc'),
    ).toBe(true)
    f.manifest.installation.kind = 'deepseek-harness'
    expect(
      sources(['dsh.composition'])
        .assets.filter((asset) => asset.kind === 'skill')
        .every((asset) => asset.nativeSourceVerification === 'unknown'),
    ).toBe(true)
    const dsh = sources(['dsh.composition', 'dsh.skill-sources'])
    expect(
      dsh.assets
        .filter((asset) => asset.kind === 'skill')
        .every((asset) => asset.nativeSourceVerification === 'dsh-registry'),
    ).toBe(true)
    expect(dsh.fields.find((field) => field.id === 'skills')?.checks).toContain('dsh.skill-sources')
    expect(
      sources(['pi.skill-sources', 'opencode.skill-sources', 'opencode.instance-skills'])
        .assets.filter((asset) => asset.kind === 'skill')
        .every((asset) => asset.nativeSourceVerification === 'unknown'),
    ).toBe(true)
  })
  it('keeps failed field checks separate from historical successes and clears rejection on retry', async () => {
    const f = await fixture()
    const ready = f.ready(['opencode.config'])
    const interrupted = applySessionEvent(ready, {
      sessionId: ready.id,
      cursor: 3,
      timestamp: ready.createdAt,
      runId: ready.runId,
      turnId: null,
      data: { kind: 'run.interrupted', failure: { code: 'interrupted', detail: '' } },
    })
    const resuming = applySessionEvent(interrupted, {
      sessionId: ready.id,
      cursor: 4,
      timestamp: ready.createdAt,
      runId: 'retry',
      turnId: null,
      data: { kind: 'run.resuming' },
    })
    const diagnostic = {
      check: 'opencode-config' as const,
      reason: 'mismatch' as const,
      fields: ['prompts' as const],
    }
    const failed = applySessionEvent(resuming, {
      sessionId: ready.id,
      cursor: 5,
      timestamp: ready.createdAt,
      runId: 'retry',
      turnId: null,
      data: {
        kind: 'run.failed',
        failure: { code: 'configuration', detail: '', configuration: diagnostic },
      },
    })
    const report = buildConfigurationReport(f.manifest, failed, f.workspace)
    expect(report.diagnostic).toEqual(diagnostic)
    expect(report.observationIsCurrent).toBe(false)
    expect(report.observation?.runId).toBe(ready.runId)
    expect(report.fields.find((field) => field.id === 'prompts')).toMatchObject({
      rejected: true,
      status: 'observed',
    })
    expect(report.fields.filter((field) => field.rejected).map((field) => field.id)).toEqual([
      'prompts',
    ])
    const retry = applySessionEvent(failed, {
      sessionId: ready.id,
      cursor: 6,
      timestamp: ready.createdAt,
      runId: 'retry-again',
      turnId: null,
      data: { kind: 'run.resuming' },
    })
    const pending = buildConfigurationReport(f.manifest, retry, f.workspace)
    expect(pending.diagnostic).toBeNull()
    expect(pending.fields.some((field) => field.rejected)).toBe(false)
  })

  it('rejects unknown or value-bearing diagnostic metadata', () => {
    const valid = { check: 'pi-state', reason: 'mismatch', fields: ['model'] }
    expect(configurationDiagnosticSchema.safeParse(valid).success).toBe(true)
    expect(
      sessionFailureSchema.safeParse({ code: 'engine', detail: '', configuration: valid }).success,
    ).toBe(false)
    expect(
      sessionFailureSchema.safeParse({ code: 'configuration', detail: '', configuration: valid })
        .success,
    ).toBe(true)
    for (const invalid of [
      { ...valid, expected: 'PRIVATE_KEY' },
      { ...valid, fields: ['model', 'model'] },
      { ...valid, fields: ['provider.PRIVATE_KEY'] },
      { ...valid, check: 'PRIVATE_NATIVE_CHECK' },
    ])
      expect(configurationDiagnosticSchema.safeParse(invalid).success).toBe(false)
  })
  it('retains captured asset versions after the library item and binding are removed', async () => {
    const f = await fixture()
    f.workspace.prompts = f.workspace.prompts.filter((asset) => asset.id !== 'role')
    f.workspace.agents[0]!.promptBindings = f.workspace.agents[0]!.promptBindings.filter(
      (binding) => binding.assetId !== 'role',
    )
    const report = buildConfigurationReport(f.manifest, f.ready(), f.workspace)
    expect(report.savedState).toBe('pending')
    expect(report.assets.find((asset) => asset.id === 'role')).toMatchObject({
      version: 1,
      libraryVersion: null,
      nextVersion: null,
      digest: expect.stringMatching(/^[a-f0-9]{64}$/),
    })
    expect(report.assets.find((asset) => asset.kind === 'skill')?.digest).toMatch(/^[a-f0-9]{64}$/)
  })
  it('does not infer Pi authentication, prompt loading, or tool policy from model state', async () => {
    const f = await fixture()
    f.manifest.installation.kind = 'pi'
    f.manifest.agent.engineOptions = { kind: 'pi', thinkingLevel: 'high' }
    const report = buildConfigurationReport(
      f.manifest,
      f.ready(['pi.state', 'pi.skills']),
      f.workspace,
    )
    expect(report.fields.find((field) => field.id === 'connection')?.status).toBe('observed')
    for (const id of ['authentication', 'execution', 'prompts'])
      expect(report.fields.find((field) => field.id === id)?.status).toBe('unknown')
    expect(report.fields.find((field) => field.id === 'reasoning')).toMatchObject({
      status: 'observed',
      value: 'high',
    })
  })
  it('keeps generated and legacy sessions unverified without inventing observations', async () => {
    const f = await fixture()
    const report = buildConfigurationReport(f.manifest, f.initial, f.workspace)
    expect(report.savedState).toBe('same')
    expect(report.fields.every((field) => field.status === 'planned')).toBe(true)
    expect(report.observation).toBeNull()
    expect(report.resourceDirectories).toBeNull()
    expect(report.instructionSources).toBeNull()
    expect(report.retainedCredentialRedaction).toBe(false)
    expect(buildConfigurationReport(f.manifest, f.ready(), f.workspace).observation).toBeNull()
    expect(report.sources).toEqual([
      { path: join(f.manifest.cwd, 'AGENTS.md'), exists: false, digest: null },
    ])
  })
  it('retains captured instruction metadata without reading changed or deleted sources', async () => {
    const f = await fixture(),
      file = join(f.root, 'rule.md')
    await writeFile(file, 'PRIVATE_NATIVE_INSTRUCTION')
    const searches = [{ cwd: f.root, pattern: 'rule.md', dot: true }]
    f.manifest.externalSources.instructionSources = {
      version: 1,
      patterns: [
        {
          source: join(f.root, 'opencode.json'),
          index: 0,
          searches,
          files: await observeInstructionSearches(searches),
        },
      ],
      unobserved: [{ source: join(f.root, 'opencode.json'), index: 1, reason: 'remote' }],
    }
    await rm(file)
    const report = buildConfigurationReport(f.manifest, f.initial, f.workspace)
    expect(report.instructionSources).toEqual(f.manifest.externalSources.instructionSources)
    expect(JSON.stringify(report)).not.toContain('PRIVATE_NATIVE_INSTRUCTION')
    report.instructionSources!.patterns.splice(0)
    expect(f.manifest.externalSources.instructionSources.patterns).toHaveLength(1)
  })
  it('projects historical directory metadata without Markdown, native application claims, or filesystem rescans', async () => {
    const f = await fixture()
    const directory = join(f.root, 'agents')
    await mkdir(directory)
    const file = join(directory, 'reviewer.md')
    await writeFile(file, 'PRIVATE_NATIVE_BODY')
    f.manifest.externalSources.directories = [
      await observeResourceDirectory(directory, 'opencode-agent'),
      await observeResourceDirectory(join(f.root, 'modes'), 'opencode-mode'),
    ]
    await rm(directory, { recursive: true })
    const report = buildConfigurationReport(f.manifest, f.initial, f.workspace)
    expect(report.resourceDirectories).toEqual([
      {
        path: directory,
        kind: 'opencode-agent',
        exists: true,
        resolvedPath: directory,
        files: [
          {
            path: file,
            resolvedPath: file,
            exists: true,
            digest: expect.stringMatching(/^[a-f0-9]{64}$/),
          },
        ],
      },
      {
        path: join(f.root, 'modes'),
        kind: 'opencode-mode',
        exists: false,
        resolvedPath: null,
        files: [],
      },
    ])
    expect(JSON.stringify(report)).not.toContain('PRIVATE_NATIVE_BODY')
    expect(report.fields.every((field) => field.status === 'planned')).toBe(true)
    f.manifest.externalSources.directories = []
    expect(
      buildConfigurationReport(f.manifest, f.initial, f.workspace).resourceDirectories,
    ).toEqual([])
  })

  it('only labels fields covered by recorded native checks and omits sensitive configuration', async () => {
    const f = await fixture()
    f.manifest.connection.baseUrl =
      'https://login:URL_KEY@example.invalid/private-key-path?key=QUERY_KEY#TOKEN'
    f.manifest.connection.headers.Authorization = 'HEADER_KEY'
    f.manifest.launch.environment.PRIVATE = { kind: 'literal', value: 'ENV_KEY' }
    const report = buildConfigurationReport(
      f.manifest,
      f.ready(['cli.version', 'opencode.config', 'opencode.session-model']),
      f.workspace,
    )
    expect(report.fields.find((field) => field.id === 'model')).toMatchObject({
      status: 'observed',
      value: 'fixture-model',
      checks: ['opencode.config', 'opencode.session-model'],
    })
    expect(report.fields.find((field) => field.id === 'reasoning')?.status).toBe('unknown')
    expect(report.fields.find((field) => field.id === 'sampling')?.status).toBe('unknown')
    expect(report.fields.find((field) => field.id === 'connection')?.value).toContain(
      'https://example.invalid',
    )
    const text = JSON.stringify(report)
    for (const secret of [
      'URL_KEY',
      'private-key-path',
      'QUERY_KEY',
      'TOKEN',
      'HEADER_KEY',
      'ENV_KEY',
      'ROLE_MARKER',
      'APPEND_MARKER',
      'SKILL_MARKER',
      'PROBE_KEY',
    ])
      expect(text).not.toContain(secret)
    expect(report.observationIsCurrent).toBe(true)
  })
  it('keeps DSH composition evidence separate from session selection and unknown policy enforcement', async () => {
    const f = await fixture()
    f.manifest.installation.kind = 'deepseek-harness'
    const report = buildConfigurationReport(
      f.manifest,
      f.ready(['dsh.composition', 'dsh.session-model']),
      f.workspace,
    )
    expect(report.fields.find((field) => field.id === 'model')?.status).toBe('observed')
    for (const id of ['connection', 'execution', 'prompts', 'skills', 'mcp'])
      expect(report.fields.find((field) => field.id === id)?.status).toBe('composition')
    expect(report.fields.find((field) => field.id === 'reasoning')?.status).toBe('unknown')
  })
  it('compares resolved bindings while preserving old versions and digests', async () => {
    const f = await fixture(),
      before = JSON.stringify(f.manifest)
    f.workspace.prompts[0]!.versions.push({ version: 2, content: 'NEW_ROLE' })
    f.workspace.prompts[0]!.currentVersion = 2
    f.workspace.revision++
    const report = buildConfigurationReport(f.manifest, f.ready(['opencode.config']), f.workspace)
    expect(report.savedState).toBe('pending')
    expect(report.fields.find((field) => field.id === 'prompts')?.changed).toBe(true)
    expect(report.assets.find((asset) => asset.id === 'role')).toMatchObject({
      version: 1,
      nextVersion: 2,
      libraryVersion: 2,
      source: 'agent',
    })
    f.workspace.agents[0]!.promptBindings[0]!.selection = { follow: 'pinned', version: 1 }
    const pinned = buildConfigurationReport(f.manifest, f.ready(), f.workspace)
    expect(pinned.savedState).toBe('same')
    expect(pinned.assets.find((asset) => asset.id === 'role')).toMatchObject({
      version: 1,
      nextVersion: 1,
      libraryVersion: 2,
    })
    expect(JSON.stringify(f.manifest)).toBe(before)
    expect(await f.store.read('inputs')).toEqual(f.manifest)
  })
  it('honors direct binding overrides instead of reporting a shadowed bundle as pending', async () => {
    const f = await fixture()
    f.workspace.prompts[0]!.versions.push({ version: 2, content: 'NEW_ROLE' })
    f.workspace.prompts[0]!.currentVersion = 2
    f.workspace.agents[0]!.promptBindings[0]!.selection = { follow: 'pinned', version: 1 }
    f.workspace.bundles.push({
      id: 'bundle',
      version: '1.0.0',
      name: 'Bundle',
      description: '',
      enabled: true,
      promptBindings: [{ assetId: 'role', selection: { follow: 'latest' }, mode: 'replace' }],
      skillBindings: [],
      mcpServerIds: [],
    })
    f.workspace.agents[0]!.bundleIds = ['bundle']
    expect(buildConfigurationReport(f.manifest, f.ready(), f.workspace).savedState).toBe('same')
  })
  it('reports removed or unresolved profiles without losing captured assets', async () => {
    const f = await fixture()
    f.workspace.agents[0]!.modelProfileId = null
    expect(buildConfigurationReport(f.manifest, f.ready(), f.workspace)).toMatchObject({
      savedState: 'draft',
      assets: expect.arrayContaining([
        expect.objectContaining({ id: 'role', version: 1, nextVersion: null }),
      ]),
    })
    f.workspace.agents = []
    expect(buildConfigurationReport(f.manifest, f.ready(), f.workspace).savedState).toBe('missing')
  })
  it('does not treat metadata-only edits as changes to executable inputs', async () => {
    const f = await fixture()
    f.workspace.installations[0]!.probedAt = new Date().toISOString()
    f.workspace.connections[0]!.name = 'Renamed connection'
    f.workspace.agents[0]!.name = 'Renamed agent'
    expect(buildConfigurationReport(f.manifest, f.ready(), f.workspace).savedState).toBe('same')
    f.workspace.connections[0]!.auth = {
      kind: 'bearer',
      secret: { kind: 'environment', name: 'NEW_KEY' },
    }
    expect(
      buildConfigurationReport(f.manifest, f.ready(), f.workspace).fields.find(
        (field) => field.id === 'connection',
      )?.changed,
    ).toBe(true)
  })
  it('rejects mismatched identity and evidence instead of displaying another session as verified', async () => {
    const f = await fixture(),
      state = f.ready(['cli.version'])
    expect(() =>
      buildConfigurationReport(
        f.manifest,
        { ...state, snapshotDigest: '0'.repeat(64) },
        f.workspace,
      ),
    ).toThrow('report.identity')
    expect(() =>
      buildConfigurationReport(
        f.manifest,
        { ...state, configuration: { ...state.configuration!, nativeSessionId: 'another' } },
        f.workspace,
      ),
    ).toThrow('report.evidence')
    expect(
      sessionSnapshotSchema.safeParse({
        ...state,
        configuration: { ...state.configuration!, snapshotDigest: '0'.repeat(64) },
      }).success,
    ).toBe(false)
    expect(configurationChecksSchema.safeParse(['cli.version', 'cli.version']).success).toBe(false)
    expect(configurationChecksSchema.safeParse(['raw-secret-config']).success).toBe(false)
  })
  it('retains bounded observations across journal restart and replaces them only after successful resume', async () => {
    const f = await fixture(true),
      journal = new SessionJournal(join(f.root, 'journal'))
    await journal.create(f.initial)
    await journal.append('session', 0, {
      runId: 'run',
      turnId: null,
      data: { kind: 'run.starting' },
    })
    await journal.append('session', 1, {
      runId: 'run',
      turnId: null,
      data: {
        kind: 'run.ready',
        nativeSessionId: 'native-id',
        configurationChecks: ['cli.version', 'opencode.session-model'],
        nativeRuntime: { protocol: 'acp', version: 1, restoration: 'resume', restored: false },
        credentialResolutions: [
          {
            slot: 1,
            resolvedAt: f.initial.createdAt,
            version: {
              source: 'vault',
              versionId: '10000000-0000-4000-8000-000000000001',
              revision: 1,
              updatedAt: f.initial.createdAt,
            },
          },
        ],
      },
    })
    const restarted = new SessionJournal(join(f.root, 'journal'))
    const interrupted = await restarted.get('session')
    expect(interrupted.status).toBe('interrupted')
    expect(interrupted.configuration?.checks).toEqual(['cli.version', 'opencode.session-model'])
    expect(interrupted.configuration?.nativeRuntime?.restored).toBe(false)
    expect(interrupted.configuration?.credentialResolutions?.[0]?.version).toMatchObject({
      revision: 1,
    })
    expect(
      buildConfigurationReport(f.manifest, interrupted, f.workspace).observationIsCurrent,
    ).toBe(false)
    await restarted.append('session', interrupted.cursor, {
      runId: 'new-run',
      turnId: null,
      data: { kind: 'run.resuming' },
    })
    const resuming = await restarted.get('session')
    expect(buildConfigurationReport(f.manifest, resuming, f.workspace).observationIsCurrent).toBe(
      false,
    )
    await restarted.append('session', resuming.cursor, {
      runId: 'new-run',
      turnId: null,
      data: {
        kind: 'run.ready',
        nativeSessionId: 'native-id',
        configurationChecks: ['cli.version'],
        nativeRuntime: { protocol: 'acp', version: 1, restoration: 'resume', restored: true },
        credentialResolutions: [
          {
            slot: 1,
            resolvedAt: f.initial.createdAt,
            version: {
              source: 'vault',
              versionId: '10000000-0000-4000-8000-000000000002',
              revision: 2,
              updatedAt: f.initial.createdAt,
            },
          },
        ],
      },
    })
    const resumed = await restarted.get('session')
    expect(resumed.configuration?.credentialResolutions?.[0]?.version).toMatchObject({
      revision: 2,
    })
    const report = buildConfigurationReport(f.manifest, resumed, f.workspace, undefined, {
      available: true,
      entries: [
        {
          id: 'private-vault-reference',
          versionId: '10000000-0000-4000-8000-000000000002',
          revision: 2,
          updatedAt: f.initial.createdAt,
        },
      ],
    })
    expect(report.credentials.entries[0]).toMatchObject({
      state: 'same',
      attachment: { revision: 2 },
      current: { revision: 2 },
    })
    expect(JSON.stringify(report)).not.toContain('private-vault-reference')
    expect(report.observation).not.toHaveProperty('credentialResolutions')
    expect(
      report.capabilities.capabilities.find((row) => row.feature === 'native-restore'),
    ).toMatchObject({ verification: 'passed', availability: 'ready' })
    expect((await restarted.get('session')).configuration).toMatchObject({
      runId: 'new-run',
      checks: ['cli.version'],
    })
  })
})
