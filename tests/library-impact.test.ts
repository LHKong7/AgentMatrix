import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { prepareLibraryImpact, type LibraryChange } from '../src/shared/engines/impact'
import { revisePrompt, reviseMarkdownSkill } from '../src/shared/engines/editing'
import { openCodeWorkspace } from './helpers/opencode-fixture'
import { previewLibraryImpact } from '../src/main/engines/library-impact'
import { RunInputStore } from '../src/main/engines/run-input-store'
import { SkillDirectoryStore } from '../src/main/assets/skill-directory-store'
import { planOpenCode } from '../src/main/engines/adapters/opencode/configuration'
import { createSessionSnapshot } from '../src/shared/sessions/state'
import { DesktopSessionFactory } from '../src/main/sessions/desktop-factory'
import { SessionCoordinator } from '../src/main/sessions/coordinator'
import { SessionJournal } from '../src/main/sessions/journal'
import type { EngineWorkspace } from '../src/shared/engines/workspace'

const roots: string[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})
const baseline = () => openCodeWorkspace('/fixture/opencode', '/fixture/project')
const promptChange = (workspace: EngineWorkspace): LibraryChange => ({
  collection: 'prompts',
  entry: revisePrompt(workspace.prompts[0]!, 'NEW_ROLE_SECRET'),
})
const queryFor = (workspace: EngineWorkspace) => ({
  revision: workspace.revision,
  change: promptChange(workspace),
})
const bundleFor = (workspace: EngineWorkspace) => ({
  id: 'bundle',
  name: 'Bundle',
  description: '',
  enabled: true,
  version: '1.0.0',
  promptBindings: [structuredClone(workspace.agents[0]!.promptBindings[0]!)],
  skillBindings: [],
  mcpServerIds: [],
})

