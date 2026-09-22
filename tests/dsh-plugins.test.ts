import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { SkillDirectoryStore } from '../src/main/assets/skill-directory-store'
import { RunInputStore } from '../src/main/engines/run-input-store'
import { planDsh } from '../src/main/engines/adapters/dsh/configuration'
import {
  parseDshYaml,
  type DshComposition,
  type DshRow,
} from '../src/main/engines/adapters/dsh/composition'
import { inspectDshPlugin } from '../src/main/engines/adapters/dsh/plugin-inspection'
import {
  dshPluginFrameworkVersions,
  prepareDshPluginAttachment,
} from '../src/main/engines/adapters/dsh/plugins'
import { pluginConfigurationSchema } from '../src/shared/engines/plugin-options'
import { engineConfigurationIssues } from '../src/shared/engines/validation'
import { resolveAgentProfile } from '../src/shared/engines/resolution'
import { dshWorkspace } from './helpers/dsh-fixture'
import monitorSource from '../src/main/engines/adapters/dsh/plugin-monitor.mjs?raw'

let root: string,
  installed: string,
  executable: string,
  workspace: ReturnType<typeof dshWorkspace>,
  store: RunInputStore,
  composition: DshComposition
const disposers: (() => void)[] = []
beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), 'agentmatrix-dsh-plugins-unit-')))
  for (const [name, version] of Object.entries(dshPluginFrameworkVersions)) {
    const directory = join(root, 'node_modules', name)
    await mkdir(join(directory, 'lib'), { recursive: true })
    await writeFile(
      join(directory, 'package.json'),
      JSON.stringify({
        name,
        version,
        type: 'module',
        main: 'lib/index.js',
        exports: { '.': './lib/index.js', './package.json': './package.json' },
      }),
    )
    await writeFile(
      join(directory, 'lib/index.js'),
      'throw new Error("Do not execute engine fixtures");',
    )
    if (name === '@deepseek-ai/dsh')
      await writeFile(join(directory, 'lib/bin.js'), 'Not an executable', { mode: 0o700 })
  }
  executable = join(root, 'node_modules/@deepseek-ai/dsh/lib/bin.js')
  installed = join(root, 'installed')
  await mkdir(installed)
  await writeFile(
    join(installed, 'index.cjs'),
    'throw new Error("Do not evaluate plugin entries");',
  )
  await writeFile(
    join(installed, 'package.json'),
    JSON.stringify({ version: '1.2.3', main: 'index.cjs' }),
  )
  workspace = dshWorkspace(executable, root)
  workspace.agents[0]!.skillBindings = []
  workspace.agents[0]!.promptBindings = []
  workspace.nativePlugins = [
    {
      id: 'plugin',
      nativeId: 'fixture-plugin',
      name: 'Fixture',
      version: '1.2.3',
      source: 'installed',
      path: installed,
      engineInstallationId: 'dsh',
      options: { kind: 'deepseek-harness', config: { marker: 'literal $HOME {{text}}' } },
    },
  ]
  workspace.agents[0]!.nativePluginIds = ['plugin']
  composition = {
    rows: [
      'acp',
      'agent-default-model',
      'llm-deepseek',
      'llm-pi-ai',
      'settings',
      'credentials',
      'session-telemetry-otel',
      'hmr',
      'sandbox-policy',
      'approval',
      'permission',
      'system-prompt',
      'skill-filesystem',
    ].map((id) => ({ id, name: '@deepseek-ai/dsh-test' })),
    entries: { '@deepseek-ai/dsh-test': executable },
    components: [],
    sources: { coverage: 'partial', files: [] },
  }
  store = new RunInputStore(join(root, 'runs'), new SkillDirectoryStore(join(root, 'skills')))
})
afterEach(async () => {
  for (const dispose of disposers.splice(0).reverse()) dispose()
  await rm(root, { recursive: true, force: true })
})
const capture = (id = 'run') =>
  store.create(id, workspace, 'reviewer', (configuration, paths) =>
    planDsh(configuration, paths, { composition, readSkillEntry: async () => '' }),
  )
const metadata = (value: unknown) =>
  writeFile(join(installed, 'package.json'), JSON.stringify(value))

