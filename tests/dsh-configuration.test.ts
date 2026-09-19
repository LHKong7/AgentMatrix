import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  resolveAgentProfile,
  type ResolvedAgentConfiguration,
} from '../src/shared/engines/resolution'
import { RunInputStore } from '../src/main/engines/run-input-store'
import { SkillDirectoryStore } from '../src/main/assets/skill-directory-store'
import {
  inspectDshComposition,
  DshExpression,
  parseDshYaml,
  writeDshYaml,
  type DshComposition,
} from '../src/main/engines/adapters/dsh/composition'
import { planDsh } from '../src/main/engines/adapters/dsh/configuration'
import { verifyDshHome } from '../src/main/engines/adapters/dsh/launch'
import { dshWorkspace } from './helpers/dsh-fixture'
vi.mock('../src/main/engines/adapters/dsh/plugins', async (original) => ({
  ...(await original<typeof import('../src/main/engines/adapters/dsh/plugins')>()),
  inspectDshPluginFramework: vi.fn().mockResolvedValue([]),
}))

const roots: string[] = []
const rowIds = [
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
]
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'agentmatrix-dsh-unit-'))
  roots.push(root)
  const cwd = join(root, 'project'),
    executable = join(root, 'dsh')
  await mkdir(cwd)
  await writeFile(executable, 'Not an executable; unit tests never launch DSH.\n')
  const workspace = dshWorkspace(executable, cwd)
  const paths = {
    root: join(root, 'run'),
    inputs: join(root, 'run/inputs'),
    state: join(root, 'run/state'),
  }
  const composition: DshComposition = {
    rows: rowIds.map((id) => ({ id, name: '@deepseek-ai/dsh-test' })),
    entries: { '@deepseek-ai/dsh-test': executable, '@deepseek-ai/dsh-mcp-client': executable },
    components: [],
    sources: { coverage: 'partial', files: [] },
  }
  const context = {
    composition,
    readSkillEntry: async () => {
      throw new Error('Unexpected directory Skill')
    },
  }
  const resolve = () => {
    const value = resolveAgentProfile(workspace, 'reviewer')
    if (value.status !== 'resolved') throw new Error('Fixture not resolved')
    return value.configuration
  }
  const plan = (configuration = resolve()) => planDsh(configuration, paths, context)
  const skills = new SkillDirectoryStore(join(root, 'assets'))
  const store = new RunInputStore(join(root, 'runs'), skills)
  const capture = () =>
    store.create('captured', workspace, 'reviewer', (configuration, p) =>
      planDsh(configuration, p, context),
    )
  return { root, cwd, executable, workspace, paths, composition, resolve, plan, store, capture }
}
const rowsOf = (files: { path: string; content: string }[]) =>
  (
    parseDshYaml(files.find((file) => file.path === 'profile/cordis.patch.yml')!.content) as {
      insert: { id: string; config?: Record<string, unknown>; disabled?: boolean }[]
    }[]
  )[0]!.insert
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('DSH managed configuration', () => {
  it.each(['openai-chat-completions', 'openai-responses', 'anthropic-messages', 'gemini'] as const)(
    'maps the %s API family explicitly',
    async (protocol) => {
      const f = await fixture(),
        c = f.resolve()
      c.connection.protocol = protocol
      if (protocol === 'anthropic-messages' || protocol === 'gemini')
        c.connection.auth = {
          kind: 'api-key',
          header: protocol === 'gemini' ? 'x-goog-api-key' : 'x-api-key',
          secret: { kind: 'environment', name: 'KEY' },
        }
      const rows = rowsOf((await f.plan(c)).files)
      const provider = (
        rows.find((row) => row.id === 'llm-pi-ai')!.config!.providers as Record<
          string,
          { api: string }
        >
      )['agentmatrix-local']!
      expect(provider.api).toBe(
        {
          'openai-chat-completions': 'openai-completions',
          'openai-responses': 'openai-responses',
          'anthropic-messages': 'anthropic-messages',
          gemini: 'google-generative-ai',
        }[protocol],
      )
    },
  )
  it('places shared additions before a complete replacement when requested', async () => {
    const f = await fixture(),
      c = f.resolve()
    c.agent.engineOptions = {
      kind: 'deepseek-harness',
      profileTemplate: 'acp',
      patchReload: 'startup',
      appendPosition: 'prefix',
    }
    const rows = rowsOf((await f.plan(c)).files)
    const complete = rows.find((row) => row.id === 'agentmatrix-managed')!.config!
      .complete as string
    expect(complete.indexOf('APPEND_MARKER')).toBeLessThan(complete.indexOf('ROLE_MARKER'))
  })
  it('maps remote MCP authentication to secret references and rejects unsupported transports', async () => {
    const f = await fixture(),
      c = f.resolve()
    c.mcpServers = [
      {
        id: 'remote',
        name: 'Remote',
        description: '',
        enabled: true,
        transport: 'streamable-http',
        url: 'https://example.invalid/mcp',
        headers: {},
        secretHeaders: {},
        auth: { kind: 'bearer', secret: { kind: 'environment', name: 'MCP_KEY' } },
      },
    ]
    const generated = await f.plan(c)
    const server = rowsOf(generated.files).find((row) => row.id.startsWith('agentmatrix-mcp-'))!
    expect(server.config).toMatchObject({
      transport: 'streamable-http',
      failOnStartupError: true,
      reconnect: { enabled: false },
      headers: {
        Authorization: new DshExpression('"Bearer " + process.env["AGENT_MATRIX_SECRET_2"]'),
      },
    })
    c.mcpServers[0]!.transport = 'legacy-sse'
    await expect(f.plan(c)).rejects.toThrow('dshConfiguration')
    const remote = c.mcpServers[0]!
    if (remote.transport === 'stdio') throw new Error('Expected remote MCP')
    remote.transport = 'streamable-http'
    remote.auth = { kind: 'oauth', owner: 'engine', scopes: ['tools:read'] }
    await expect(f.plan(c)).rejects.toThrow('dshConfiguration')
  })
  it('keeps native expressions inert and distinguishes them from literal YAML strings', () => {
    const value = {
      expression: new DshExpression('process.exit(1)'),
      literal: '!!js process.exit(1)',
    }
    expect(parseDshYaml(writeDshYaml(value))).toEqual(value)
    expect(() => parseDshYaml('field: 1\nfield: 2')).toThrow()
    expect(() => parseDshYaml('field: !unknown text')).toThrow()
  })
  it('maps complete prompts, API references and literal headers without native template injection', async () => {
    const f = await fixture()
    f.workspace.prompts[0]!.versions[0]!.content = 'Keep {{unknown}} literal $HOME'
    f.workspace.connections[0]!.headers = { 'X-Literal': '!!js process.exit(1)' }
    f.workspace.connections[0]!.secretHeaders = {
      'X-Private': { kind: 'environment', name: 'PRIVATE_KEY' },
    }
    const generated = await f.plan(),
      rows = rowsOf(generated.files)
    expect(rows.find((row) => row.id === 'agentmatrix-managed')!.config).toMatchObject({
      complete: expect.stringContaining('Keep {{unknown}} literal $HOME'),
    })
    const provider = (
      rows.find((row) => row.id === 'llm-pi-ai')!.config!.providers as Record<
        string,
        { apiKeyEnv: string; headers: Record<string, unknown> }
      >
    )['agentmatrix-local']!
    expect(provider.apiKeyEnv).toBe('AGENT_MATRIX_SECRET_1')
    expect(provider.headers['X-Literal']).toBe('!!js process.exit(1)')
    expect(provider.headers['X-Private']).toBeInstanceOf(DshExpression)
    expect(generated.launch.environment.AGENT_MATRIX_SECRET_2).toMatchObject({
      kind: 'secret',
      reference: { name: 'PRIVATE_KEY' },
    })
    expect(generated.files.find((file) => file.path === 'managed.cjs')!.content).not.toContain(
      'Keep {{unknown}}',
    )
    expect(generated.launch.args).toEqual(['--profile', 'agentmatrix'])
    expect(
      JSON.parse(generated.files.find((file) => file.path === 'profile/package.json')!.content).dsh
        .profile,
    ).toEqual({ bundles: [], patchReload: 'startup' })
  })
  it.each([
    [
      'version',
      (c: ResolvedAgentConfiguration) => {
        c.installation.version = '999.0.0'
      },
    ],
    [
      'prefix arguments',
      (c: ResolvedAgentConfiguration) => {
        c.installation.prefixArgs = ['--patch', 'other.yml']
      },
    ],
    [
      'SDK profile',
      (c: ResolvedAgentConfiguration) => {
        c.agent.engineOptions = {
          kind: 'deepseek-harness',
          profileTemplate: 'sdk',
          patchReload: 'startup',
        }
      },
    ],
    [
      'temperature',
      (c: ResolvedAgentConfiguration) => {
        c.model.parameters.temperature = 0.1
      },
    ],
    [
      'gateway reasoning',
      (c: ResolvedAgentConfiguration) => {
        c.model.parameters.reasoning = 'high'
      },
    ],
    [
      'keyless authentication',
      (c: ResolvedAgentConfiguration) => {
        c.connection.auth = { kind: 'none' }
      },
    ],
    [
      'reserved headers',
      (c: ResolvedAgentConfiguration) => {
        c.connection.headers = { 'User-Agent': 'custom' }
      },
    ],
    [
      'native headers',
      (c: ResolvedAgentConfiguration) => {
        c.connection.protocol = 'deepseek-official'
      },
    ],
    [
      'conflicting replacements',
      (c: ResolvedAgentConfiguration) => {
        c.prompts[1]!.mode = 'replace'
      },
    ],
  ] as const)(
    'rejects unsupported %s without silently dropping the requested setting',
    async (_name, edit) => {
      const f = await fixture(),
        configuration = f.resolve()
      edit(configuration)
      await expect(f.plan(configuration)).rejects.toThrow('dshConfiguration')
    },
  )
  it('keeps native DeepSeek routing separate and pins the selected permission policy', async () => {
    const f = await fixture(),
      c = f.resolve()
    c.connection.protocol = 'deepseek-official'
    c.connection.headers = {}
    c.model.parameters.reasoning = 'high'
    c.agent.execution.approval = 'deny'
    const rows = rowsOf((await f.plan(c)).files)
    expect(rows.find((row) => row.id === 'llm-pi-ai')!.disabled).toBe(true)
    expect(rows.find((row) => row.id === 'llm-deepseek')!.config).toMatchObject({
      thinking: 'enabled',
      reasoningEffort: 'high',
    })
    expect(rows.find((row) => row.id === 'permission')!.config).toMatchObject({
      presets: { 'agentmatrix-deny': { sandbox: 'workspace-write', approval: 'never' } },
    })
  })
  it('wraps plain Skills and rejects duplicate native Skill names', async () => {
    const f = await fixture(),
      c = f.resolve()
    const generated = await f.plan(c)
    expect(
      generated.files.some(
        (file) => file.path.endsWith('/SKILL.md') && file.content.includes('SKILL_MARKER'),
      ),
    ).toBe(true)
    c.skills[0]!.revision = {
      version: 1,
      kind: 'markdown',
      content: '---\nname: duplicate\ndescription: Test\n---\nBody',
    }
    c.skills.push({ ...c.skills[0]!, assetId: 'another' })
    await expect(f.plan(c)).rejects.toThrow('dshConfiguration')
  })
  it.each(['changed', 'deleted', 'home-overlay', 'symlink'] as const)(
    'rejects a %s native control without repairing it on relaunch',
    async (kind) => {
      const f = await fixture()
      await f.capture()
      await verifyDshHome(f.store, 'captured', true)
      const native = join(f.store.paths('captured').state, 'dsh'),
        path = join(native, 'profiles/agentmatrix/cordis.patch.yml')
      if (kind === 'changed') await writeFile(path, '[]\n')
      if (kind === 'deleted') await rm(path)
      if (kind === 'home-overlay') await writeFile(join(native, 'cordis.patch.yml'), '[]\n')
      if (kind === 'symlink') {
        await rm(path)
        await symlink(join(f.store.paths('captured').inputs, 'profile/cordis.patch.yml'), path)
      }
      await expect(verifyDshHome(f.store, 'captured', true)).rejects.toMatchObject({
        code: 'configuration',
      })
      if (kind === 'changed') expect(await readFile(path, 'utf8')).toBe('[]\n')
      if (kind === 'deleted') await expect(readFile(path)).rejects.toMatchObject({ code: 'ENOENT' })
    },
  )
  it('inspects a pinned installed composition without importing its code and detects mixed releases', async () => {
    const f = await fixture(),
      modules = join(f.root, 'node_modules/@deepseek-ai')
    for (const name of ['dsh', 'dsh-base', 'dsh-acp-app', 'dsh-mcp-client']) {
      const root = join(modules, name)
      await mkdir(join(root, 'lib'), { recursive: true })
      await writeFile(
        join(root, 'package.json'),
        JSON.stringify({
          name: `@deepseek-ai/${name}`,
          version: '0.1.5-rc.2',
          main: 'lib/index.js',
        }),
      )
      await writeFile(join(root, 'lib/index.js'), 'throw new Error("MUST_NOT_IMPORT");')
    }
    await writeFile(
      join(modules, 'dsh-base/cordis.patch.yml'),
      writeDshYaml([
        {
          insert: [
            { id: 'core', name: '@deepseek-ai/dsh-base', config: { keep: 'first', remove: 'old' } },
          ],
        },
      ]),
    )
    await writeFile(
      join(modules, 'dsh-acp-app/cordis.patch.yml'),
      writeDshYaml([{ id: 'core', config: { keep: 'last' } }]),
    )
    const bin = join(modules, 'dsh/lib/index.js')
    const composition = await inspectDshComposition(bin, f.cwd)
    expect(composition.rows).toMatchObject([{ id: 'core', config: { keep: 'last' } }])
    expect(composition.rows[0]!.config).not.toHaveProperty('remove')
    expect(
      composition.sources.files.some(
        (file) => file.path.endsWith('dsh-base/cordis.patch.yml') && file.exists,
      ),
    ).toBe(true)
    await writeFile(
      join(modules, 'dsh-base/package.json'),
      JSON.stringify({ name: '@deepseek-ai/dsh-base', version: '999.0.0', main: 'lib/index.js' }),
    )
    await expect(inspectDshComposition(bin, f.cwd)).rejects.toThrow('dshConfiguration')
  })
})
