import { mkdir, mkdtemp, readFile, realpath, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { SkillDirectoryStore } from '../src/main/assets/skill-directory-store'
import { RunInputStore } from '../src/main/engines/run-input-store'
import { planOpenCode } from '../src/main/engines/adapters/opencode/configuration'
import { prepareOpenCodePluginAttachment } from '../src/main/engines/adapters/opencode/plugins'
import { pluginExportNames } from '../src/main/engines/adapters/opencode/plugin-exports'
import bridgeSource from '../src/main/engines/adapters/opencode/plugin-bridge.mjs?raw'
import { openCodeWorkspace } from './helpers/opencode-fixture'
import { capturedOpenCodeConfiguration } from '../src/main/engines/adapters/opencode/readback'
import { resolveAgentProfile } from '../src/shared/engines/resolution'
import { engineConfigurationIssues } from '../src/shared/engines/validation'
import { nativePluginSchema } from '../src/shared/engines/workspace'
import type { EngineWorkspace } from '../src/shared/engines/workspace'
import type { SessionConfigOption } from '@agentclientprotocol/sdk'

let root: string, workspace: EngineWorkspace, store: RunInputStore
beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), 'agentmatrix-plugin-bridge-')))
  await mkdir(join(root, 'installed'))
  await writeFile(join(root, 'engine'), '#!/bin/sh\nexit 19\n', { mode: 0o700 })
  workspace = openCodeWorkspace(join(root, 'engine'), root)
  workspace.agents[0]!.skillBindings = []
  workspace.agents[0]!.promptBindings = []
  workspace.nativePlugins = [
    {
      id: 'binding',
      name: 'Plugin',
      engineInstallationId: 'oc',
      nativeId: 'example',
      version: '1.2.3',
      source: 'installed',
      path: join(root, 'installed', 'entry.mjs'),
    },
  ]
  workspace.agents[0]!.nativePluginIds = ['binding']
  await writeFile(
    workspace.nativePlugins[0]!.path,
    'throw new Error("Must never execute in Electron"); export default async function plugin() {}',
  )
  store = new RunInputStore(join(root, 'runs'), new SkillDirectoryStore(join(root, 'skills')))
})
afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})
const capture = () =>
  store.create('run', workspace, 'reviewer', (configuration, paths) =>
    planOpenCode(configuration, paths, {
      configHome: join(root, 'config'),
      sources: { coverage: 'complete', files: [] },
      readSkillEntry: async () => '',
    }),
  )
type Hooks = {
  config(config: { agent: { build: { description?: string } } }): Promise<void>
  dispose(): Promise<void>
  [key: string]: unknown
}
type Input = { directory: string }
type Initializer = (input: Input, options?: unknown) => Promise<Hooks>
type Binding = { id: string; nativeId: string; identity: string; exports: string[] }
interface Bridge {
  bind(
    module: Record<string, unknown>,
    binding: Binding,
  ): Record<string, Initializer & { server: Initializer }>
  sentinel(input: Input, agentName: string): Hooks
}
async function loadBridge(environment: Record<string, string>): Promise<Bridge> {
  const source = bridgeSource
    .replace(
      'process.env.AGENT_MATRIX_PLUGIN_NONCE',
      JSON.stringify(environment.AGENT_MATRIX_PLUGIN_NONCE),
    )
    .replace(
      'process.env.AGENT_MATRIX_PLUGIN_RECEIPTS',
      JSON.stringify(environment.AGENT_MATRIX_PLUGIN_RECEIPTS),
    )
  return import(
    /* @vite-ignore */ `data:text/javascript;base64,${Buffer.from(source).toString('base64')}`
  )
}

