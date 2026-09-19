import {
  chmod,
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  realpath,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DesktopSessionFactory } from '../src/main/sessions/desktop-factory'
import { RunInputStore } from '../src/main/engines/run-input-store'
import { SkillDirectoryStore } from '../src/main/assets/skill-directory-store'
import { openCodeWorkspace } from './helpers/opencode-fixture'
import { piWorkspace } from './helpers/pi-fixture'
import { createSessionSnapshot } from '../src/shared/sessions/state'
import { appError } from '../src/shared/errors'

const cleanup: { root: string; factory: DesktopSessionFactory }[] = []
async function fixture(version = '1.18.16', kind: 'opencode' | 'pi' = 'opencode') {
  const root = await mkdtemp(join(tmpdir(), 'agentmatrix-desktop-factory-'))
  const cwd = join(root, 'project'),
    home = join(root, 'home'),
    executable = join(root, kind)
  await mkdir(join(cwd, '.git'), { recursive: true })
  await mkdir(home)
  await writeFile(executable, `#!/bin/sh\nprintf '%s\\n' '${version}'\n`)
  await chmod(executable, 0o700)
  let state = kind === 'pi' ? piWorkspace(executable, cwd) : openCodeWorkspace(executable, cwd)
  state.installations[0]!.version = null
  state.installations[0]!.probedAt = null
  state.installations[0]!.modes = []
  const workspace = {
    load: vi.fn(async () => structuredClone(state)),
    save: vi.fn(async (value: typeof state) => {
      if (value.revision !== state.revision) throw appError('error.conflict')
      state = { ...structuredClone(value), revision: value.revision + 1 }
      return structuredClone(state)
    }),
  }
  const skills = new SkillDirectoryStore(join(root, 'skills')),
    runs = new RunInputStore(join(root, 'runs'), skills)
  const resolveSecret = vi.fn(async () => 'synthetic-private-value')
  const resolveSecretVersioned = vi.fn(async () => ({
    value: 'synthetic-private-value',
    resolvedAt: new Date().toISOString(),
    version: { source: 'environment' as const },
  }))
  const credentialVersions = vi.fn(async () => ({ available: true, entries: [] }))
  const factory = new DesktopSessionFactory({
    workspace,
    runs,
    skills,
    resolveSecret,
    resolveSecretVersioned,
    credentialVersions,
    dataDirectory: root,
    environment: { HOME: home, PATH: process.env.PATH },
  })
  cleanup.push({ root, factory })
  return {
    root,
    cwd,
    home,
    executable,
    workspace,
    factory,
    runs,
    resolveSecret,
    resolveSecretVersioned,
    credentialVersions,
  }
}
afterEach(async () => {
  await Promise.all(
    cleanup.splice(0).map(async ({ root, factory }) => {
      await factory.shutdown()
      await rm(root, { recursive: true, force: true })
    }),
  )
})
describe.skipIf(process.platform === 'win32')('desktop session factory', () => {
  it.each(['opencode', 'pi'] as const)(
    'captures a per-session %s directory and its native sources without changing the saved profile',
    async (kind) => {
      const f = await fixture(kind === 'pi' ? '0.85.1' : '1.18.16', kind)
      await f.factory.probe({ installationId: kind === 'pi' ? 'pi' : 'oc' })
      const selected = join(f.root, '项目 with spaces')
      const alias = join(f.root, 'project-alias')
      await mkdir(join(selected, '.git'), { recursive: true })
      await writeFile(join(selected, 'AGENTS.md'), 'Selected project instructions.')
      await symlink(selected, alias)
      const before = await f.workspace.load()
      const command = {
        kind: 'create' as const,
        commandId: 'override',
        agentId: 'reviewer',
        cwd: alias,
      }
      const first = await f.factory.create('override-session', command)
      const manifest = await f.runs.read(first.snapshotId)
      expect(first.cwd).toBe(await realpath(selected))
      expect(manifest.agent.execution.cwd).toBe(alias)
      expect(manifest.externalSources.files).toContainEqual(
        expect.objectContaining({
          path: join(await realpath(selected), 'AGENTS.md'),
          exists: true,
        }),
      )
      expect(
        manifest.externalSources.files.some((source) => source.path.startsWith(`${f.cwd}/`)),
      ).toBe(false)
      expect(await f.workspace.load()).toEqual(before)
      const edited = structuredClone(before)
      edited.agents[0]!.execution.cwd = ''
      await f.workspace.save(edited)
      expect(await f.factory.create('override-session', command)).toEqual(first)
      // An explicit directory also completes a profile whose default directory is unset.
      expect((await f.factory.create('second-session', command)).cwd).toBe(first.cwd)
      expect((await f.workspace.load()).agents[0]!.execution.cwd).toBe('')
      await writeFile(join(selected, 'AGENTS.md'), 'Changed native instructions.')
      await expect(f.factory.create('override-session', command)).rejects.toThrow(
        'runSourceChanged',
      )
      expect(f.resolveSecret).not.toHaveBeenCalled()
    },
  )
  it('rejects a non-directory before source inspection and capture', async () => {
    const f = await fixture()
    await f.factory.probe({ installationId: 'oc' })
    await expect(
      f.factory.create('file-cwd', {
        kind: 'create',
        commandId: 'file-cwd',
        agentId: 'reviewer',
        cwd: f.executable,
      }),
    ).rejects.toThrow('runtimeCwd')
    await expect(readdir(f.runs.root)).rejects.toMatchObject({ code: 'ENOENT' })
    expect(f.resolveSecret).not.toHaveBeenCalled()
  })
  it('requires an explicit version probe, saves evidence, and captures inputs without resolving secrets', async () => {
    const f = await fixture()
    const command = { kind: 'create' as const, commandId: 'create', agentId: 'reviewer' }
    await expect(f.factory.create('session-a', command)).rejects.toThrow('runConfiguration')
    expect((await f.factory.probe({ installationId: 'oc' })).installations[0]).toMatchObject({
      version: '1.18.16',
      modes: ['acp'],
    })
    const identity = await f.factory.create('session-a', command)
    const manifest = await f.runs.read(identity.snapshotId)
    expect(manifest).toMatchObject({
      cwd: await import('node:fs/promises').then((fs) => fs.realpath(f.cwd)),
      agent: { id: 'reviewer' },
    })
    expect(f.resolveSecret).not.toHaveBeenCalled()
    const report = await f.factory.configuration(
      createSessionSnapshot({ ...identity, id: 'session-a', createdAt: new Date().toISOString() }),
    )
    expect(report.fields.find((field) => field.id === 'model')).toMatchObject({
      value: 'fixture-model',
      status: 'planned',
    })
    expect(report.observation).toBeNull()
    expect(f.credentialVersions).toHaveBeenCalledTimes(1)
    expect(f.resolveSecretVersioned).not.toHaveBeenCalled()
    expect(f.workspace.save).toHaveBeenCalledTimes(1)
    expect(f.resolveSecret).not.toHaveBeenCalled()
    expect(await readdir(join(f.root, 'probes'))).toEqual([])
    expect(
      await readFile(join(f.runs.paths(identity.snapshotId).root, 'manifest.json'), 'utf8'),
    ).not.toContain('synthetic-private-value')
    await expect(
      f.factory.connect(
        {
          ...createSessionSnapshot({
            ...identity,
            id: 'session-a',
            createdAt: new Date().toISOString(),
          }),
          snapshotDigest: '0'.repeat(64),
        },
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({ code: 'configuration' })
    expect(f.resolveSecret).not.toHaveBeenCalled()
  })
  it.each(['opencode', 'pi', 'deepseek-harness'] as const)(
    'rejects known %s constraints before reading native sources or capturing run files',
    async (kind) => {
      const f = await fixture()
      const state = await f.workspace.load()
      state.installations[0] = {
        ...state.installations[0]!,
        kind,
        version: kind === 'opencode' ? '1.18.16' : kind === 'pi' ? '0.85.1' : '0.1.5-rc.2',
        modes: kind === 'pi' ? ['pi-rpc'] : ['acp'],
        probedAt: new Date().toISOString(),
        executable: join(f.root, 'missing-binary'),
      }
      state.agents[0]!.engineOptions =
        kind === 'opencode'
          ? { kind, agent: 'build' }
          : kind === 'pi'
            ? { kind }
            : { kind, profileTemplate: 'acp', patchReload: 'startup' }
      if (kind === 'opencode') state.models[0]!.parameters.reasoning = 'high'
      else if (kind === 'pi') state.agents[0]!.execution.approval = 'ask'
      else state.models[0]!.parameters.temperature = 0.5
      await f.workspace.save(state)
      const feature =
        kind === 'opencode'
          ? 'model.parameters.reasoning'
          : kind === 'pi'
            ? 'execution.universal-approval'
            : 'model.sampling'
      await expect(
        f.factory.create('blocked', { kind: 'create', commandId: 'blocked', agentId: 'reviewer' }),
      ).rejects.toThrow(feature)
      await expect(readdir(join(f.root, 'runs'))).rejects.toMatchObject({ code: 'ENOENT' })
      expect(f.resolveSecret).not.toHaveBeenCalled()
    },
  )
  it('keeps a retry on its captured revisions and lets new sessions capture library edits', async () => {
    const f = await fixture()
    await f.factory.probe({ installationId: 'oc' })
    const command = { kind: 'create' as const, commandId: 'create', agentId: 'reviewer' }
    const first = await f.factory.create('session-a', command)
    const edited = await f.workspace.load()
    edited.prompts[0]!.versions.push({ version: 2, content: 'NEW_ROLE' })
    edited.prompts[0]!.currentVersion = 2
    await f.workspace.save(edited)
    expect(await f.factory.create('session-a', command)).toEqual(first)
    const next = await f.factory.create('session-b', { ...command, commandId: 'other' })
    expect((await f.runs.read(first.snapshotId)).prompts[0]!.version).toBe(1)
    expect((await f.runs.read(next.snapshotId)).prompts[0]!.version).toBe(2)
  })
  it('does not turn unsupported versions or products into runnable installations', async () => {
    const f = await fixture('999.0.0')
    const state = await f.factory.probe({ installationId: 'oc' })
    expect(state.installations[0]).toMatchObject({ version: '999.0.0', modes: [] })
    await expect(
      f.factory.create('session-a', { kind: 'create', commandId: 'create', agentId: 'reviewer' }),
    ).rejects.toThrow()
    state.installations[0]!.kind = 'claude-code'
    await f.workspace.save(state)
    await expect(f.factory.probe({ installationId: 'oc' })).rejects.toThrow('runtimeUnsupported')
    await expect(
      f.factory.create('session-b', { kind: 'create', commandId: 'other', agentId: 'reviewer' }),
    ).rejects.toThrow('runtimeUnsupported')
  })
  it('preserves concurrent workspace changes and stops accepting probes on shutdown', async () => {
    const f = await fixture()
    f.workspace.save.mockRejectedValueOnce(appError('error.conflict'))
    await expect(f.factory.probe({ installationId: 'oc' })).rejects.toThrow('error.conflict')
    expect((await f.workspace.load()).installations[0]!.version).toBeNull()
    await f.factory.shutdown()
    await expect(f.factory.probe({ installationId: 'oc' })).rejects.toThrow('sessionStopping')
    expect(await readdir(join(f.root, 'probes'))).toEqual([])
  })
  it('probes Pi and captures its native inputs without relaxing unsupported approval policy', async () => {
    const f = await fixture('0.85.1', 'pi')
    const command = { kind: 'create' as const, commandId: 'create', agentId: 'reviewer' }
    await expect(f.factory.create('pi-unprobed', command)).rejects.toThrow()
    expect((await f.factory.probe({ installationId: 'pi' })).installations[0]).toMatchObject({
      version: '0.85.1',
      modes: ['pi-rpc'],
    })
    const identity = await f.factory.create('pi-session', command)
    expect(identity.mode).toBe('pi-rpc')
    expect(await f.runs.read(identity.snapshotId)).toMatchObject({
      installation: { kind: 'pi' },
      adapter: { id: 'pi-rpc', version: '1' },
    })
    const edited = await f.workspace.load()
    edited.agents[0]!.execution.approval = 'ask'
    await f.workspace.save(edited)
    await expect(f.factory.create('pi-approval', command)).rejects.toThrow('piConfiguration')
    expect((await f.workspace.load()).agents[0]!.execution.approval).toBe('ask')
    expect(await f.factory.create('pi-session', command)).toEqual(identity)
    expect(f.resolveSecret).not.toHaveBeenCalled()
    expect(await readdir(join(f.root, 'probes'))).toEqual([])
  })
})