describe('installed DSH plugin capture', () => {
  it('resolves conditional import exports and leaves executable code unevaluated', async () => {
    await writeFile(join(installed, 'chosen.mjs'), 'export default () => {}')
    await metadata({
      version: '1.2.3',
      main: 'missing.js',
      exports: {
        '.': { require: './missing.cjs', node: { import: './chosen.mjs' }, default: './index.cjs' },
      },
      peerDependencies: { '@deepseek-ai/dsh': '0.1.5-rc.2', '@deepseek-ai/cordis': '^4.0.0' },
    })
    const inspection = await inspectDshPlugin(installed)
    expect(inspection.entry.resolvedPath).toBe(join(installed, 'chosen.mjs'))
    const manifest = await capture()
    expect(manifest.externalSources.coverage).toBe('partial')
    expect(composition.sources.files).toEqual([])
    const rows = (
      parseDshYaml(
        await readFile(join(store.paths('run').inputs, 'profile/cordis.patch.yml'), 'utf8'),
      ) as { insert: DshRow[] }[]
    )[0]!.insert
    expect(rows.find((row) => row.id === 'fixture-plugin')).toMatchObject({
      config: { marker: 'literal $HOME {{text}}' },
    })
    expect(rows.at(-1)?.id).toBe('agentmatrix-plugins')
  })
  it('captures nearest package boundaries for explicit entries and rejects source drift', async () => {
    await mkdir(join(installed, 'lib'))
    const file = join(installed, 'lib/plugin.mjs')
    await writeFile(file, 'export default () => {}')
    workspace.nativePlugins[0]!.path = file
    const inspected = await inspectDshPlugin(file)
    expect(inspected.packageVersion).toBe('1.2.3')
    expect(inspected.metadata).toContainEqual({
      path: join(installed, 'lib/package.json'),
      exists: false,
    })
    const manifest = await capture()
    await writeFile(join(installed, 'lib/package.json'), '{}')
    await expect(store.verifyForReuse('run')).rejects.toThrow()
    await expect(prepareDshPluginAttachment(manifest, store.paths('run'))).rejects.toThrow(
      'dsh.plugins',
    )
  })
  it('supports linked package directories while rejecting an escaped entry', async () => {
    await symlink(installed, join(root, 'linked'))
    expect((await inspectDshPlugin(join(root, 'linked'))).resolvedPath).toBe(installed)
    await writeFile(join(root, 'outside.cjs'), 'exports.apply = () => {}')
    await metadata({ main: '../outside.cjs' })
    await expect(inspectDshPlugin(installed)).rejects.toThrow('error.pluginOutside')
  })
  it('keeps separate instances of a module and rejects conflicting row identities', async () => {
    workspace.nativePlugins.push({
      ...workspace.nativePlugins[0]!,
      id: 'second',
      nativeId: 'second-plugin',
      options: { kind: 'deepseek-harness', config: { marker: 'second' } },
    })
    workspace.agents[0]!.nativePluginIds.push('second')
    await capture()
    workspace.nativePlugins[1]!.nativeId = 'acp'
    await expect(capture('bad')).rejects.toThrow('error.dshPluginId')
  })
  it.each([
    [{ version: '2.0.0', main: 'index.cjs' }, 'error.pluginVersion'],
    [
      { version: '1.2.3', main: 'index.cjs', peerDependencies: { '@deepseek-ai/cordis': '>=999' } },
      'error.dshPluginRange',
    ],
    [{ exports: ['./index.cjs'] }, 'error.dshPluginEntry'],
    [{ exports: { '.': './index.cjs', import: './index.cjs' } }, 'error.dshPluginEntry'],
    [{ main: 'missing.js' }, 'error.pluginMissing'],
  ])('rejects invalid installed metadata %j', async (value, error) => {
    await metadata(value)
    await expect(capture()).rejects.toThrow(error)
  })
  it('rejects patch bundles and unverified framework versions', async () => {
    const patch = join(installed, 'cordis.patch.yml')
    await writeFile(patch, '[]')
    await expect(capture()).rejects.toThrow('error.dshPluginBundle')
    await rm(patch)
    const path = join(root, 'node_modules/@deepseek-ai/cordis/package.json')
    const pkg = JSON.parse(await readFile(path, 'utf8'))
    pkg.version = '999.0.0'
    await writeFile(path, JSON.stringify(pkg))
    await expect(capture()).rejects.toThrow('error.dshPluginFramework')
  })
  it('preserves old plugin configuration and rejects options for a different engine', async () => {
    const captured = await capture()
    workspace.nativePlugins[0]!.options!.config.marker = 'edited'
    expect((await store.read('run')).nativePlugins).toEqual(captured.nativePlugins)
    const resolved = resolveAgentProfile(workspace, 'reviewer')
    if (resolved.status !== 'resolved') throw new Error('Invalid fixture')
    resolved.configuration.installation.kind = 'pi'
    expect(
      engineConfigurationIssues(resolved.configuration).some(
        (issue) => issue.code === 'native-plugin-options',
      ),
    ).toBe(true)
  })
})
describe('bounded plain plugin configuration', () => {
  it('accepts nested literal data without interpreting expressions', () => {
    expect(
      pluginConfigurationSchema.parse({
        items: [1, true, null, { text: 'process.env.KEY {{text}}' }],
      }),
    ).toEqual({ items: [1, true, null, { text: 'process.env.KEY {{text}}' }] })
  })
  it.each([
    { __jsExpr: 'process.exit()' },
    JSON.parse('{"__proto__":{}}'),
    { value: Infinity },
    { value: 'x'.repeat(16_385) },
    [],
    null,
  ])('rejects invalid or executable data %j', (value) =>
    expect(pluginConfigurationSchema.safeParse(value).success).toBe(false),
  )
  it('rejects cycles, accessors, and excessive depth', () => {
    const cycle: { self?: unknown } = {}
    cycle.self = cycle
    expect(pluginConfigurationSchema.safeParse(cycle).success).toBe(false)
    expect(
      pluginConfigurationSchema.safeParse({
        get value() {
          throw new Error('must not read')
        },
      }).success,
    ).toBe(false)
    let value: unknown = {}
    for (let i = 0; i < 15; i++) value = { child: value }
    expect(pluginConfigurationSchema.safeParse(value).success).toBe(false)
  })
  it('limits total configuration to 64 KiB of UTF-8, including multibyte text', () => {
    const valid = { first: '界'.repeat(10_000), second: '界'.repeat(10_000) }
    const oversized = { ...valid, third: '界'.repeat(2_000) }
    expect(pluginConfigurationSchema.safeParse(valid).success).toBe(true)
    expect(JSON.stringify(oversized).length).toBeLessThan(65_536)
    expect(pluginConfigurationSchema.safeParse(oversized).success).toBe(false)
  })
})