describe('library impact binding resolution', () => {
  it('finds shared Prompt changes across OpenCode, Pi and DSH without changing source data', () => {
    const workspace = baseline()
    for (const kind of ['pi', 'deepseek-harness'] as const) {
      workspace.installations.push({
        ...workspace.installations[0]!,
        id: kind,
        kind,
        modes: kind === 'pi' ? ['pi-rpc'] : ['acp'],
      })
      workspace.agents.push({
        ...structuredClone(workspace.agents[0]!),
        id: kind,
        engineInstallationId: kind,
        engineOptions:
          kind === 'pi' ? { kind } : { kind, profileTemplate: 'acp', patchReload: 'startup' },
      })
    }
    const previous = structuredClone(workspace)
    const impact = prepareLibraryImpact(workspace, queryFor(workspace))
    expect(impact.profiles.map((profile) => [profile.id, profile.effect, profile.fields])).toEqual([
      ['reviewer', 'changed', ['prompts']],
      ['pi', 'changed', ['prompts']],
      ['deepseek-harness', 'changed', ['prompts']],
    ])
    impact.proposed.prompts[0]!.name = 'Detached draft'
    expect(workspace).toEqual(previous)
  })
  it('honors pinned bindings, disabled bundles and direct-over-bundle overrides', () => {
    const workspace = baseline(),
      direct = workspace.agents[0]!
    workspace.bundles.push(bundleFor(workspace))
    workspace.agents.push({
      ...structuredClone(direct),
      id: 'bundled',
      bundleIds: ['bundle'],
      promptBindings: [],
    })
    workspace.agents.push({ ...structuredClone(direct), id: 'shadowed', bundleIds: ['bundle'] })
    workspace.agents[2]!.promptBindings[0]!.selection = { follow: 'pinned', version: 1 }
    const result = () =>
      prepareLibraryImpact(workspace, queryFor(workspace)).profiles.map((profile) => profile.effect)
    expect(result()).toEqual(['changed', 'changed', 'unchanged'])
    workspace.bundles[0]!.enabled = false
    expect(result()).toEqual(['changed', 'unchanged', 'unchanged'])
  })
  it('distinguishes unresolved, newly blocked, and newly resolved bindings', () => {
    const workspace = baseline()
    workspace.bundles.push(bundleFor(workspace), {
      ...bundleFor(workspace),
      id: 'peer',
      promptBindings: [{ assetId: 'role', mode: 'append', selection: { follow: 'latest' } }],
    })
    workspace.agents[0]!.bundleIds = ['bundle', 'peer']
    workspace.agents[0]!.promptBindings = []
    expect(prepareLibraryImpact(workspace, queryFor(workspace)).profiles[0]).toMatchObject({
      effect: 'unresolved',
      issues: ['binding-conflict'],
    })
    const fixed = prepareLibraryImpact(workspace, {
      revision: workspace.revision,
      change: { collection: 'bundles', entry: { ...workspace.bundles[1], enabled: false } },
    })
    expect(fixed.profiles[0]!.effect).toBe('resolved')
    const blocked = prepareLibraryImpact(fixed.proposed, {
      revision: workspace.revision,
      change: { collection: 'bundles', entry: workspace.bundles[1] },
    })
    expect(blocked.profiles[0]!.effect).toBe('blocked')
    workspace.agents[0]!.enabled = false
    expect(prepareLibraryImpact(workspace, queryFor(workspace)).profiles[0]!.issues).toContain(
      'agent-disabled',
    )
  })
  it('compares endpoint and credential references but ignores connection display names', () => {
    const workspace = baseline(),
      connection = workspace.connections[0]!
    const preview = (entry: typeof connection) =>
      prepareLibraryImpact(workspace, {
        revision: workspace.revision,
        change: { collection: 'connections', entry },
      }).profiles[0]!
    expect(preview({ ...connection, name: 'Renamed' }).effect).toBe('unchanged')
    expect(preview({ ...connection, baseUrl: 'https://example.invalid/v2' }).fields).toEqual([
      'connection',
    ])
    expect(
      preview({
        ...connection,
        auth: { kind: 'bearer', secret: { kind: 'environment', name: 'ROTATED_KEY' } },
      }).fields,
    ).toEqual(['connection', 'authentication'])
    expect(preview({ ...connection, protocol: null }).effect).toBe('blocked')
  })
  it('includes model selection, installation invalidation, MCP union and native plugin ownership', () => {
    const workspace = baseline()
    const preview = (change: LibraryChange) =>
      prepareLibraryImpact(workspace, { revision: workspace.revision, change }).profiles[0]!
    expect(
      preview({ collection: 'models', entry: { ...workspace.models[0]!, modelId: 'new-model' } })
        .fields,
    ).toEqual(['model'])
    expect(
      preview({
        collection: 'installations',
        entry: { ...workspace.installations[0]!, version: null, probedAt: null, modes: [] },
      }).effect,
    ).toBe('blocked')
    workspace.mcpServers.push({
      id: 'mcp',
      name: 'MCP',
      description: '',
      enabled: true,
      transport: 'stdio',
      command: 'fixture',
      args: [],
      cwd: '',
      environment: {},
      envRefs: {},
    })
    workspace.bundles.push({ ...bundleFor(workspace), mcpServerIds: ['mcp'] })
    workspace.agents[0]!.bundleIds = ['bundle']
    workspace.agents[0]!.mcpServerIds = ['mcp']
    expect(
      preview({ collection: 'bundles', entry: { ...workspace.bundles[0]!, mcpServerIds: [] } })
        .effect,
    ).toBe('unchanged')
    expect(
      preview({ collection: 'mcpServers', entry: { ...workspace.mcpServers[0]!, enabled: false } })
        .fields,
    ).toEqual(['mcp'])
    workspace.nativePlugins.push({
      id: 'plugin',
      name: 'Plugin',
      engineInstallationId: 'oc',
      nativeId: 'fixture',
      source: '',
      version: '1',
      path: '/fixture/plugin',
    })
    workspace.agents[0]!.nativePluginIds = ['plugin']
    expect(
      preview({
        collection: 'nativePlugins',
        entry: { ...workspace.nativePlugins[0]!, version: '2' },
      }).fields,
    ).toEqual(['plugins'])
    workspace.installations.push({ ...workspace.installations[0]!, id: 'other' })
    expect(
      preview({
        collection: 'nativePlugins',
        entry: { ...workspace.nativePlugins[0]!, engineInstallationId: 'other' },
      }).effect,
    ).toBe('blocked')
  })
  it('tracks immutable Markdown and directory Skill revisions without exposing their content', () => {
    const workspace = baseline(),
      skill = workspace.skills[0]!
    const entry = reviseMarkdownSkill(skill, 'NEW_SKILL_SECRET')
    const impact = prepareLibraryImpact(workspace, {
      revision: workspace.revision,
      change: { collection: 'skills', entry },
    })
    expect(impact.profiles[0]!.fields).toEqual(['skills'])
    entry.currentVersion = 3
    entry.versions.push({
      version: 3,
      kind: 'directory',
      digest: '1'.repeat(64),
      files: [{ path: 'SKILL.md', sha256: '2'.repeat(64), bytes: 5, executable: false }],
    })
    expect(
      prepareLibraryImpact(workspace, {
        revision: workspace.revision,
        change: { collection: 'skills', entry },
      }).profiles[0]!.effect,
    ).toBe('changed')
    workspace.agents[0]!.skillBindings[0]!.selection = { follow: 'pinned', version: 1 }
    expect(
      prepareLibraryImpact(workspace, {
        revision: workspace.revision,
        change: { collection: 'skills', entry },
      }).profiles[0]!.effect,
    ).toBe('unchanged')
    expect(JSON.stringify(impact.profiles)).not.toContain('NEW_SKILL_SECRET')
  })
  it('rejects stale revision, rewritten history and arbitrary query fields', () => {
    const workspace = baseline()
    expect(() => prepareLibraryImpact(workspace, { ...queryFor(workspace), revision: 0 })).toThrow(
      'conflict',
    )
    const entry = structuredClone(workspace.prompts[0]!)
    entry.versions[0]!.content = 'tampered'
    expect(() =>
      prepareLibraryImpact(workspace, {
        revision: workspace.revision,
        change: { collection: 'prompts', entry },
      }),
    ).toThrow('assetHistory')
    expect(() =>
      prepareLibraryImpact(workspace, { ...queryFor(workspace), cwd: '/arbitrary' }),
    ).toThrow()
  })
})

