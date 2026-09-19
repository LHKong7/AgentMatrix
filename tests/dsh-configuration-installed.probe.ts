import { createServer } from 'node:http'
import { mkdir, mkdtemp, readFile, realpath, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { RunInputStore } from '../src/main/engines/run-input-store'
import { SkillDirectoryStore } from '../src/main/assets/skill-directory-store'
import { inspectDshComposition } from '../src/main/engines/adapters/dsh/composition'
import { prepareDshSkillAttachment } from '../src/main/engines/adapters/dsh/skills'
import { planDsh } from '../src/main/engines/adapters/dsh/configuration'
import { prepareDshLaunch, verifyDshHome } from '../src/main/engines/adapters/dsh/launch'
import { attachAcpProcess, type AcpAttachment } from '../src/main/engines/acp/attachment'
import { dshWorkspace } from './helpers/dsh-fixture'
import { closeNativeFixture } from './helpers/close-native-fixture'

const executable = process.env.AGENT_MATRIX_TEST_DSH
for (const route of ['pi-ai', 'deepseek-native'] as const) {
  it.runIf(Boolean(executable))(`applies captured DSH configuration through ${route}`, async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'agentmatrix-dsh-config-')))
    const cwd = join(root, 'project'),
      home = join(root, 'home'),
      source = join(root, 'source'),
      mcpCwd = join(root, 'mcp')
    for (const path of [join(cwd, '.git'), home, join(source, 'references'), mcpCwd])
      await mkdir(path, { recursive: true })
    await writeFile(join(cwd, 'AGENTS.md'), 'DSH_PROJECT_RULE_MARKER')
    await writeFile(
      join(source, 'SKILL.md'),
      '---\nname: fixture-skill\ndescription: DSH_SKILL_DESCRIPTION\n---\nDSH_SKILL_BODY Read references/guide.md.',
    )
    await writeFile(join(source, 'references/guide.md'), 'DSH_SKILL_REFERENCE')
    const key = 'synthetic-"dsh"-$HOME-key',
      literal = '!literal $HOME {{unknown}}'
    const script = join(root, 'mcp.cjs')
    await writeFile(
      script,
      `const readline = require('node:readline');
readline.createInterface({ input: process.stdin }).on('line', line => {
  const q = JSON.parse(line); if (q.id === undefined) return;
  let result = {};
  if (q.method === 'initialize') result = { protocolVersion:q.params.protocolVersion, serverInfo:{name:'fixture',version:'1.0.0'}, capabilities:{tools:{}} };
  if (q.method === 'tools/list') result = { tools:[{name:'marker',description:'Fixture',inputSchema:{type:'object',properties:{}}}] };
  if (q.method === 'tools/call') result = { content:[{type:'text',text:process.env.MCP_KEY === ${JSON.stringify(key)} && process.env.AGENT_MATRIX_SECRET_1 === undefined && process.cwd() === ${JSON.stringify(mcpCwd)} && process.argv[2] === 'literal;argument' ? 'DSH_MCP_MARKER' : 'INVALID_MCP_CONFIG'}] };
  process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:q.id,result})+'\\n');
});`,
    )
    const skills = new SkillDirectoryStore(join(root, 'captures'))
    const captured = await skills.capture(source)
    const store = new RunInputStore(join(root, 'runs'), skills)
    const workspace = dshWorkspace(executable!, cwd)
    workspace.skills.push({
      id: 'directory',
      name: 'Directory',
      description: '',
      enabled: true,
      sourcePath: source,
      currentVersion: 1,
      versions: [captured.snapshot],
    })
    workspace.agents[0]!.skillBindings.push({
      assetId: 'directory',
      selection: { follow: 'latest' },
    })
    workspace.prompts[0]!.versions[0]!.content = 'DSH_COMPLETE_MARKER literal {{unknown}} $HOME'
    workspace.connections[0]!.headers = route === 'pi-ai' ? { 'X-Literal': literal } : {}
    workspace.connections[0]!.secretHeaders =
      route === 'pi-ai' ? { 'X-Secret': { kind: 'environment', name: 'PROBE_KEY' } } : {}
    if (route === 'deepseek-native') workspace.connections[0]!.protocol = 'deepseek-official'
    workspace.mcpServers = [
      {
        id: 'fixture',
        name: 'Fixture',
        description: '',
        enabled: true,
        transport: 'stdio',
        command: process.execPath,
        args: [script, 'literal;argument'],
        cwd: mcpCwd,
        environment: {},
        envRefs: { MCP_KEY: { kind: 'environment', name: 'PROBE_KEY' } },
      },
    ]
    workspace.agents[0]!.mcpServerIds = ['fixture']
    let phase: 'skills' | 'text' | 'ask' | 'deny' = 'skills',
      step = 0,
      serverError: unknown = null
    const bodies: string[] = [],
      attachments: AcpAttachment[] = []
    let approvals = 0
    let inputs = 'first'
    const deniedTarget = join(cwd, 'denied.txt')
    const server = createServer(async (request, response) => {
      try {
        let body = ''
        for await (const chunk of request) {
          body += String(chunk)
          if (body.length > 4_194_304) throw new Error('Fixture request bound')
        }
        bodies.push(body)
        const input = JSON.parse(body)
        expect(request.url).toBe('/v1/chat/completions')
        expect(request.headers.authorization).toBe(`Bearer ${key}`)
        expect(input.model).toBe('fixture-model')
        if (route === 'pi-ai') {
          expect(request.headers['x-secret']).toBe(key)
          expect(request.headers['x-literal']).toBe(literal)
        }
        response.writeHead(200, { 'Content-Type': 'text/event-stream' })
        const chunk = (delta: object, finish_reason: string | null = null) =>
          response.write(
            `data: ${JSON.stringify({ id: 'fixture', object: 'chat.completion.chunk', created: 1, model: input.model, choices: [{ index: 0, delta, finish_reason }] })}\n\n`,
          )
        const current = step++
        const tool = (name: string, args: object) => {
          chunk({
            role: 'assistant',
            tool_calls: [
              {
                index: 0,
                id: `tool-${current}`,
                type: 'function',
                function: { name, arguments: JSON.stringify(args) },
              },
            ],
          })
          chunk({}, 'tool_calls')
        }
        if (phase === 'skills' && current === 0) tool('skill', { name: 'fixture-skill' })
        else if (phase === 'skills' && current === 1)
          tool('read', {
            file_path: join(store.paths(inputs).inputs, 'skills/fixture-skill/references/guide.md'),
          })
        else if (phase === 'skills' && current === 2) {
          const mcp = input.tools.find((t: { function: { name: string } }) =>
            t.function.name.endsWith('__marker'),
          )
          expect(mcp).toBeTruthy()
          tool(mcp.function.name, {})
        } else if (phase === 'ask' && current === 0)
          tool('read', { file_path: join(cwd, 'AGENTS.md') })
        else if (phase === 'deny' && current === 0)
          tool('write', { file_path: deniedTarget, content: 'Must not execute' })
        else {
          chunk({ role: 'assistant', content: 'DSH_CONFIG_REPLY' })
          chunk({}, 'stop')
        }
        response.end('data: [DONE]\n\n')
      } catch (error) {
        serverError = error
        response.writeHead(500)
        response.end()
      }
    })
    try {
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
      const address = server.address()
      if (!address || typeof address === 'string') throw new Error('Missing fixture address')
      workspace.connections[0]!.baseUrl = `http://127.0.0.1:${address.port}/v1`
      const composition = await inspectDshComposition(executable!, cwd)
      const capture = (id: string) =>
        store.create(id, workspace, 'reviewer', (configuration, paths) =>
          planDsh(configuration, paths, {
            composition,
            readSkillEntry: async (skill) => {
              if (skill.revision.kind !== 'directory') throw new Error('Unexpected Skill')
              return readFile(join(await skills.verify(skill.revision), 'SKILL.md'), 'utf8')
            },
          }),
        )
      const run = async (id: string) => {
        inputs = id
        step = 0
        const prepared = await prepareDshLaunch(
          store,
          id,
          async () => key,
          { ...process.env, HOME: home },
          new AbortController().signal,
        )
        const sourceObserver = await prepareDshSkillAttachment(prepared.manifest, store.paths(id))
        Object.assign(prepared.launch.environment, sourceObserver.environment)
        const child = await attachAcpProcess(
          prepared.launch,
          {
            update: async () => {},
            permission: async (request) => {
              approvals++
              const option = request.options.find((value) => value.kind === 'allow_once')
              if (!option) throw new Error('No allow option')
              return { outcome: { outcome: 'selected', optionId: option.optionId } }
            },
          },
          { requestTimeoutMs: 20_000 },
        )
        attachments.push(child)
        await child.client.initialize('0.1.0')
        const session = await child.client.newSession({ cwd, mcpServers: [] })
        await sourceObserver.verify(child.process.pid, child.client.signal, session.sessionId)
        await child.client.prompt(
          {
            sessionId: session.sessionId,
            prompt: [{ type: 'text', text: 'Run the configuration fixture.' }],
          },
          30_000,
        )
        await sourceObserver.verify(child.process.pid, child.client.signal, session.sessionId)
        await child.close()
        await sourceObserver.cleanup()
        await verifyDshHome(store, id)
        await store.verifyForReuse(id)
        expect(serverError).toBeNull()
      }
      await capture('first')
      await run('first')
      expect(bodies.at(-1)).toContain('DSH_SKILL_BODY')
      expect(bodies.at(-1)).toContain('DSH_SKILL_REFERENCE')
      expect(bodies.at(-1)).toContain('DSH_MCP_MARKER')
      expect(bodies[0]).toContain('DSH_PROJECT_RULE_MARKER')
      const firstBody = JSON.parse(bodies[0]!)
      const system = JSON.stringify(
        firstBody.messages.filter((message: { role: string }) => message.role === 'system'),
      )
      expect(system).toContain('DSH_COMPLETE_MARKER literal {{unknown}} $HOME')
      expect(system).toContain('APPEND_MARKER')
      expect(system).not.toContain('You are an AI agent powered by DeepSeek Harness.')
      expect(approvals).toBe(0)
      workspace.prompts[0]!.versions.push({ version: 2, content: 'DSH_NEW_ROLE_MARKER' })
      workspace.prompts[0]!.currentVersion = 2
      phase = 'text'
      await capture('second')
      await run('first')
      expect(bodies.at(-1)).toContain('DSH_COMPLETE_MARKER')
      expect(bodies.at(-1)).not.toContain('DSH_NEW_ROLE_MARKER')
      await run('second')
      expect(bodies.at(-1)).toContain('DSH_NEW_ROLE_MARKER')
      workspace.agents[0]!.promptBindings[0]!.mode = 'append'
      workspace.agents[0]!.execution.approval = 'ask'
      phase = 'ask'
      await capture('ask')
      await run('ask')
      expect(approvals).toBe(1)
      expect(bodies.at(-1)).toContain('You are an AI agent powered by DeepSeek Harness.')
      expect(bodies.at(-1)).toContain('DSH_NEW_ROLE_MARKER')
      workspace.agents[0]!.execution.approval = 'deny'
      workspace.agents[0]!.engineOptions = {
        kind: 'deepseek-harness',
        profileTemplate: 'acp',
        patchReload: 'startup',
        appendPosition: 'prefix',
      }
      phase = 'text'
      await capture('prefix')
      await run('prefix')
      const prefixSystem = JSON.stringify(
        JSON.parse(bodies.at(-1)!).messages.filter(
          (message: { role: string }) => message.role === 'system',
        ),
      )
      expect(prefixSystem.indexOf('DSH_NEW_ROLE_MARKER')).toBeGreaterThan(-1)
      expect(prefixSystem.indexOf('DSH_NEW_ROLE_MARKER')).toBeLessThan(
        prefixSystem.indexOf('Your working directory is'),
      )
      phase = 'deny'
      await capture('deny')
      await run('deny')
      await expect(readFile(deniedTarget)).rejects.toMatchObject({ code: 'ENOENT' })
      expect(bodies.at(-1)).toContain('Tool execution is disabled by the AgentMatrix profile.')
      expect(approvals).toBe(1)
      expect(
        await readFile(join(store.paths('first').root, 'manifest.json'), 'utf8'),
      ).not.toContain(key)
      if (process.env.AGENT_MATRIX_DSH_CONFIGURATION_REPORT)
        await writeFile(
          `${process.env.AGENT_MATRIX_DSH_CONFIGURATION_REPORT}.${route}.json`,
          JSON.stringify(
            {
              checkedAt: new Date().toISOString(),
              platform: process.platform,
              architecture: process.arch,
              route,
              engineVersion: '0.1.5-rc.2',
              externalProviderCalls: false,
              compositionReadback: true,
              completePromptAndLiteralBraces: true,
              appendKeepsNativeIdentity: true,
              personaPrefixAndSuffix: true,
              projectRulesPreserved: true,
              directorySkillInvocation: true,
              sessionScopedSkillSources: true,
              skillReferenceRead: true,
              mcpStdioSecretEnvironmentAndCwd: true,
              mcpProviderCredentialIsolation: true,
              oldAndNewPromptSnapshots: true,
              toolApproval: true,
              toolDenial: true,
              providerCalls: bodies.length,
            },
            null,
            2,
          ) + '\n',
        )
    } finally {
      await closeNativeFixture(attachments, server, root)
    }
  })
}