describe('fresh DSH native lifecycle observations', () => {
  async function fixture() {
    const manifest = await capture(),
      paths = store.paths('run')
    const attachment = (await prepareDshPluginAttachment(manifest, paths))!
    const rows = (
      parseDshYaml(await readFile(join(paths.inputs, 'profile/cordis.patch.yml'), 'utf8')) as {
        insert: DshRow[]
      }[]
    )[0]!.insert
    const config = rows.at(-1)!.config as { rows: DshRow[] }
    const entries = config.rows.map((row) => ({
      options: structuredClone(row),
      disabled: false,
      fiber: { uid: 7, state: 2 },
    }))
    const session = { id: randomUUID(), header: { cwd: root } }
    let started = () => {},
      status: (fiber: unknown) => void = () => {},
      current: typeof session | undefined = session
    const ctx = {
      fiber: { state: 2 },
      root: { fiber: { state: 2 } },
      loader: { entries: () => entries },
      sessions: { get: () => current },
      appReady: {
        onReady: (handler: () => void) => {
          started = handler
          return () => {}
        },
      },
      effect: (callback: () => () => void) => disposers.push(callback()),
      on: (_event: string, handler: typeof status) => {
        status = handler
      },
    }
    const source = monitorSource
      .replace(
        'process.env.AGENT_MATRIX_DSH_PLUGIN_NONCE',
        JSON.stringify(attachment.environment.AGENT_MATRIX_DSH_PLUGIN_NONCE),
      )
      .replace(
        'process.env.AGENT_MATRIX_DSH_PLUGIN_RECEIPTS',
        JSON.stringify(attachment.environment.AGENT_MATRIX_DSH_PLUGIN_RECEIPTS),
      )
      .replace('process.cwd()', JSON.stringify(root))
    const monitor = await import(
      /* @vite-ignore */ `data:text/javascript;base64,${Buffer.from(source).toString('base64')}`
    )
    monitor.apply(ctx, config)
    const verify = (id: string | null = session.id, pid = process.pid) =>
      attachment.verify(pid, new AbortController().signal, id)
    return {
      attachment,
      entries,
      session,
      verify,
      start: () => started(),
      status: (fiber: unknown) => status(fiber),
      removeSession: () => {
        current = undefined
      },
    }
  }
  it('requires native boot, current session, and matching process on every request', async () => {
    const f = await fixture()
    await expect(f.verify()).rejects.toThrow('dsh.plugins')
    f.start()
    await f.verify()
    await f.verify()
    await expect(f.verify(f.session.id, process.pid + 1)).rejects.toThrow('dsh.plugins')
    f.removeSession()
    await expect(f.verify()).rejects.toThrow('dsh.plugins')
  })
  it('rejects a disposed and then reactivated fiber even if its UID is retained', async () => {
    const f = await fixture()
    f.start()
    await f.verify()
    f.entries[0]!.fiber.state = 5
    f.status(f.entries[0]!.fiber)
    f.entries[0]!.fiber.state = 2
    await expect(f.verify()).rejects.toThrow('dsh.plugins')
  })
  it.each(['configuration', 'fiber'])('rejects changes to the native row %s', async (change) => {
    const f = await fixture()
    f.start()
    await f.verify()
    if (change === 'configuration')
      f.entries[0]!.options = { ...f.entries[0]!.options, config: { marker: 'changed' } }
    else f.entries[0]!.fiber = { uid: 7, state: 2 }
    await expect(f.verify()).rejects.toThrow('dsh.plugins')
  })
})
