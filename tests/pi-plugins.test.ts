import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { SkillDirectoryStore } from '../src/main/assets/skill-directory-store'
import { RunInputStore } from '../src/main/engines/run-input-store'
import { planPi } from '../src/main/engines/adapters/pi/configuration'
import { inspectPiPlugin } from '../src/main/engines/adapters/pi/plugin-inspection'
import { preparePiPluginAttachment } from '../src/main/engines/adapters/pi/plugins'
import { engineConfigurationIssues } from '../src/shared/engines/validation'
import { resolveAgentProfile } from '../src/shared/engines/resolution'
import { piWorkspace } from './helpers/pi-fixture'
import bridgeSource from '../src/main/engines/adapters/pi/plugin-bridge.mjs?raw'
import type { EngineWorkspace } from '../src/shared/engines/workspace'

let root: string, installed: string, workspace: EngineWorkspace, store: RunInputStore
beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), 'agentmatrix-pi-plugins-')))
  installed = join(root, 'installed')
  await mkdir(installed)
  await writeFile(join(root, 'engine'), '#!/bin/sh\nexit 19\n', { mode: 0o700 })
  workspace = piWorkspace(join(root, 'engine'), root)
  workspace.agents[0]!.skillBindings = []
  workspace.agents[0]!.promptBindings = []
  workspace.nativePlugins = [
    {
      id: 'extension',
      name: 'Extension',
      nativeId: 'label',
      engineInstallationId: 'pi',
      version: '1.2.3',
      source: 'installed',
      path: installed,
    },
  ]
  workspace.agents[0]!.nativePluginIds = ['extension']
  await writeFile(
    join(installed, 'index.ts'),
    'throw new Error("Never execute in Electron"); export default async () => {}',
  )
  store = new RunInputStore(join(root, 'runs'), new SkillDirectoryStore(join(root, 'skills')))
})
afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})
const capture = () =>
  store.create('run', workspace, 'reviewer', (configuration, paths) =>
    planPi(configuration, paths, {
      sources: { coverage: 'complete', files: [] },
      readSkillEntry: async () => '',
    }),
  )
const metadata = (value: unknown) =>
  writeFile(join(installed, 'package.json'), JSON.stringify(value))

