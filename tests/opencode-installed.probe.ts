import { createServer } from 'node:http'
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { expect, it, vi } from 'vitest'
import { SkillDirectoryStore } from '../src/main/assets/skill-directory-store'
import { planOpenCode } from '../src/main/engines/adapters/opencode/configuration'
import { inspectOpenCodeSources } from '../src/main/engines/adapters/opencode/sources'
import { RunInputStore } from '../src/main/engines/run-input-store'
import { prepareRunLaunch } from '../src/main/engines/run-launch'
import { ManagedProcess, type ProcessLaunch } from '../src/main/engines/process/managed-process'
import { connectOpenCode } from '../src/main/engines/adapters/opencode/runtime'
import {
  verifyOpenCodeReadback,
  verifyOpenCodeSkillReadback,
} from '../src/main/engines/adapters/opencode/readback'
import type {
  RuntimeOutput,
  RuntimeSession,
  RuntimeTurnHandlers,
} from '../src/main/engines/runtime'
import { openCodeWorkspace } from './helpers/opencode-fixture'
import { SessionCoordinator, type SessionRuntimeFactory } from '../src/main/sessions/coordinator'
import { SessionJournal } from '../src/main/sessions/journal'
import type { SessionSnapshot, SessionDelivery } from '../src/shared/sessions/schema'

async function capture(launch: ProcessLaunch, args: string[]): Promise<string> {
  const child = new ManagedProcess({ ...launch, args })
  let expired = false
  const timer = setTimeout(() => {
    expired = true
    void child.terminate().catch(() => {})
  }, 25_000)
  try {
    await child.ready
    const reader = child.stdout.getReader()
    const chunks: Uint8Array[] = []
    let length = 0
    while (true) {
      const item = await reader.read()
      if (item.done) break
      length += item.value.byteLength
      if (length > 4_194_304) throw new Error('Native readback exceeded its output limit')
      chunks.push(item.value)
    }
    const result = await child.closed
    if (expired || result.code !== 0 || result.failure)
      throw new Error(`Native readback failed: ${result.stderr}`)
    return new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks))
  } finally {
    clearTimeout(timer)
    await child.terminate()
  }
}

