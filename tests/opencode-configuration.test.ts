import { mkdtemp, mkdir, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SkillDirectoryStore } from '../src/main/assets/skill-directory-store'
import { RunInputStore } from '../src/main/engines/run-input-store'
import { prepareRunLaunch } from '../src/main/engines/run-launch'
import {
  planOpenCode,
  type OpenCodePlanContext,
} from '../src/main/engines/adapters/opencode/configuration'
import { inspectOpenCodeSources } from '../src/main/engines/adapters/opencode/sources'
import { resolveAgentProfile } from '../src/shared/engines/resolution'
import type { EngineWorkspace } from '../src/shared/engines/workspace'
import { openCodeWorkspace } from './helpers/opencode-fixture'
import { captureCommand } from '../src/main/engines/process/capture-command'
import { verifyOpenCodeSkillReadback } from '../src/main/engines/adapters/opencode/readback'

vi.mock('../src/main/engines/process/capture-command', () => ({ captureCommand: vi.fn() }))

let root: string
let workspace: EngineWorkspace
let store: RunInputStore
let context: OpenCodePlanContext
beforeEach(async () => {
  vi.mocked(captureCommand).mockReset()
  root = await realpath(await mkdtemp(join(tmpdir(), 'agentmatrix-opencode-')))
  await mkdir(join(root, 'project/.git'), { recursive: true })
  await writeFile(join(root, 'engine'), '#!/bin/sh\nexit 19\n', { mode: 0o700 })
  workspace = openCodeWorkspace(join(root, 'engine'), join(root, 'project'))
  store = new RunInputStore(join(root, 'runs'), new SkillDirectoryStore(join(root, 'skills')))
  context = {
    configHome: join(root, 'config'),
    sources: { coverage: 'partial', files: [] },
    readSkillEntry: async () => {
      throw new Error('Unexpected directory read')
    },
  }
})
afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})
function resolved() {
  const result = resolveAgentProfile(workspace, 'reviewer')
  if (result.status !== 'resolved') throw new Error(JSON.stringify(result.issues))
  return result.configuration
}
const plan = () => planOpenCode(resolved(), store.paths('run'), context)
const capture = () =>
  store.create('run', workspace, 'reviewer', (configuration, paths) =>
    planOpenCode(configuration, paths, context),
  )