describe('OpenCode export planning', () => {
  it('captures native tuple options as literal data and preserves old configuration on reuse', async () => {
    const config = {
      marker: 'original',
      nested: [false, 0, null, { text: '中文 {env:PRIVATE} {file:missing.txt}' }],
      '{env:PRIVATE}': '{file:missing.txt}',
    }
    workspace.nativePlugins[0] = nativePluginSchema.parse({
      ...workspace.nativePlugins[0],
      options: { kind: 'opencode', config },
    })
    const manifest = await capture()
    const nativeText = await readFile(join(store.paths('run').inputs, 'opencode.json'), 'utf8')
    const native = JSON.parse(nativeText)
    expect(native.plugin[0]).toEqual([expect.stringContaining('binding-1.mjs'), config])
    expect(native.plugin[1]).toContain('sentinel.mjs')
    expect(nativeText).not.toMatch(/\{(?:env:PRIVATE|file:missing\.txt)\}/)
    const environment = Object.fromEntries(
      Object.keys(manifest.launch.environment).map((name) => [name, 'fixture']),
    )
    const readback = await capturedOpenCodeConfiguration(manifest, store.paths('run'), environment)
    expect((readback as { plugin: unknown }).plugin).toEqual(native.plugin)
    workspace.nativePlugins[0]!.options!.config.marker = 'edited'
    expect((await store.verifyForReuse('run')).nativePlugins[0]!.options!.config).toEqual(config)
    const attachment = await prepareOpenCodePluginAttachment(manifest, store.paths('run'))
    await attachment!.cleanup()
    const resolved = resolveAgentProfile(workspace, 'reviewer')
    if (resolved.status !== 'resolved') throw new Error('Invalid fixture')
    expect(engineConfigurationIssues(resolved.configuration)).toEqual([])
    resolved.configuration.installation.kind = 'pi'
    expect(engineConfigurationIssues(resolved.configuration)).toContainEqual(
      expect.objectContaining({ code: 'native-plugin-options' }),
    )
  })
  it('enumerates aliases, destructuring, runtime declarations and named reexports without execution', () => {
    expect(
      pluginExportNames(
        `export default async function () {}; export const {a, b: [B]} = value; export {other as Alias} from './other'; export * as group from './group'; export enum Mode {A}; export namespace Tools {export const x=1}`,
      ),
    ).toEqual(['Alias', 'Mode', 'Tools', 'a', 'default', 'B', 'group'].sort())
  })
  it('omits type-only exports, interfaces and ambient declarations', () => {
    expect(
      pluginExportNames(
        `import type {T} from './types'; interface I {}; type A = T; declare const C: number; export {T, I, A, C}; export type {T as U}; export interface Z {}; export default async () => ({})`,
      ),
    ).toEqual(['default'])
  })
  it.each([
    'export * from "./other"',
    'module.exports = () => ({})',
    'export = plugin',
    'export type T = string',
    'export const !broken = true',
  ])('rejects unknown module shapes: %s', (source) => {
    expect(() => pluginExportNames(source)).toThrow('error.pluginExports')
  })
  it('captures projections and source identity without executing entry code', async () => {
    const manifest = await capture()
    expect(manifest.externalSources.coverage).toBe('partial')
    expect(manifest.externalSources.files).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: workspace.nativePlugins[0]!.path, exists: true }),
        { path: join(root, 'installed/package.json'), exists: false },
      ]),
    )
    const native = JSON.parse(
      await readFile(join(store.paths('run').inputs, 'opencode.json'), 'utf8'),
    )
    expect(native.plugin).toHaveLength(2)
    expect(native.plugin[0]).toContain('binding-1.mjs')
    expect(native.plugin[1]).toContain('sentinel.mjs')
    await writeFile(workspace.nativePlugins[0]!.path, 'export default async () => ({})')
    await expect(store.verifyForReuse('run')).rejects.toThrow()
    await expect(prepareOpenCodePluginAttachment(manifest, store.paths('run'))).rejects.toThrow(
      'native.plugins',
    )
  })
  it.each([
    [{ version: '2.0.0' }, 'error.pluginVersion'],
    [{ version: '1.2.3', engines: { opencode: '>=999' } }, 'error.pluginRange'],
    [{ version: '1.2.3', engines: { opencode: 'broken range' } }, 'error.pluginRange'],
  ])('rejects incompatible package declarations %j', async (metadata, error) => {
    await writeFile(
      join(root, 'installed/package.json'),
      JSON.stringify({ ...metadata, main: './entry.mjs' }),
    )
    await expect(capture()).rejects.toThrow(error)
  })
  it('rejects duplicate resolved entries', async () => {
    workspace.nativePlugins.push({ ...workspace.nativePlugins[0]!, id: 'other' })
    workspace.agents[0]!.nativePluginIds.push('other')
    await expect(capture()).rejects.toThrow('error.pluginDuplicate')
  })
})