it.runIf(Boolean(process.env.AGENT_MATRIX_TEST_OPENCODE))(
  'loads captured configuration and performs a real ACP turn against a local protocol fixture',
  async () => {
    const executable = process.env.AGENT_MATRIX_TEST_OPENCODE!
    const root = await realpath(await mkdtemp(join(tmpdir(), 'agentmatrix-opencode-native-')))
    const cwd = join(root, 'project')
    const home = join(root, 'home')
    const configHome = join(root, 'config')
    await mkdir(join(cwd, '.git'), { recursive: true })
    await mkdir(home)
    await mkdir(configHome)
    await writeFile(join(cwd, 'fixture.txt'), 'TOOL_RESULT_MARKER\n')
    const key = 'synthetic-"quoted"-{file:/never-read}-key'
    const mcpCwd = join(root, 'mcp-cwd')
    await mkdir(mcpCwd)
    const mcpScript = join(root, 'mcp-fixture.cjs')
    await writeFile(
      mcpScript,
      `
const readline = require('node:readline');
readline.createInterface({ input: process.stdin }).on('line', (line) => {
  const request = JSON.parse(line);
  if (request.id === undefined) return;
  let result = {};
  if (request.method === 'initialize') result = { protocolVersion: request.params.protocolVersion, serverInfo: { name: 'agentmatrix-fixture', version: '1.0.0' }, capabilities: { tools: {} } };
  if (request.method === 'tools/list') result = { tools: [{ name: 'marker', description: 'Return a configuration probe marker', inputSchema: { type: 'object', properties: {} } }] };
  if (request.method === 'tools/call') result = { content: [{ type: 'text', text: process.cwd() === ${JSON.stringify(mcpCwd)} && process.env.MCP_SECRET === ${JSON.stringify(key)} && process.argv[2] === 'literal;argument' ? 'MCP_CONFIG_MARKER' : 'MCP_CONFIGURATION_FAILED' }] };
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, result }) + '\\n');
});
`,
    )
    const requests: {
      model: unknown
      authorization: string | undefined
      hasRole: boolean
      hasAppend: boolean
      hasToolResult: boolean
      hasMcpResult: boolean
      hasSkillResult: boolean
    }[] = []
    let mainRequests = 0
    let phase: 'tools' | 'stream' | 'permission' | 'resume' = 'tools'
    let streaming = () => {}
    const server = createServer(async (request, response) => {
      try {
        let body = ''
        for await (const chunk of request) {
          body += String(chunk)
          if (body.length > 2_097_152) throw new Error('Fixture request limit')
        }
        const input = JSON.parse(body)
        const main =
          Array.isArray(input.tools) &&
          input.tools.some(
            (tool: { function?: { name?: string } }) => tool.function?.name === 'read',
          )
        const hasToolResult = input.messages.some(
          (message: { role: string; content: unknown }) =>
            message.role === 'tool' &&
            JSON.stringify(message.content).includes('TOOL_RESULT_MARKER'),
        )
        const hasMcpResult = input.messages.some(
          (message: { role: string; content: unknown }) =>
            message.role === 'tool' &&
            JSON.stringify(message.content).includes('MCP_CONFIG_MARKER'),
        )
        const hasSkillResult = input.messages.some(
          (message: { role: string; content: unknown }) =>
            message.role === 'tool' &&
            JSON.stringify(message.content).includes('DIRECTORY_SKILL_MARKER'),
        )
        const mcpTool = input.tools?.find((tool: { function?: { name?: string } }) =>
          tool.function?.name?.endsWith('_marker'),
        )
        if (main) {
          mainRequests++
          requests.push({
            model: input.model,
            authorization: request.headers.authorization,
            hasRole: body.includes('ROLE_MARKER'),
            hasAppend: body.includes('APPEND_MARKER'),
            hasToolResult,
            hasMcpResult,
            hasSkillResult,
          })
        }
        if (!input.stream) {
          response.writeHead(200, { 'Content-Type': 'application/json' })
          response.end(
            JSON.stringify({
              id: 'fixture',
              object: 'chat.completion',
              created: 1,
              model: input.model,
              choices: [
                {
                  index: 0,
                  message: { role: 'assistant', content: 'Probe title' },
                  finish_reason: 'stop',
                },
              ],
              usage: { prompt_tokens: 10, completion_tokens: 3, total_tokens: 13 },
            }),
          )
          return
        }
        response.writeHead(200, { 'Content-Type': 'text/event-stream' })
        const chunk = (delta: object, finish_reason: string | null = null) =>
          response.write(
            `data: ${JSON.stringify({ id: 'fixture', object: 'chat.completion.chunk', created: 1, model: input.model, choices: [{ index: 0, delta, finish_reason }] })}\n\n`,
          )
        if (main && phase === 'stream') {
          chunk({ role: 'assistant', content: 'Streaming cancellation marker '.repeat(10) })
          streaming()
          return
        }
        if (main && (phase === 'permission' || (!hasToolResult && mainRequests < 4))) {
          chunk({
            role: 'assistant',
            tool_calls: [
              {
                index: 0,
                id: 'probe-read',
                type: 'function',
                function: {
                  name: 'read',
                  arguments: JSON.stringify({ filePath: join(cwd, 'fixture.txt') }),
                },
              },
            ],
          })
          chunk({}, 'tool_calls')
        } else if (main && !hasSkillResult && mainRequests < 5) {
          chunk({
            role: 'assistant',
            tool_calls: [
              {
                index: 0,
                id: 'probe-skill',
                type: 'function',
                function: { name: 'skill', arguments: JSON.stringify({ name: 'directory-check' }) },
              },
            ],
          })
          chunk({}, 'tool_calls')
        } else if (main && !hasMcpResult && mcpTool && mainRequests < 6) {
          chunk({
            role: 'assistant',
            tool_calls: [
              {
                index: 0,
                id: 'probe-mcp',
                type: 'function',
                function: { name: mcpTool.function.name, arguments: '{}' },
              },
            ],
          })
          chunk({}, 'tool_calls')
        } else {
          chunk({ role: 'assistant', content: 'Verified ' })
          chunk({
            content: main
              ? phase === 'resume'
                ? 'RESUMED_MARKER'
                : 'TOOL_RESULT_MARKER'
              : 'probe title',
          })
          chunk({}, 'stop')
        }
        response.end('data: [DONE]\n\n')
      } catch {
        response.writeHead(400)
        response.end('Protocol fixture rejected the request')
      }
    })
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(0, '127.0.0.1', resolve)
    })
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('Missing fixture address')
    let runtime: RuntimeSession | undefined
    let coordinator: SessionCoordinator | undefined
    try {
      const workspace = openCodeWorkspace(executable, cwd)
      workspace.connections[0]!.baseUrl = `http://127.0.0.1:${address.port}/v1`
      workspace.mcpServers = [
        {
          id: 'fixture',
          name: 'MCP fixture',
          description: '',
          enabled: true,
          transport: 'stdio',
          command: process.execPath,
          args: [mcpScript, 'literal;argument'],
          cwd: mcpCwd,
          environment: {},
          envRefs: { MCP_SECRET: { kind: 'environment', name: 'PROBE_KEY' } },
          timeoutMs: 10000,
        },
      ]
      workspace.agents[0]!.mcpServerIds = ['fixture']
      const captures = new SkillDirectoryStore(join(root, 'skills'))
      const skillSource = join(root, 'skill-source')
      await mkdir(join(skillSource, 'references'), { recursive: true })
      await writeFile(
        join(skillSource, 'SKILL.md'),
        '---\nname: directory-check\ndescription: Native directory Skill probe\n---\nDIRECTORY_SKILL_MARKER\nSee references/context.md.',
      )
      await writeFile(join(skillSource, 'references/context.md'), 'Captured reference bytes')
      const imported = await captures.capture(skillSource)
      workspace.skills.push({
        id: 'directory',
        name: 'Directory Skill',
        description: '',
        enabled: true,
        sourcePath: imported.sourcePath,
        currentVersion: 1,
        versions: [imported.snapshot],
      })
      workspace.agents[0]!.skillBindings.push({
        assetId: 'directory',
        selection: { follow: 'latest' },
      })
      const store = new RunInputStore(join(root, 'runs'), captures)
      const nativeResources = [
        [join(cwd, '.opencode/agents/nested/reviewer.md'), 'NATIVE_AGENT_MARKER'],
        [join(configHome, 'opencode/commands/native-command.md'), 'NATIVE_COMMAND_MARKER'],
        [join(home, '.opencode/modes/native-mode.md'), 'NATIVE_MODE_MARKER'],
        [join(home, '.opencode/modes/nested/ignored.md'), 'NESTED_MODE_MUST_BE_IGNORED'],
      ] as const
      for (const [path, marker] of nativeResources) {
        await mkdir(dirname(path), { recursive: true })
        await writeFile(path, `---\ndescription: Native resource probe\n---\n${marker}\n`)
      }
      const sources = await inspectOpenCodeSources(cwd, { home, configHome })
      const capturedResourcePaths = sources.directories!.flatMap((directory) =>
        directory.observation.exists ? directory.observation.files.map((file) => file.path) : [],
      )
      expect(capturedResourcePaths.sort()).toEqual(
        nativeResources
          .slice(0, 3)
          .map(([path]) => path)
          .sort(),
      )
      const manifest = await store.create(
        'native',
        workspace,
        'reviewer',
        async (configuration, paths) => {
          const plan = await planOpenCode(configuration, paths, {
            configHome,
            sources,
            readSkillEntry: async (skill) => {
              if (skill.revision.kind !== 'directory') throw new Error('Unexpected Markdown lookup')
              return readFile(join(await captures.verify(skill.revision), 'SKILL.md'), 'utf8')
            },
          })
          for (const [name, value] of Object.entries({
            OPENCODE_TEST_HOME: home,
            OPENCODE_PURE: 'true',
            OPENCODE_DISABLE_MODELS_FETCH: 'true',
            OPENCODE_DISABLE_DEFAULT_PLUGINS: 'true',
            OPENCODE_DISABLE_CLAUDE_CODE: 'true',
            OPENCODE_DISABLE_EXTERNAL_SKILLS: 'true',
          }))
            plan.launch.environment[name] = { kind: 'literal', value }
          return plan
        },
      )
      const { launch } = await prepareRunLaunch(store, 'native', async () => key, {
        ...process.env,
        HOME: home,
      })
      Object.assign(launch.environment, {
        OPENCODE_TEST_HOME: home,
        OPENCODE_DISABLE_MODELS_FETCH: 'true',
        OPENCODE_DISABLE_DEFAULT_PLUGINS: 'true',
        OPENCODE_DISABLE_CLAUDE_CODE: 'true',
        OPENCODE_DISABLE_EXTERNAL_SKILLS: 'true',
      })
      const version = (await capture(launch, ['--version'])).trim()
      expect(version).toBe('1.18.16')
      const config = JSON.parse(await capture(launch, ['debug', 'config', '--pure']))
      expect(config.model).toBe('agentmatrix-local/selected')
      expect(config.provider['agentmatrix-local'].options.apiKey).toBe(key)
      expect(config.agent.build.prompt).toContain('ROLE_MARKER')
      expect(
        Object.values(config.agent).some(
          (agent) => (agent as { prompt?: string }).prompt === 'NATIVE_AGENT_MARKER',
        ),
      ).toBe(true)
      expect(config.agent['native-mode'].prompt).toBe('NATIVE_MODE_MARKER')
      expect(config.command['native-command'].template).toBe('NATIVE_COMMAND_MARKER')
      expect(JSON.stringify(config)).not.toContain('NESTED_MODE_MUST_BE_IGNORED')
      expect(config.instructions).toContain(join(store.paths('native').inputs, 'prompts/rules.md'))
      const skills = JSON.parse(await capture(launch, ['debug', 'skill', '--pure']))
      await verifyOpenCodeSkillReadback(
        manifest,
        store.paths('native'),
        launch,
        new AbortController().signal,
      )
      const mappings = JSON.parse(
        await readFile(join(store.paths('native').inputs, 'opencode-mappings.json'), 'utf8'),
      )
      const substituteRoot = join(root, 'substitute')
      for (const skill of mappings.skills) {
        await mkdir(join(substituteRoot, skill.name), { recursive: true })
        await writeFile(
          join(substituteRoot, skill.name, 'SKILL.md'),
          `---\nname: ${skill.name}\ndescription: Substituted native source\n---\nPRIVATE_SUBSTITUTE_BODY`,
        )
      }
      const substituted = {
        ...launch,
        environment: {
          ...launch.environment,
          OPENCODE_CONFIG_CONTENT: JSON.stringify({ skills: { paths: [substituteRoot] } }),
        },
      }
      const beforeMismatch = requests.length
      const substitutedSkills = JSON.parse(await capture(substituted, ['debug', 'skill', '--pure']))
      expect(
        substitutedSkills.some(
          (skill: { name: string; location: string }) =>
            skill.name === mappings.skills[0].name && skill.location.startsWith(substituteRoot),
        ),
      ).toBe(true)
      await expect(
        verifyOpenCodeSkillReadback(
          manifest,
          store.paths('native'),
          substituted,
          new AbortController().signal,
        ),
      ).rejects.toMatchObject({
        diagnostic: { check: 'opencode-skills', reason: 'mismatch', fields: ['skills'] },
      })
      expect(requests.length).toBe(beforeMismatch)
      expect(JSON.stringify(skills)).toContain('SKILL_MARKER')
      expect(JSON.stringify(skills)).toContain('DIRECTORY_SKILL_MARKER')
      expect(
        await readFile(
          join(store.paths('native').inputs, 'skills/directory-check/references/context.md'),
          'utf8',
        ),
      ).toBe('Captured reference bytes')
      await rm(skillSource, { recursive: true })
      await rm(captures.root, { recursive: true })
      expect(await store.read('native')).toEqual(manifest)
      const updates: RuntimeOutput[] = []
      let permissions = 0
      const controller = new AbortController()
      const connectOptions = {
        store,
        snapshotId: 'native',
        resolveSecret: async () => key,
        environment: { ...process.env, HOME: home },
        signal: controller.signal,
      }
      runtime = await connectOpenCode(connectOptions)
      const handlers: RuntimeTurnHandlers = {
        output: async (event) => {
          updates.push(event)
        },
        interaction: async (request) => {
          permissions++
          if (request.kind !== 'permission') throw new Error('Unexpected interaction')
          const optionId = request.options.find((candidate) => candidate.kind === 'allow_once')?.id
          return optionId ? { kind: 'choice', optionId } : { kind: 'cancelled' }
        },
      }
      const response = await runtime.send('Read fixture.txt, then report its marker.', handlers)
      expect(response.nativeStopReason).toBe('end_turn')
      expect(requests.length).toBeGreaterThanOrEqual(4)
      expect(
        requests.every(
          (request) =>
            request.model === 'fixture-model' &&
            request.authorization === `Bearer ${key}` &&
            request.hasRole &&
            request.hasAppend,
        ),
      ).toBe(true)
      expect(requests.some((request) => request.hasToolResult)).toBe(true)
      expect(requests.some((request) => request.hasMcpResult)).toBe(true)
      expect(requests.some((request) => request.hasSkillResult)).toBe(true)
      expect(permissions).toBeGreaterThanOrEqual(3)
      expect(
        updates.some((event) => event.kind === 'tool.updated' && event.status === 'completed'),
      ).toBe(true)
      const text = updates
        .flatMap((event) =>
          event.kind === 'message.delta' && event.channel === 'assistant' ? [event.text] : [],
        )
        .join('')
      expect(text).toContain('Verified TOOL_RESULT_MARKER')
      phase = 'stream'
      const streamStarted = new Promise<void>((resolve) => {
        streaming = resolve
      })
      const streamingTurn = runtime.send('Stream until cancelled.', handlers)
      await streamStarted
      await runtime.cancel()
      expect((await streamingTurn).outcome).toBe('cancelled')
      phase = 'permission'
      let permissionArrived = () => {}
      const waiting = new Promise<void>((resolve) => {
        permissionArrived = resolve
      })
      let permissionAborted = false
      const pendingTurn = runtime.send('Read fixture.txt again.', {
        ...handlers,
        interaction: async (_request, signal) =>
          new Promise<{ kind: 'cancelled' }>((resolve) => {
            signal.addEventListener(
              'abort',
              () => {
                permissionAborted = true
                resolve({ kind: 'cancelled' })
              },
              { once: true },
            )
            permissionArrived()
          }),
      })
      await waiting
      await runtime.cancel()
      expect((await pendingTurn).outcome).toBe('cancelled')
      expect(permissionAborted).toBe(true)
      const previousNativeSessionId = runtime.nativeSessionId
      await runtime.dispose()
      phase = 'resume'
      runtime = await connectOpenCode({ ...connectOptions, previousNativeSessionId })
      expect(runtime.nativeSessionId).toBe(previousNativeSessionId)
      updates.length = 0
      const resumed = await runtime.send('Report the retained context.', handlers)
      expect(resumed.outcome).toBe('completed')
      expect(requests.at(-1)).toMatchObject({
        hasToolResult: true,
        hasMcpResult: true,
        hasSkillResult: true,
      })
      expect(
        updates.flatMap((event) => (event.kind === 'message.delta' ? [event.text] : [])).join(''),
      ).toContain('RESUMED_MARKER')
      phase = 'permission'
      await expect(
        runtime.send('Read fixture.txt once more.', {
          ...handlers,
          interaction: async () => {
            throw new Error('Private persistence failure')
          },
        }),
      ).rejects.toMatchObject({ code: 'storage' })
      await runtime.closed
      await runtime.dispose()
      expect(await store.verifyForReuse('native')).toEqual(manifest)

      // Exercise the same production runtime through durable application commands.
      const journalDirectory = join(root, 'sessions')
      let managedConnections = 0
      const factory: SessionRuntimeFactory = {
        create: async () => ({
          agentId: manifest.agent.id,
          installationId: manifest.installation.id,
          engineVersion: manifest.installation.version!,
          mode: manifest.launch.mode,
          cwd: manifest.cwd,
          snapshotId: 'native',
          snapshotDigest: manifest.digest,
        }),
        connect: async (snapshot, signal) => {
          managedConnections++
          return connectOpenCode({
            ...connectOptions,
            signal,
            ...(snapshot.status === 'resuming'
              ? { previousNativeSessionId: snapshot.nativeSessionId! }
              : {}),
          })
        },
      }
      coordinator = new SessionCoordinator(new SessionJournal(journalDirectory), factory)
      const created = await coordinator.command({
        kind: 'create',
        commandId: 'managed-create',
        agentId: manifest.agent.id,
      })
      const managedId = created.id
      const waitForStatus = async (status: SessionSnapshot['status']) => {
        await vi.waitFor(
          async () => {
            const state = await coordinator!.get({ sessionId: managedId })
            if (state.status === 'failed')
              throw new Error(`Managed session failed: ${state.failure?.code}`)
            expect(state.status).toBe(status)
          },
          { timeout: 20_000, interval: 25 },
        )
        return coordinator!.get({ sessionId: managedId })
      }
      const deliveries: SessionDelivery[] = []
      await coordinator.subscribe(
        'fixture-frame',
        { sessionId: managedId, subscriptionId: 'fixture', afterCursor: 0 },
        (event) => deliveries.push(event),
      )
      await coordinator.command({ kind: 'start', commandId: 'managed-start', sessionId: managedId })
      const managedReady = await waitForStatus('ready')
      phase = 'permission'
      const managedSend = {
        kind: 'send' as const,
        commandId: 'managed-send',
        sessionId: managedId,
        runId: managedReady.runId!,
        messageId: 'managed-user',
        text: `Read fixture.txt. Secret: ${key}`,
      }
      await coordinator.command(managedSend)
      const managedWaiting = await waitForStatus('waiting')
      const request = managedWaiting.pendingRequests[0]!
      if (request.kind !== 'permission') throw new Error('Missing managed permission')
      phase = 'resume'
      await coordinator.command({
        kind: 'respond',
        commandId: 'managed-approve',
        sessionId: managedId,
        runId: managedReady.runId!,
        turnId: managedWaiting.activeTurn!.id,
        requestId: request.id,
        response: {
          kind: 'choice',
          optionId: request.options.find((option) => option.kind === 'allow_once')!.id,
        },
      })
      const managedFinished = await waitForStatus('ready')
      expect(managedFinished.lastTurn?.outcome).toBe('completed')
      const requestCount = mainRequests
      await coordinator.command(managedSend)
      expect(mainRequests).toBe(requestCount)
      const managedHistory = await coordinator.readEvents({
        sessionId: managedId,
        afterCursor: 0,
        limit: 500,
      })
      expect(JSON.stringify(managedHistory)).not.toContain(key)
      expect(
        managedHistory.events.some((event) => event.data.kind === 'interaction.resolved'),
      ).toBe(true)
      await vi.waitFor(() =>
        expect(deliveries.filter((event) => event.kind === 'event').length).toBe(
          managedHistory.events.length,
        ),
      )
      expect(
        deliveries.flatMap((delivery) => (delivery.kind === 'event' ? [delivery.event] : [])),
      ).toEqual(managedHistory.events)
      await coordinator.shutdown()
      expect((await coordinator.get({ sessionId: managedId })).status).toBe('interrupted')
      coordinator = new SessionCoordinator(new SessionJournal(journalDirectory), factory)
      await coordinator.command(managedSend)
      expect(managedConnections).toBe(1)
      await coordinator.command({
        kind: 'resume',
        commandId: 'managed-resume',
        sessionId: managedId,
        previousRunId: managedReady.runId!,
      })
      const managedResumed = await waitForStatus('ready')
      expect(managedResumed.runId).not.toBe(managedReady.runId)
      expect(managedResumed.nativeSessionId).toBe(managedReady.nativeSessionId)
      await coordinator.command({
        ...managedSend,
        commandId: 'resumed-send',
        runId: managedResumed.runId!,
        messageId: 'resumed-user',
        text: 'Report retained context.',
      })
      await waitForStatus('ready')
      expect(requests.at(-1)?.hasToolResult).toBe(true)
      await coordinator.command({
        kind: 'close',
        commandId: 'managed-close',
        sessionId: managedId,
        runId: managedResumed.runId,
      })
      await waitForStatus('closed')
      expect(await store.verifyForReuse('native')).toEqual(manifest)
      const nativePath = join(cwd, 'opencode.jsonc')
      const nativeContents =
        '{\n  // Preserved native project setting\n  "$schema": "https://opencode.ai/config.json",\n  "agent": { "build": { "prompt": "NATIVE_OVERRIDE_MARKER" } },\n  "compaction": { "auto": false }\n}\n'
      await writeFile(nativePath, nativeContents)
      const overridden = JSON.parse(await capture(launch, ['debug', 'config', '--pure']))
      expect(overridden.agent.build.prompt).toBe('NATIVE_OVERRIDE_MARKER')
      expect(overridden.compaction.auto).toBe(false)
      expect(await readFile(nativePath, 'utf8')).toBe(nativeContents)
      await expect(
        verifyOpenCodeReadback(manifest, store.paths('native'), launch, controller.signal),
      ).rejects.toMatchObject({
        code: 'configuration',
        field: 'native.override',
        diagnostic: { check: 'opencode-config', reason: 'mismatch', fields: ['prompts'] },
      })
      await expect(
        prepareRunLaunch(store, 'native', async () => key, { HOME: home }),
      ).rejects.toThrow('error.runSourceChanged')
      await rm(nativePath)
      expect(await store.verifyForReuse('native')).toEqual(manifest)
      const markdownOverride = join(cwd, '.opencode/agents/build.md')
      const markdownContents =
        '---\ndescription: Native override probe\n---\nMARKDOWN_OVERRIDE_MARKER\n'
      await writeFile(markdownOverride, markdownContents)
      const markdownConfig = JSON.parse(await capture(launch, ['debug', 'config', '--pure']))
      expect(markdownConfig.agent.build.prompt).toBe('MARKDOWN_OVERRIDE_MARKER')
      await expect(
        verifyOpenCodeReadback(manifest, store.paths('native'), launch, controller.signal),
      ).rejects.toMatchObject({ code: 'configuration', field: 'native.override' })
      const resolveAfterDrift = vi.fn(async () => key)
      await expect(
        prepareRunLaunch(store, 'native', resolveAfterDrift, { HOME: home }),
      ).rejects.toThrow('error.runSourceChanged')
      expect(resolveAfterDrift).not.toHaveBeenCalled()
      expect(await readFile(markdownOverride, 'utf8')).toBe(markdownContents)
      expect(await store.read('native')).toEqual(manifest)
      await rm(markdownOverride)
      expect(await store.verifyForReuse('native')).toEqual(manifest)
      if (process.env.AGENT_MATRIX_OPENCODE_REPORT)
        await writeFile(
          process.env.AGENT_MATRIX_OPENCODE_REPORT,
          JSON.stringify(
            {
              checkedAt: new Date().toISOString(),
              engine: 'opencode',
              engineVersion: version,
              platform: process.platform,
              architecture: process.arch,
              route:
                'Local OpenAI Chat Completions protocol fixture; not an intended external provider',
              externalProviderCalls: false,
              configReadback: true,
              promptAndInstructionObserved: true,
              skillDiscovery: true,
              capturedSkillSourcePreflight: true,
              sameNameForeignSkillRejected: true,
              directorySkillInvocation: true,
              inputIntegrityAfterEngineExit: true,
              streamedResponse: true,
              permissionReplies: permissions,
              toolRoundTrip: true,
              mcpStdioRoundTrip: true,
              mcpCwdAndSecretEnvironment: true,
              credentialInterpolation: true,
              cancellationDuringStreaming: true,
              cancellationDuringPermission: true,
              permissionPersistenceFailureClosesRuntime: true,
              durableCoordinator:
                'Create/start/send/permission/events/shutdown/restart/resume/close with the production OpenCode runtime',
              commandReplayDoesNotResubmit: true,
              managedJournalCredentialRedaction: true,
              nativeResume:
                'Same native session ID and retained file/Skill/MCP history after process restart',
              nativeOverrides:
                'Project prompt override rejected by readback; native file preserved; changed source blocks snapshot reuse',
              nativeResourceInventory: {
                projectNestedAgent: true,
                globalCommand: true,
                homeMode: true,
                nestedModeIgnored: true,
                markdownPromptOverrideRejected: true,
                newFileBlocksReuseBeforeCredentialResolution: true,
                originalSnapshotAndNativeContentPreserved: true,
                restoredSourceAllowsReuse: true,
              },
              productionRuntime:
                'OpenCode runtime and durable coordinator exercised; desktop factory, IPC, and UI are not connected',
            },
            null,
            2,
          ) + '\n',
        )
    } finally {
      await coordinator?.shutdown()
      await runtime?.dispose()
      server.closeAllConnections()
      await new Promise<void>((resolve) => server.close(() => resolve()))
      await rm(root, { recursive: true, force: true })
    }
  },
)