describe('OpenCode configuration', () => {
  it('checks the native selected source rather than accepting a matching Skill name', async () => {
    const manifest = await capture()
    const paths = store.paths('run')
    const mappings = JSON.parse(
      await readFile(join(paths.inputs, 'opencode-mappings.json'), 'utf8'),
    )
    const { launch } = await prepareRunLaunch(store, 'run', async () => 'private-test-key', {})
    const native = mappings.skills.map((skill: { name: string; path: string }) => ({
      name: skill.name,
      location: join(paths.inputs, skill.path, 'SKILL.md'),
      content: 'PRIVATE_NATIVE_SKILL_BODY',
    }))
    const verify = () =>
      verifyOpenCodeSkillReadback(manifest, paths, launch, new AbortController().signal)
    vi.mocked(captureCommand).mockResolvedValue(
      JSON.stringify([...native, { name: 'unrelated', location: '<built-in>' }]),
    )
    await verify()
    expect(vi.mocked(captureCommand).mock.calls[0]![0].args).toEqual(['debug', 'skill'])
    for (const invalid of [
      [],
      [...native, native[0]],
      native.map((item: object) => ({ ...item, location: '/elsewhere/SKILL.md' })),
      native.map((item: object) => ({ ...item, location: 'relative/SKILL.md' })),
      native.map((item: { location: string }) => ({
        ...item,
        location: item.location.replace('/SKILL.md', '/missing/../SKILL.md'),
      })),
    ]) {
      vi.mocked(captureCommand).mockResolvedValue(JSON.stringify(invalid))
      const error = await verify().catch((error: unknown) => error)
      expect(error).toMatchObject({
        diagnostic: { check: 'opencode-skills', reason: 'mismatch', fields: ['skills'] },
      })
      expect(JSON.stringify(error)).not.toContain('PRIVATE_NATIVE')
      expect(JSON.stringify(error)).not.toContain('/elsewhere')
    }
    vi.mocked(captureCommand).mockResolvedValue('PRIVATE_MALFORMED_NATIVE_OUTPUT')
    await expect(verify()).rejects.toMatchObject({
      diagnostic: { check: 'opencode-skills', reason: 'unavailable', fields: ['skills'] },
    })
    vi.mocked(captureCommand).mockClear()
    manifest.files = manifest.files.filter((file) => !file.path.startsWith('skills/'))
    await expect(verify()).rejects.toMatchObject({ diagnostic: { reason: 'unavailable' } })
    expect(captureCommand).not.toHaveBeenCalled()
  })

  it('does not execute a native Skill probe when no Skills are bound', async () => {
    workspace.agents[0]!.skillBindings = []
    const manifest = await capture()
    const { launch } = await prepareRunLaunch(store, 'run', async () => 'private-test-key', {})
    await verifyOpenCodeSkillReadback(
      manifest,
      store.paths('run'),
      launch,
      new AbortController().signal,
    )
    expect(captureCommand).not.toHaveBeenCalled()
  })
  it('maps routing, prompt intent, optional sampling, and plain Markdown Skills into separate native inputs', async () => {
    workspace.models[0]!.parameters = { temperature: 0, topP: 0.85 }
    const manifest = await capture()
    const native = JSON.parse(
      await readFile(join(store.paths('run').inputs, 'opencode.json'), 'utf8'),
    )
    expect(native).toMatchObject({
      model: 'agentmatrix-local/selected',
      default_agent: 'build',
      provider: {
        'agentmatrix-local': {
          npm: '@ai-sdk/openai-compatible',
          options: { baseURL: 'http://127.0.0.1:8080/v1' },
          models: { selected: { id: 'fixture-model', temperature: true } },
        },
      },
      agent: {
        build: {
          prompt: '{file:./prompts/role.md}',
          temperature: 0,
          top_p: 0.85,
          permission: 'ask',
        },
      },
      instructions: [join(store.paths('run').inputs, 'prompts/rules.md')],
    })
    const mappings = JSON.parse(
      await readFile(join(store.paths('run').inputs, 'opencode-mappings.json'), 'utf8'),
    )
    expect(mappings.skills[0]).toMatchObject({ assetId: 'review-skill', wrapped: true })
    const generated = await readFile(
      join(store.paths('run').inputs, mappings.skills[0].path, 'SKILL.md'),
      'utf8',
    )
    expect(generated).toContain('description: "Review changes"')
    expect(generated).toContain('Inspect the diff. SKILL_MARKER.')
    expect(
      await readFile(join(store.paths('run').inputs, manifest.skills[0]!.path, 'SKILL.md'), 'utf8'),
    ).toBe('Inspect the diff. SKILL_MARKER.')
    expect(manifest.launch.environment.OPENCODE_CONFIG_DIR).toBeUndefined()
    expect(native.skills.paths).toEqual([join(store.paths('run').inputs, 'skills')])
    workspace.models[0]!.parameters = {}
    const next = await plan()
    const withoutSampling = JSON.parse(
      next.files.find((file) => file.path === 'opencode.json')!.content,
    )
    expect(withoutSampling.agent.build).not.toHaveProperty('temperature')
    expect(withoutSampling.agent.build).not.toHaveProperty('top_p')
    expect(withoutSampling.provider['agentmatrix-local'].models.selected).not.toHaveProperty(
      'temperature',
    )
  })
  it.each([
    ['openai-responses', '@ai-sdk/openai', 'Authorization'],
    ['anthropic-messages', '@ai-sdk/anthropic', 'x-api-key'],
    ['gemini', '@ai-sdk/google', 'x-goog-api-key'],
  ] as const)(
    'selects the documented SDK for %s without claiming endpoint acceptance',
    async (protocol, npm, header) => {
      workspace.connections[0]!.protocol = protocol
      if (protocol !== 'openai-responses')
        workspace.connections[0]!.auth = {
          kind: 'api-key',
          header,
          secret: { kind: 'credential', id: 'key' },
        }
      const generated = await plan()
      const native = JSON.parse(
        generated.files.find((file) => file.path === 'opencode.json')!.content,
      )
      expect(native.provider['agentmatrix-local'].npm).toBe(npm)
      expect(
        Object.values(generated.launch.environment).filter((value) => value.kind === 'secret'),
      ).toHaveLength(1)
    },
  )
  it('maps MCP argv, cwd, timeouts, ordinary values, and secret references without shell concatenation', async () => {
    workspace.mcpServers = [
      {
        id: 'local-mcp',
        name: 'Local',
        description: '',
        enabled: true,
        transport: 'stdio',
        command: '/usr/bin/node',
        args: ['server file.js', 'a; echo no'],
        cwd: root,
        environment: { ORDINARY: '{file:/do-not-read}' },
        envRefs: { TOKEN: { kind: 'credential', id: 'mcp-key' } },
        timeoutMs: 12000,
      },
      {
        id: 'remote-mcp',
        name: 'Remote',
        description: '',
        enabled: true,
        transport: 'streamable-http',
        url: 'https://example.invalid/mcp',
        headers: {},
        secretHeaders: {},
        auth: { kind: 'bearer', secret: { kind: 'environment', name: 'MCP_TOKEN' } },
        timeoutMs: 18000,
      },
    ]
    workspace.agents[0]!.mcpServerIds = workspace.mcpServers.map((server) => server.id)
    const generated = await plan()
    const text = generated.files.find((file) => file.path === 'opencode.json')!.content
    expect(text).toContain('\\u007bfile:/do-not-read}')
    const native = JSON.parse(text)
    expect(native.mcp['agentmatrix-local-mcp']).toMatchObject({
      type: 'local',
      command: ['/usr/bin/node', 'server file.js', 'a; echo no'],
      cwd: root,
      timeout: 12000,
      environment: { ORDINARY: '{file:/do-not-read}' },
    })
    expect(native.mcp['agentmatrix-remote-mcp']).toMatchObject({
      type: 'remote',
      oauth: false,
      timeout: 18000,
    })
    expect(native.mcp['agentmatrix-remote-mcp'].headers.Authorization).toMatch(
      /^Bearer \{env:AGENT_MATRIX_SECRET_/,
    )
  })
  it('keeps native Skill names and rejects duplicate or malformed frontmatter', async () => {
    workspace.skills[0]!.versions = [
      {
        version: 1,
        kind: 'markdown',
        content: '---\nname: native-name\ndescription: >\n  Folded description\n---\nOriginal body',
      },
    ]
    expect((await plan()).skillPaths['review-skill']).toBe('skills/native-name')
    workspace.skills.push({ ...structuredClone(workspace.skills[0]!), id: 'other' })
    workspace.agents[0]!.skillBindings.push({ assetId: 'other', selection: { follow: 'latest' } })
    await expect(plan()).rejects.toThrow('skill.duplicate')
    workspace.agents[0]!.skillBindings.pop()
    for (const frontmatter of [
      'name: Bad_Name\ndescription: Bad',
      'name: no-description',
      'name: first\nname: second\ndescription: Duplicate',
      'name: valid\ndescription: &a [*a]',
      'name: valid\ndescription: !custom value',
    ]) {
      workspace.skills[0]!.versions = [
        { version: 1, kind: 'markdown', content: `---\n${frontmatter}\n---\nBody` },
      ]
      await expect(plan()).rejects.toThrow('skill.frontmatter')
    }
  })
  it('injects credentials only at launch with native-safe encoding, deduplicates resolution, and retains the saved template', async () => {
    const raw = 'synthetic-"quoted"-{file:/never-read}-key'
    workspace.connections[0]!.secretHeaders = {
      'X-Extra': { kind: 'environment', name: 'PROBE_KEY' },
    }
    workspace.connections[0]!.name = 'literal {env:UNSELECTED_KEY}'
    const manifest = await capture()
    const resolver = vi.fn(async () => raw)
    const { launch } = await prepareRunLaunch(store, 'run', resolver, {
      HOME: root,
      PATH: '/usr/bin:/bin',
      UNSELECTED_KEY: 'do-not-inherit',
      NODE_OPTIONS: 'do-not-inherit',
    })
    expect(resolver).toHaveBeenCalledTimes(1)
    expect(launch.environment.UNSELECTED_KEY).toBeUndefined()
    expect(launch.environment.NODE_OPTIONS).toBeUndefined()
    const template = await readFile(join(store.paths('run').inputs, 'opencode.json'), 'utf8')
    const interpolated = template.replace(
      /\{env:([^}]+)\}/g,
      (_, name) => launch.environment[name] ?? '',
    )
    // Simulate the native second pass: secrets and literal values must not introduce new file macros.
    expect([...interpolated.matchAll(/\{file:([^}]+)\}/g)].map((match) => match[1])).toEqual([
      './prompts/role.md',
    ])
    const native = JSON.parse(interpolated)
    expect(native.provider['agentmatrix-local'].options.apiKey).toBe(raw)
    expect(native.provider['agentmatrix-local'].options.headers['X-Extra']).toBe(raw)
    expect(native.provider['agentmatrix-local'].name).toBe('literal {env:UNSELECTED_KEY}')
    expect(launch.secrets).toContain(raw)
    expect(template).not.toContain(raw)
    expect(JSON.stringify(manifest)).not.toContain(raw)
    expect(await store.read('run')).toEqual(manifest)
    await expect(prepareRunLaunch(store, 'run', async () => '', {})).rejects.toThrow(
      'error.credentialMissing',
    )
  })
  it('records known native candidates up to the Git root without reading or rewriting their content into the plan', async () => {
    const cwd = join(root, 'project/subdir')
    await mkdir(cwd)
    const alias = join(root, 'project-alias')
    await symlink(cwd, alias)
    const native = join(root, 'project/opencode.jsonc')
    const text = '{ /* comment */ "unknownFutureField": true, "key": "synthetic-native-key" }'
    await writeFile(native, text)
    const observed = await inspectOpenCodeSources(alias, {
      home: join(root, 'home'),
      configHome: context.configHome,
      managedDirectory: join(root, 'managed'),
    })
    expect(observed.coverage).toBe('partial')
    expect(observed.files.find((file) => file.path === native)?.exists).toBe(true)
    expect(observed.files.some((file) => file.path === join(root, 'opencode.json'))).toBe(false)
    expect(
      observed.files.find((file) => file.path === join(root, 'managed/opencode.json')),
    ).toEqual({ path: join(root, 'managed/opencode.json'), exists: false })
    context.sources = observed
    expect(JSON.stringify(await plan())).not.toContain('synthetic-native-key')
    expect(await readFile(native, 'utf8')).toBe(text)
  })
  it('captures native Markdown resources from global, home, and project discovery roots', async () => {
    const cwd = join(root, 'project/subdir')
    await mkdir(cwd)
    const roots = [
      join(context.configHome, 'opencode'),
      join(root, 'home/.opencode'),
      join(root, 'project/.opencode'),
      join(cwd, '.opencode'),
    ]
    for (const directory of roots) {
      await mkdir(join(directory, 'agents/nested'), { recursive: true })
      await writeFile(join(directory, 'agents/nested/reviewer.md'), 'PRIVATE_NATIVE_PROMPT')
    }
    const observed = await inspectOpenCodeSources(cwd, {
      home: join(root, 'home'),
      configHome: context.configHome,
      managedDirectory: join(root, 'managed'),
    })
    expect(observed.directories).toHaveLength(roots.length * 6)
    expect(
      observed
        .directories!.filter((directory) => directory.observation.exists)
        .map((directory) => directory.path)
        .sort(),
    ).toEqual(roots.map((directory) => join(directory, 'agents')).sort())
    expect(
      observed.directories!.some(
        (directory) =>
          directory.path.startsWith(join(root, '.opencode')) ||
          directory.path.startsWith(join(root, 'managed')),
      ),
    ).toBe(false)
    expect(
      observed.directories!.find((directory) => directory.path === join(cwd, '.opencode/modes')),
    ).toEqual({
      path: join(cwd, '.opencode/modes'),
      kind: 'opencode-mode',
      observation: { exists: false },
    })
    context.sources = observed
    const manifest = await capture()
    expect(manifest.externalSources.directories).toEqual(observed.directories)
    expect(JSON.stringify(manifest)).not.toContain('PRIVATE_NATIVE_PROMPT')
  })

  it.each(['version', 'reasoning', 'native-plugin', 'vertex', 'engine-login', 'forced-sse'])(
    'diagnoses unverified mappings rather than silently dropping them: %s',
    async (feature) => {
      if (feature === 'version') workspace.installations[0]!.version = '999.0.0'
      if (feature === 'reasoning') workspace.models[0]!.parameters.reasoning = 'high'
      if (feature === 'vertex') workspace.connections[0]!.protocol = 'vertex'
      if (feature === 'engine-login') workspace.connections[0]!.auth = { kind: 'engine-login' }
      if (feature === 'native-plugin') {
        workspace.nativePlugins = [
          {
            id: 'plugin',
            name: 'Test plugin',
            engineInstallationId: 'oc',
            nativeId: 'test',
            version: '1.0.0',
            source: 'test',
            path: join(root, 'plugin'),
          },
        ]
        workspace.agents[0]!.nativePluginIds = ['plugin']
      }
      if (feature === 'forced-sse') {
        workspace.mcpServers = [
          {
            id: 'sse',
            name: 'SSE',
            description: '',
            enabled: true,
            transport: 'legacy-sse',
            url: 'https://example.invalid/sse',
            headers: {},
            secretHeaders: {},
            auth: { kind: 'none' },
          },
        ]
        workspace.agents[0]!.mcpServerIds = ['sse']
      }
      await expect(plan()).rejects.toThrow(
        feature === 'native-plugin' ? 'error.pluginMissing' : 'error.openCodeConfiguration',
      )
    },
  )
})
