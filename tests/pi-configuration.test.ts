import { mkdtemp, mkdir, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SkillDirectoryStore } from '../src/main/assets/skill-directory-store'
import { RunInputStore } from '../src/main/engines/run-input-store'
import { planPi, type PiPlanContext } from '../src/main/engines/adapters/pi/configuration'
import { preparePiLaunch, verifyPiHome } from '../src/main/engines/adapters/pi/launch'
import { inspectPiSources } from '../src/main/engines/adapters/pi/sources'
import { verifyPiReadback } from '../src/main/engines/adapters/pi/readback'
import type { PiClient } from '../src/main/engines/pi/client'
import { resolveAgentProfile } from '../src/shared/engines/resolution'
import type { EngineWorkspace } from '../src/shared/engines/workspace'
import { piWorkspace } from './helpers/pi-fixture'

let root: string, workspace: EngineWorkspace, store: RunInputStore, context: PiPlanContext
beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), 'agentmatrix-pi-config-')))
  await mkdir(join(root, 'project/.pi'), { recursive: true })
  await writeFile(join(root, 'engine'), '#!/bin/sh\necho 0.85.1\n', { mode: 0o700 })
  workspace = piWorkspace(join(root, 'engine'), join(root, 'project'))
  store = new RunInputStore(join(root, 'runs'), new SkillDirectoryStore(join(root, 'skills')))
  context = {
    sources: { coverage: 'partial', files: [] },
    readSkillEntry: async () => {
      throw new Error('Unexpected read')
    },
  }
})
afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})
const plan = () => {
  const resolved = resolveAgentProfile(workspace, 'reviewer')
  if (resolved.status !== 'resolved') throw new Error(JSON.stringify(resolved.issues))
  return planPi(resolved.configuration, store.paths('run'), context)
}
const capture = (id = 'run') =>
  store.create(id, workspace, 'reviewer', (config, paths) => planPi(config, paths, context))
const prepare = () =>
  preparePiLaunch(
    store,
    'run',
    async () => 'fixture-secret',
    { PATH: '/usr/bin:/bin' },
    new AbortController().signal,
  )