async function capturedFixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'agentmatrix-impact-')))
  roots.push(root)
  const cwd = join(root, 'project'),
    executable = join(root, 'opencode')
  await mkdir(cwd)
  await writeFile(executable, 'This file cannot execute.')
  const workspace = openCodeWorkspace(executable, cwd)
  const skills = new SkillDirectoryStore(join(root, 'skills'))
  const runs = new RunInputStore(join(root, 'runs'), skills)
  const manifest = await runs.create('inputs', workspace, 'reviewer', (configuration, paths) =>
    planOpenCode(configuration, paths, {
      configHome: join(root, 'config'),
      sources: { coverage: 'partial', files: [] },
      readSkillEntry: async () => {
        throw new Error('Unexpected directory')
      },
    }),
  )
  const snapshot = createSessionSnapshot({
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
  const saved = { load: vi.fn(async () => workspace), save: vi.fn() }
  const resolveSecret = vi.fn(async () => {
    throw new Error('No credential reads')
  })
  const factory = new DesktopSessionFactory({
    workspace: saved,
    runs,
    skills,
    resolveSecret,
    dataDirectory: root,
    environment: {},
  })
  return { root, workspace, runs, manifest, snapshot, saved, factory, resolveSecret }
}

describe('desktop library impact and retained captures', () => {
  it('previews through the production factory without writes, credential resolution or native launch', async () => {
    const f = await capturedFixture(),
      before = structuredClone(f.workspace)
    const report = await f.factory.impact(queryFor(f.workspace), [f.snapshot])
    expect(report.sessions[0]).toMatchObject({
      effect: 'pending',
      alreadyPending: false,
      fields: ['prompts'],
      assets: expect.arrayContaining([
        { kind: 'prompt', id: 'role', capturedVersion: 1, proposedVersion: 2 },
      ]),
    })
    expect(report.sessionScope).toBe('desktop')
    expect(f.saved.save).not.toHaveBeenCalled()
    expect(f.resolveSecret).not.toHaveBeenCalled()
    expect(f.workspace).toEqual(before)
    expect(await f.runs.read('inputs')).toEqual(f.manifest)
    for (const value of ['ROLE_MARKER', 'NEW_ROLE_SECRET', 'PROBE_KEY', f.manifest.cwd])
      expect(JSON.stringify(report)).not.toContain(value)
  })
  it('includes captures after a profile binding or the profile itself was removed', async () => {
    const f = await capturedFixture()
    f.workspace.agents[0]!.promptBindings = f.workspace.agents[0]!.promptBindings.filter(
      (binding) => binding.assetId !== 'role',
    )
    const report = await f.factory.impact(queryFor(f.workspace), [f.snapshot])
    expect(report.profiles).toEqual([])
    expect(report.sessions[0]).toMatchObject({
      effect: 'pending',
      alreadyPending: true,
      assets: expect.arrayContaining([
        { kind: 'prompt', id: 'role', capturedVersion: 1, proposedVersion: null },
      ]),
    })
    f.workspace.agents = []
    expect((await f.factory.impact(queryFor(f.workspace), [f.snapshot])).sessions[0]!.effect).toBe(
      'unresolved',
    )
  })
  it('preserves uncertainty for corrupt captures and mismatched session identity; excludes closed sessions', async () => {
    const f = await capturedFixture()
    const mismatched = { ...f.snapshot, id: 'mismatch', snapshotDigest: '0'.repeat(64) }
    const closed = { ...f.snapshot, id: 'closed', status: 'closed' as const }
    expect(
      (await f.factory.impact(queryFor(f.workspace), [mismatched, closed])).sessions.map(
        (session) => [session.id, session.effect],
      ),
    ).toEqual([['mismatch', 'unavailable']])
    await writeFile(
      join(f.root, 'runs', 'inputs', 'inputs', f.manifest.prompts[0]!.path),
      'corrupted',
    )
    expect((await f.factory.impact(queryFor(f.workspace), [f.snapshot])).sessions[0]!.effect).toBe(
      'unavailable',
    )
  })
  it('bounds capture reads per page including unrelated sessions and advances the stable ID cursor', async () => {
    const f = await capturedFixture()
    const unrelated = { ...f.manifest, agent: { ...f.manifest.agent, id: 'other' }, prompts: [] }
    const runs = { read: vi.fn(async () => unrelated) }
    const snapshots = Array.from({ length: 23 }, (_, index) => ({
      ...f.snapshot,
      id: `session-${String(index).padStart(2, '0')}`,
      agentId: 'other',
    })).reverse()
    const first = await previewLibraryImpact(queryFor(f.workspace), snapshots, f.saved, runs)
    expect(first).toMatchObject({ sessions: [], scannedSessions: 20, nextSessionId: 'session-19' })
    expect(runs.read).toHaveBeenCalledTimes(20)
    const next = await previewLibraryImpact(
      { ...queryFor(f.workspace), afterSessionId: first.nextSessionId! },
      snapshots,
      f.saved,
      runs,
    )
    expect(next).toMatchObject({ sessions: [], scannedSessions: 3, nextSessionId: null })
    expect(runs.read).toHaveBeenCalledTimes(23)
  })
  it('rejects a workspace change during capture reads instead of returning stale impact', async () => {
    const f = await capturedFixture()
    f.saved.load
      .mockResolvedValueOnce(f.workspace)
      .mockResolvedValueOnce({ ...f.workspace, revision: 2 })
    await expect(f.factory.impact(queryFor(f.workspace), [f.snapshot])).rejects.toThrow('conflict')
  })
  it('validates coordinator queries and reports all journaled open captures', async () => {
    const f = await capturedFixture(),
      journal = new SessionJournal(join(f.root, 'journal'))
    await journal.create(f.snapshot)
    const coordinator = new SessionCoordinator(journal, f.factory)
    await expect(
      coordinator.impact({ ...queryFor(f.workspace), afterSessionId: '../escape' }),
    ).rejects.toThrow()
    expect((await coordinator.impact(queryFor(f.workspace))).sessions[0]!.id).toBe(f.snapshot.id)
  })
})