describe('selected Pi extension files', () => {
  it('rejects a changed relative dependency while the selected entry is unchanged', async () => {
    await writeFile(
      join(installed, 'index.ts'),
      "import { value } from './helper.ts'; export default () => value",
    )
    await writeFile(join(installed, 'helper.ts'), "export const value = 'original'")
    await capture()
    await writeFile(join(installed, 'helper.ts'), "export const value = 'changed'")
    await expect(store.verifyForReuse('run')).rejects.toThrow('error.runSourceChanged')
  })
  it('captures index and explicit multi-entry packages without evaluating factories', async () => {
    await writeFile(join(installed, 'other.ts'), 'export default async () => {}')
    await metadata({
      version: '1.2.3',
      pi: { extensions: ['./other.ts', './index.ts', './other.ts'] },
      peerDependencies: { '@earendil-works/pi-coding-agent': '^0.85.0' },
    })
    const inspected = await inspectPiPlugin(installed)
    expect(inspected.entries.map((entry) => entry.path)).toEqual([
      join(installed, 'other.ts'),
      join(installed, 'index.ts'),
    ])
    const manifest = await capture()
    expect(manifest.externalSources.coverage).toBe('partial')
    expect(manifest.launch.args.filter((arg) => arg === '--extension')).toHaveLength(2)
    expect(manifest.launch.args).toContain('--no-extensions')
    expect(manifest.files.some((file) => file.path === 'plugins/pi-bridge.js')).toBe(true)
    await writeFile(join(installed, 'other.ts'), 'export default () => {}')
    await expect(store.verifyForReuse('run')).rejects.toThrow()
  })
  it('retains absence of metadata and rejects changed resolution on resume', async () => {
    const manifest = await capture()
    expect(manifest.externalSources.files).toContainEqual({
      path: join(installed, 'package.json'),
      exists: false,
    })
    await metadata({ version: '2.0.0', pi: { extensions: ['./index.ts'] } })
    await expect(preparePiPluginAttachment(manifest, store.paths('run'))).rejects.toThrow(
      'pi.plugins',
    )
    await expect(store.verifyForReuse('run')).rejects.toThrow()
  })
  it.each([
    [{ version: '2.0.0' }, 'error.pluginVersion'],
    [
      { peerDependencies: { '@earendil-works/pi-coding-agent': '>=999.0.0' } },
      'error.piPluginRange',
    ],
    [{ peerDependencies: { '@mariozechner/pi-coding-agent': 'bad range' } }, 'error.piPluginRange'],
    [{ pi: { extensions: ['./missing.ts'] } }, 'error.pluginMissing'],
    [{ pi: { extensions: ['./*.ts'] } }, 'error.piPluginEntry'],
    [{ pi: { extensions: ['./index.ts'], skills: ['./skills'] } }, 'error.piPluginResources'],
    [{ pi: { extensions: [] } }, 'error.piPluginEntry'],
  ])('rejects incompatible or ambiguous package metadata %j', async (value, error) => {
    await metadata(value)
    await expect(capture()).rejects.toThrow(error)
  })
  it('supports linked installations but rejects a declared entry outside its package', async () => {
    const linked = join(root, 'linked')
    await symlink(installed, linked)
    expect((await inspectPiPlugin(linked)).resolvedPath).toBe(installed)
    await writeFile(join(root, 'outside.ts'), 'export default () => {}')
    await symlink(join(root, 'outside.ts'), join(installed, 'escape.ts'))
    await metadata({ pi: { extensions: ['./escape.ts'] } })
    await expect(inspectPiPlugin(installed)).rejects.toThrow('error.pluginOutside')
  })
  it.each(['-e', '--extension', '--extension=/unselected.ts'])(
    'rejects untracked extension selectors in prefix arguments: %s',
    (argument) => {
      workspace.installations[0]!.prefixArgs = [argument]
      const result = resolveAgentProfile(workspace, 'reviewer')
      if (result.status !== 'resolved') throw new Error('Invalid fixture')
      expect(engineConfigurationIssues(result.configuration)).toContainEqual({
        code: 'prefix-arguments',
        field: 'installation',
        nativeFeature: 'installation.prefixArgs',
      })
    },
  )
  it('rejects duplicate entries across bindings and incompatible tool policy', async () => {
    workspace.nativePlugins.push({ ...workspace.nativePlugins[0]!, id: 'other' })
    workspace.agents[0]!.nativePluginIds.push('other')
    await expect(capture()).rejects.toThrow('error.pluginDuplicate')
    workspace.agents[0]!.execution.approval = 'deny'
    const result = resolveAgentProfile(workspace, 'reviewer')
    if (result.status !== 'resolved') throw new Error('Invalid fixture')
    expect(engineConfigurationIssues(result.configuration)).toContainEqual({
      code: 'pi-plugin-policy',
      field: 'plugins',
      nativeFeature: 'nativePlugins.tools-policy',
    })
  })
})