describe('OpenCode attachment evidence', () => {
  async function fixture() {
    const manifest = await capture()
    const attachment = (await prepareOpenCodePluginAttachment(manifest, store.paths('run')))!
    const bindings: Binding[] = JSON.parse(
      await readFile(join(store.paths('run').inputs, 'plugins/opencode-bindings.json'), 'utf8'),
    )
    const bridge = await loadBridge(attachment.environment)
    const input = { directory: root }
    const config = { agent: { build: { description: 'Existing description' } } }
    const modes = (): SessionConfigOption[] => [
      {
        id: 'mode',
        type: 'select',
        name: 'Mode',
        currentValue: 'build',
        options: [{ value: 'build', name: 'Build', description: config.agent.build.description }],
      },
    ]
    return { manifest, attachment, binding: bindings[0]!, bridge, input, config, modes }
  }
  it('preserves alias identity, separate frozen hooks and options, and rejects disposal', async () => {
    const { attachment, binding, bridge, input, config, modes } = await fixture()
    const toolA = {},
      toolB = {},
      options = { value: 17 },
      calls: string[] = []
    const alpha = async (_input: Input, given: unknown) => {
      expect(given).toBe(options)
      const hooks = Object.freeze({
        tool: toolA,
        value: 'alpha',
        config() {
          expect(this).toBe(hooks)
          calls.push(this.value)
        },
        dispose() {
          calls.push('dispose-a')
        },
      })
      return hooks
    }
    const beta = async () =>
      Object.freeze({
        tool: toolB,
        config() {
          calls.push('beta')
        },
      })
    const projection = bridge.bind(
      { Alpha: alpha, Alias: alpha, Beta: beta },
      { ...binding, exports: ['Alias', 'Alpha', 'Beta'] },
    )
    expect(projection.Alias).toBe(projection.Alpha)
    const a = await projection.Alpha!(input, options),
      b = await projection.Beta!(input)
    expect(a.tool).toBe(toolA)
    expect(b.tool).toBe(toolB)
    await a.config(config)
    await b.config(config)
    await bridge.sentinel(input, 'build').config(config)
    expect(config.agent.build.description).toMatch(/^Existing description\n\[AgentMatrix/)
    await attachment.verify(process.pid, modes())
    expect(calls).toEqual(['alpha', 'beta'])
    await a.dispose()
    await expect(attachment.verify(process.pid)).rejects.toThrow('native.plugins')
    await attachment.cleanup()
  })
  it('selects V1 over unrelated exports and preserves the server receiver', async () => {
    const { attachment, binding, bridge, input, config, modes } = await fixture()
    const original = Object.freeze({
      id: 'example',
      server() {
        expect(this).toBe(original)
        return Object.freeze({})
      },
    })
    const module = bridge.bind(
      { default: original, metadata: 'ignored' },
      { ...binding, exports: ['default', 'metadata'] },
    )
    const hooks = await module.default!.server(input)
    await hooks.config(config)
    await bridge.sentinel(input, 'build').config(config)
    await attachment.verify(process.pid, modes())
  })
  it('replaces its own previous marker when native instances reuse the config object', async () => {
    const { attachment, binding, bridge, input, config, modes } = await fixture()
    const projection = bridge.bind({ default: async () => ({}) }, binding)
    await (await projection.default!(input)).config(config)
    await bridge.sentinel(input, 'build').config(config)
    const previousModes = modes()
    const nextInput = { directory: root }
    const nextHooks = await projection.default!(nextInput)
    await nextHooks.config(config)
    await bridge.sentinel(nextInput, 'build').config(config)
    expect(config.agent.build.description.match(/AgentMatrix plugin instance/g)).toHaveLength(1)
    expect(config.agent.build.description).toContain('Existing description')
    expect(modes()).not.toEqual(previousModes)
    await attachment.verify(process.pid, modes())
    await nextHooks.dispose()
    await expect(attachment.verify(process.pid)).rejects.toThrow('native.plugins')
  })
  it('invalidates a previously successful receipt when a later config hook fails', async () => {
    const { attachment, binding, bridge, input, config, modes } = await fixture()
    let fail = false
    const projection = bridge.bind(
      {
        default: async () => ({
          config() {
            if (fail) throw new Error('late failure')
          },
        }),
      },
      binding,
    )
    const hooks = await projection.default!(input)
    await hooks.config(config)
    await bridge.sentinel(input, 'build').config(config)
    await attachment.verify(process.pid, modes())
    fail = true
    await expect(hooks.config(config)).rejects.toThrow('late failure')
    await expect(attachment.verify(process.pid)).rejects.toThrow('native.plugins')
  })
  it.each([
    'initialization',
    'configuration',
    'missing',
    'wrong-id',
    'wrong-pid',
    'stale-instance',
    'stale-attachment',
  ])('does not acknowledge %s evidence', async (failure) => {
    const { manifest, attachment, binding, bridge, input, config, modes } = await fixture()
    const initializer = async () => {
      if (failure === 'initialization') throw new Error('synthetic error')
      return {
        config() {
          if (failure === 'configuration') throw new Error('synthetic error')
        },
      }
    }
    if (failure === 'wrong-id')
      expect(() =>
        bridge.bind({ default: { id: 'wrong', server: initializer } }, binding),
      ).toThrow()
    else if (failure !== 'missing') {
      const projection = bridge.bind({ default: initializer }, binding)
      try {
        await (await projection.default!(input)).config(config)
      } catch {
        /* assert failed receipt below */
      }
    }
    await bridge
      .sentinel(failure === 'stale-instance' ? { directory: root } : input, 'build')
      .config(config)
    if (failure === 'stale-attachment') {
      const next = (await prepareOpenCodePluginAttachment(manifest, store.paths('run')))!
      await expect(next.verify(process.pid, modes())).rejects.toThrow('native.plugins')
      await next.cleanup()
    } else
      await expect(
        attachment.verify(failure === 'wrong-pid' ? process.pid + 1 : process.pid, modes()),
      ).rejects.toThrow('native.plugins')
    await attachment.cleanup()
    expect(await readdir(store.paths('run').state)).not.toContain(
      basename(attachment.environment.AGENT_MATRIX_PLUGIN_RECEIPTS),
    )
  })
})