describe('Pi configuration contract', () => {
  it('captures explicit native mappings, preserves older inputs, and isolates each writable home', async () => {
    workspace.models[0]!.parameters = { temperature: 0, topP: 0.8 }
    const manifest = await capture()
    const native = JSON.parse(
      await readFile(join(store.paths('run').inputs, 'pi-home/models.json'), 'utf8'),
    )
    expect(native.providers['agentmatrix-local']).toMatchObject({
      api: 'openai-completions',
      baseUrl: 'http://127.0.0.1:8080/v1',
      apiKey: '$AGENT_MATRIX_SECRET_1',
      models: [
        { id: 'fixture-model', reasoning: false, samplingParams: { temperature: 0, top_p: 0.8 } },
      ],
    })
    expect(manifest.launch.args).toContain('--no-approve')
    expect(manifest.launch.args).toContain('--no-skills')
    expect(manifest.launch.args).toContain('--skill')
    expect(manifest.launch.args).toContain('--system-prompt')
    expect(manifest.launch.args).toContain('--append-system-prompt')
    const original = await readFile(join(store.paths('run').inputs, 'prompts/role.md'), 'utf8')
    workspace.prompts[0]!.versions.push({ version: 2, content: 'NEW_ROLE' })
    workspace.prompts[0]!.currentVersion = 2
    await capture('next')
    expect(await readFile(join(store.paths('run').inputs, 'prompts/role.md'), 'utf8')).toBe(
      original,
    )
    expect(await readFile(join(store.paths('next').inputs, 'prompts/role.md'), 'utf8')).toBe(
      'NEW_ROLE',
    )
    const prepared = await prepare()
    const next = await preparePiLaunch(
      store,
      'next',
      async () => 'fixture-secret',
      {},
      new AbortController().signal,
    )
    expect(prepared.launch.environment.PI_CODING_AGENT_DIR).not.toBe(
      next.launch.environment.PI_CODING_AGENT_DIR,
    )
    expect(await store.read('run')).toEqual(manifest)
  })
  it('escapes native header expressions and resolves only captured secret references at launch', async () => {
    const key = '!literal $TOKEN "quoted"'
    workspace.connections[0]!.headers = { 'X-Literal': '!do-not-run $HOME ${NAME} $$' }
    workspace.connections[0]!.secretHeaders = {
      'X-Secret': { kind: 'environment', name: 'PROBE_KEY' },
    }
    const manifest = await capture()
    const resolve = vi.fn(async () => key)
    const { launch } = await preparePiLaunch(
      store,
      'run',
      resolve,
      { UNSELECTED_KEY: 'unselected' },
      new AbortController().signal,
    )
    expect(resolve).toHaveBeenCalledTimes(1)
    expect(launch.environment.AGENT_MATRIX_SECRET_1).toBe(key)
    expect(launch.environment.UNSELECTED_KEY).toBeUndefined()
    const content = await readFile(join(store.paths('run').inputs, 'pi-home/models.json'), 'utf8')
    expect(JSON.parse(content).providers['agentmatrix-local'].headers['X-Literal']).toBe(
      '$!do-not-run $$HOME $${NAME} $$$$',
    )
    expect(content).not.toContain(key)
    expect(JSON.stringify(manifest)).not.toContain(key)
  })
  it.each([
    ['openai-responses', 'openai-responses', 'Authorization'],
    ['anthropic-messages', 'anthropic-messages', 'x-api-key'],
    ['gemini', 'google-generative-ai', 'x-goog-api-key'],
  ] as const)('maps the documented %s API separately', async (protocol, api, header) => {
    workspace.connections[0]!.protocol = protocol
    if (protocol !== 'openai-responses')
      workspace.connections[0]!.auth = {
        kind: 'api-key',
        header,
        secret: { kind: 'credential', id: 'key' },
      }
    const generated = await plan()
    expect(
      JSON.parse(generated.files.find((file) => file.path === 'pi-home/models.json')!.content)
        .providers['agentmatrix-local'].api,
    ).toBe(api)
  })
  it('preserves a trusted native append alongside shared append bindings and observes ancestor contexts beyond Git root', async () => {
    const native = join(root, 'project/.pi/APPEND_SYSTEM.md')
    await writeFile(native, 'NATIVE_APPEND')
    await mkdir(join(root, 'project/.git'))
    await writeFile(join(root, 'AGENTS.md'), 'ANCESTOR_CONTEXT')
    const alias = join(root, 'alias')
    await symlink(join(root, 'project'), alias)
    workspace.agents[0]!.execution.cwd = alias
    workspace.agents[0]!.engineOptions = {
      kind: 'pi',
      projectTrust: 'trust-once',
      contextFiles: 'ignore',
    }
    context.sources = await inspectPiSources(alias)
    expect(
      context.sources.files.some(
        (source) => source.path === join(root, 'AGENTS.md') && source.exists,
      ),
    ).toBe(true)
    const generated = await plan()
    expect(generated.launch.args).toContain(native)
    expect(generated.launch.args).toContain('--approve')
    expect(generated.launch.args).toContain('--no-context-files')
    await capture()
    await writeFile(native, 'CHANGED_NATIVE_APPEND')
    await expect(prepare()).rejects.toThrow('error.runSourceChanged')
  })
  it('rejects unsupported approvals, MCP, auth, and sampling instead of dropping requests', async () => {
    workspace.agents[0]!.execution.approval = 'ask'
    await expect(plan()).rejects.toThrow('execution.universal-approval')
    workspace.agents[0]!.execution.approval = 'deny'
    expect((await plan()).launch.args).toContain('--no-tools')
    workspace.connections[0]!.auth = { kind: 'none' }
    await expect(plan()).rejects.toThrow('connection.auth')
    workspace.connections[0]!.protocol = 'anthropic-messages'
    workspace.connections[0]!.auth = {
      kind: 'api-key',
      header: 'x-api-key',
      secret: { kind: 'credential', id: 'key' },
    }
    workspace.models[0]!.parameters = { topP: 0.4 }
    await expect(plan()).rejects.toThrow('model.sampling-for-api')
    workspace.models[0]!.parameters = {}
    workspace.mcpServers = [
      {
        id: 'mcp',
        name: 'MCP',
        description: '',
        enabled: true,
        transport: 'stdio',
        command: '/usr/bin/true',
        cwd: '',
        args: [],
        environment: {},
        envRefs: {},
      },
    ]
    workspace.agents[0]!.mcpServerIds = ['mcp']
    await expect(plan()).rejects.toThrow('mcp.extension-required')
  })
  it('rejects duplicate Skills and ambiguous thinking values', async () => {
    workspace.skills[0]!.versions = [
      {
        kind: 'markdown',
        version: 1,
        content: '---\nname: named-skill\ndescription: Example\n---\nBody',
      },
    ]
    workspace.skills.push({ ...structuredClone(workspace.skills[0]!), id: 'other' })
    workspace.agents[0]!.skillBindings.push({ assetId: 'other', selection: { follow: 'latest' } })
    await expect(plan()).rejects.toThrow('skill.duplicate')
    workspace.agents[0]!.skillBindings.pop()
    workspace.agents[0]!.engineOptions = { kind: 'pi', thinkingLevel: 'invalid' }
    await expect(plan()).rejects.toThrow('model.thinkingLevel')
    workspace.agents[0]!.engineOptions.thinkingLevel = 'high'
    workspace.models[0]!.parameters.reasoning = 'low'
    await expect(plan()).rejects.toThrow('model.reasoning-conflict')
  })
  it.each(['models.json', 'settings.json', 'auth.json', 'trust.json', 'SYSTEM.md'])(
    'preserves and diagnoses changed native %s on reuse',
    async (name) => {
      await capture()
      await prepare()
      const path = join(store.paths('run').state, 'pi', name)
      const changed = name.endsWith('.json') ? '{"changed":true}' : 'CHANGED'
      await writeFile(path, changed)
      await expect(verifyPiHome(store, 'run')).rejects.toMatchObject({ field: 'pi.native-home' })
      await expect(prepare()).rejects.toMatchObject({ field: 'pi.native-home' })
      expect(await readFile(path, 'utf8')).toBe(changed)
    },
  )
  it('rejects a symlinked native control file without touching the destination', async () => {
    await capture()
    await prepare()
    const path = join(store.paths('run').state, 'pi/models.json')
    const destination = join(root, 'outside.json')
    await writeFile(destination, '{}')
    await rm(path)
    await symlink(destination, path)
    await expect(prepare()).rejects.toMatchObject({ field: 'pi.native-home' })
    expect(await readFile(destination, 'utf8')).toBe('{}')
  })
  it('does not recreate a deleted control file in an initialized native home', async () => {
    await capture()
    await prepare()
    const path = join(store.paths('run').state, 'pi/models.json')
    await rm(path)
    await expect(prepare()).rejects.toMatchObject({ field: 'pi.native-home' })
    await expect(readFile(path)).rejects.toMatchObject({ code: 'ENOENT' })
  })
  it('checks native endpoint, protocol, thinking, idle state, and discovered Skill identities', async () => {
    const manifest = await capture()
    const mappings = JSON.parse(
      await readFile(join(store.paths('run').inputs, 'pi-mappings.json'), 'utf8'),
    )
    const state = {
      model: {
        id: 'fixture-model',
        provider: 'agentmatrix-local',
        api: 'openai-completions',
        baseUrl: manifest.connection.baseUrl,
      },
      thinkingLevel: 'off',
      sessionId: 'native',
      sessionFile: '/sessions/native.jsonl',
      isStreaming: false,
      isCompacting: false,
      pendingMessageCount: 0,
      autoCompactionEnabled: false,
    }
    const commands = {
      commands: mappings.skills.map((skill: { name: string }) => ({
        source: 'skill',
        name: `skill:${skill.name}`,
      })),
    }
    const client = {
      request: vi.fn(async (command: { type: string }) =>
        command.type === 'get_state' ? state : commands,
      ),
    } as unknown as PiClient
    expect((await verifyPiReadback(client, manifest, store.paths('run'))).sessionId).toBe('native')
    state.model.baseUrl = 'https://unexpected.invalid'
    await expect(verifyPiReadback(client, manifest, store.paths('run'))).rejects.toMatchObject({
      field: 'pi.native-readback',
    })
    state.model.baseUrl = manifest.connection.baseUrl
    commands.commands.push({ source: 'skill', name: 'skill:unselected' })
    await expect(verifyPiReadback(client, manifest, store.paths('run'))).rejects.toMatchObject({
      field: 'pi.native-readback',
    })
  })
})