type Handler = (...args: unknown[]) => unknown
interface Api {
  on(event: string, handler: Handler): void
  registerCommand(name: string, options: { description?: string; handler: Handler }): void
  tool: object
}
type Factory = (api: Api) => unknown
describe('Pi extension lifecycle receipts', () => {
  async function fixture(factory: Factory) {
    const manifest = await capture(),
      attachment = (await preparePiPluginAttachment(manifest, store.paths('run')))!
    const bindings = JSON.parse(
      await readFile(join(store.paths('run').inputs, 'plugins/pi-bindings.json'), 'utf8'),
    )
    const binding = { ...bindings[0].entries[0], identity: bindings[0].identity }
    const handlers = new Map<string, Handler[]>(),
      commands: { name: string; source: string; description?: string; handler: Handler }[] = []
    const api: Api = {
      tool: {},
      on(event, handler) {
        handlers.set(event, [...(handlers.get(event) ?? []), handler])
      },
      registerCommand(name, options) {
        commands.push({ name, source: 'extension', ...options })
      },
    }
    const source = bridgeSource
      .replace(
        'process.env.AGENT_MATRIX_PI_PLUGIN_NONCE',
        JSON.stringify(attachment.environment.AGENT_MATRIX_PI_PLUGIN_NONCE),
      )
      .replace(
        'process.env.AGENT_MATRIX_PI_PLUGIN_RECEIPTS',
        JSON.stringify(attachment.environment.AGENT_MATRIX_PI_PLUGIN_RECEIPTS),
      )
    const module = (await import(
      /* @vite-ignore */ `data:text/javascript;base64,${Buffer.from(source).toString('base64')}`
    )) as { activate(factory: Factory, api: Api, binding: unknown): Promise<void> }
    let session = { sessionId: 'current-session', sessionFile: '/current/session.jsonl' }
    const context = () => ({
      cwd: root,
      sessionManager: {
        getSessionId: () => session.sessionId,
        getSessionFile: () => session.sessionFile,
      },
    })
    const emit = async (event: string, payload: unknown = {}) => {
      for (const handler of handlers.get(event) ?? []) {
        try {
          await handler(payload, context())
        } catch {
          /* native emits an error and continues */
        }
      }
    }
    const client = { request: async () => ({ commands }) }
    return {
      attachment,
      api,
      commands,
      emit,
      client,
      session: () => session,
      switchTo: (next: typeof session) => {
        session = next
      },
      activate: () => module.activate(factory, api, binding),
    }
  }
  it('awaits async factories, keeps API members and event results, and ties readiness to the current session', async () => {
    const calls: string[] = []
    let tools: unknown
    const f = await fixture(async (api) => {
      await Promise.resolve()
      tools = api.tool
      calls.push('factory')
      api.on('session_start', () => {
        calls.push('first')
      })
      api.on('session_start', () => {
        calls.push('second')
      })
    })
    await f.activate()
    expect(tools).toBe(f.api.tool)
    await expect(f.attachment.verify(f.client, process.pid, f.session())).rejects.toThrow(
      'pi.plugins',
    )
    await f.emit('session_start')
    expect(await f.attachment.verify(f.client, process.pid, f.session())).toBe(0)
    expect(calls).toEqual(['factory', 'first', 'second'])
    await f.emit('session_shutdown')
    await expect(f.attachment.verify(f.client, process.pid, f.session())).rejects.toThrow(
      'pi.plugins',
    )
    f.switchTo({ sessionId: 'restored-session', sessionFile: '/restored/session.jsonl' })
    await f.emit('session_start')
    await f.attachment.verify(f.client, process.pid, f.session())
    await expect(
      f.attachment.verify(f.client, process.pid, {
        sessionId: 'current-session',
        sessionFile: '/current/session.jsonl',
      }),
    ).rejects.toThrow('pi.plugins')
    await expect(f.attachment.verify(f.client, process.pid + 1, f.session())).rejects.toThrow(
      'pi.plugins',
    )
  })
  it.each(['factory', 'session_start', 'resources_discover'])(
    'rejects swallowed %s failures',
    async (stage) => {
      const f = await fixture((api) => {
        if (stage === 'factory') throw new Error('synthetic')
        api.on(stage, () => {
          throw new Error('synthetic')
        })
      })
      try {
        await f.activate()
      } catch {
        /* rejected below */
      }
      await f.emit('session_start')
      await f.emit('resources_discover')
      await expect(f.attachment.verify(f.client, process.pid, f.session())).rejects.toThrow(
        'pi.plugins',
      )
    },
  )
  it('records extension-only input and completed commands without equating registration to execution', async () => {
    const f = await fixture((api) => {
      api.on('input', () => ({ action: 'handled' }))
      api.registerCommand('command', {
        handler() {
          return 'done'
        },
      })
    })
    await f.activate()
    await f.emit('session_start')
    expect(await f.attachment.verify(f.client, process.pid, f.session())).toBe(0)
    await f.emit('input')
    expect(await f.attachment.verify(f.client, process.pid, f.session())).toBe(1)
    await f.commands.find((command) => command.name === 'command')!.handler()
    expect(await f.attachment.verify(f.client, process.pid, f.session())).toBe(2)
    f.commands.find((command) => command.name.startsWith('agentmatrix-witness-'))!.description =
      'stale'
    await expect(f.attachment.verify(f.client, process.pid, f.session())).rejects.toThrow(
      'pi.plugins',
    )
  })
})
