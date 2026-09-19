import { execFile } from 'node:child_process'
import { createServer } from 'node:http'
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { expect, it } from 'vitest'
import { SkillDirectoryStore } from '../src/main/assets/skill-directory-store'
import { RunInputStore } from '../src/main/engines/run-input-store'
import { planOpenCode } from '../src/main/engines/adapters/opencode/configuration'
import { inspectOpenCodeSources } from '../src/main/engines/adapters/opencode/sources'
import { connectOpenCode } from '../src/main/engines/adapters/opencode/runtime'
import type { RuntimeSession } from '../src/main/engines/runtime'
import { openCodeWorkspace } from './helpers/opencode-fixture'
import { closeNativeFixture } from './helpers/close-native-fixture'

it.runIf(Boolean(process.env.AGENT_MATRIX_TEST_OPENCODE))(
  'captures native instruction matches and rejects changed files before startup, resume and turns',
  async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'agentmatrix-native-instructions-')))
    const project = join(root, 'project'),
      cwd = join(project, 'nested'),
      home = join(root, 'home'),
      configHome = join(root, 'config')
    const runtimes: RuntimeSession[] = []
    let calls = 0,
      resolutions = 0
    const bodies: string[] = []
    const server = createServer(async (request, response) => {
      const parts = []
      for await (const part of request) parts.push(part)
      const raw = Buffer.concat(parts).toString('utf8'),
        body = JSON.parse(raw)
      calls++
      bodies.push(raw)
      if (!body.stream) {
        response.writeHead(200, { 'Content-Type': 'application/json' }).end(
          JSON.stringify({
            id: 'fixture',
            object: 'chat.completion',
            created: 1,
            model: body.model,
            choices: [
              {
                index: 0,
                message: { role: 'assistant', content: 'Fixture' },
                finish_reason: 'stop',
              },
            ],
          }),
        )
        return
      }
      response.writeHead(200, { 'Content-Type': 'text/event-stream' })
      for (const [delta, finish_reason] of [
        [{ role: 'assistant', content: 'RULE_REPLY' }, null],
        [{}, 'stop'],
      ])
        response.write(
          `data: ${JSON.stringify({ id: 'fixture', object: 'chat.completion.chunk', created: 1, model: body.model, choices: [{ index: 0, delta, finish_reason }] })}\n\n`,
        )
      response.end('data: [DONE]\n\n')
    })
    try {
      for (const path of [
        cwd,
        home,
        join(configHome, 'opencode'),
        join(cwd, 'rules'),
        join(project, 'rules'),
      ])
        await mkdir(path, { recursive: true })
      await promisify(execFile)('git', ['init', '-q', project])
      const first = join(cwd, 'rules/one.md'),
        added = join(cwd, 'rules/added.md'),
        empty = join(cwd, 'later.md')
      const contents = new Map([
        [first, 'NATIVE_RULE_ONE'],
        [join(cwd, 'rules/.hidden.txt'), 'NATIVE_HIDDEN_RULE'],
        [join(project, 'rules/parent.md'), 'NATIVE_PARENT_RULE'],
        [join(home, 'home-rule.txt'), 'NATIVE_HOME_RULE'],
      ])
      for (const [path, content] of contents) await writeFile(path, content)
      await writeFile(
        join(cwd, 'opencode.json'),
        JSON.stringify({
          $schema: 'https://opencode.ai/config.json',
          instructions: ['rules/*.{md,txt}', 'later.md', '~/home-rule.txt'],
        }),
      )
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
      const address = server.address()
      if (!address || typeof address === 'string') throw new Error('Missing address')
      const workspace = openCodeWorkspace(process.env.AGENT_MATRIX_TEST_OPENCODE!, cwd)
      workspace.connections[0]!.baseUrl = `http://127.0.0.1:${address.port}/v1`
      workspace.agents[0]!.skillBindings = []
      workspace.skills = []
      const store = new RunInputStore(
        join(root, 'runs'),
        new SkillDirectoryStore(join(root, 'skills')),
      )
      const manifest = await store.create(
        'capture',
        workspace,
        'reviewer',
        async (configuration, paths) => {
          const plan = await planOpenCode(configuration, paths, {
            configHome,
            sources: await inspectOpenCodeSources(cwd, { home, configHome }),
            readSkillEntry: async () => '',
          })
          for (const [name, value] of Object.entries({
            OPENCODE_TEST_HOME: home,
            OPENCODE_DISABLE_MODELS_FETCH: 'true',
            OPENCODE_DISABLE_DEFAULT_PLUGINS: 'true',
            OPENCODE_DISABLE_CLAUDE_CODE: 'true',
            OPENCODE_DISABLE_EXTERNAL_SKILLS: 'true',
          }))
            plan.launch.environment[name] = { kind: 'literal', value }
          return plan
        },
      )
      const manifestBefore = await readFile(
        join(store.paths('capture').root, 'manifest.json'),
        'utf8',
      )
      expect(
        manifest.externalSources
          .instructionSources!.patterns.flatMap((entry) => entry.files.map((file) => file.path))
          .sort(),
      ).toEqual([...contents.keys()].sort())
      for (const content of contents.values())
        expect(JSON.stringify(manifest)).not.toContain(content)
      const connect = async (previousNativeSessionId?: string) => {
        const runtime = await connectOpenCode({
          store,
          snapshotId: 'capture',
          previousNativeSessionId,
          environment: { ...process.env, HOME: home },
          resolveSecret: async () => {
            resolutions++
            return 'synthetic-instruction-key'
          },
          signal: new AbortController().signal,
        })
        runtimes.push(runtime)
        return runtime
      }
      const handlers = {
        output: async () => {},
        interaction: async () => ({ kind: 'cancelled' as const }),
      }
      let runtime = await connect()
      expect((await runtime.send('Read the system instructions.', handlers)).outcome).toBe(
        'completed',
      )
      for (const content of contents.values())
        expect(bodies.some((body) => body.includes(content))).toBe(true)
      await writeFile(first, 'NATIVE_CHANGED_RULE')
      const before = calls
      await expect(
        runtime.send('This must not reach the provider.', handlers),
      ).rejects.toMatchObject({
        diagnostic: { check: 'sources', reason: 'changed', fields: ['prompts'] },
      })
      expect(calls).toBe(before)
      const nativeId = runtime.nativeSessionId
      await runtime.dispose()
      for (const change of ['edit', 'add', 'empty-match'] as const) {
        await writeFile(first, contents.get(first)!)
        if (change === 'edit') await writeFile(first, 'CHANGED')
        if (change === 'add') await writeFile(added, 'NEW')
        if (change === 'empty-match') await writeFile(empty, 'NEW')
        const count = resolutions
        await expect(connect(nativeId)).rejects.toThrow('error.runSourceChanged')
        await expect(connect()).rejects.toThrow('error.runSourceChanged')
        expect(resolutions).toBe(count)
        expect(calls).toBe(before)
        await rm(added, { force: true })
        await rm(empty, { force: true })
      }
      await writeFile(first, contents.get(first)!)
      runtime = await connect(nativeId)
      expect(runtime.nativeSessionId).toBe(nativeId)
      expect((await runtime.send('Continue with the original rules.', handlers)).outcome).toBe(
        'completed',
      )
      expect(await readFile(join(store.paths('capture').root, 'manifest.json'), 'utf8')).toBe(
        manifestBefore,
      )
      await runtime.dispose()
      if (process.env.AGENT_MATRIX_INSTRUCTION_REPORT)
        await writeFile(
          process.env.AGENT_MATRIX_INSTRUCTION_REPORT,
          JSON.stringify(
            {
              checkedAt: new Date().toISOString(),
              platform: process.platform,
              architecture: process.arch,
              engine: 'opencode',
              version: '1.18.16',
              externalProviderCalls: false,
              localProviderRequests: calls,
              literalGlobHomeAndAncestorRulesReachModel: true,
              noRuleBodiesInManifest: true,
              changedRuleBlocksActiveTurn: true,
              changedAddedAndPreviouslyUnmatchedRulesBlockStartAndResume: true,
              rejectionBeforeCredentialResolution: true,
              originalNativeConversationRestored: true,
              immutableManifestPreserved: true,
            },
            null,
            2,
          ) + '\n',
        )
    } finally {
      await closeNativeFixture(
        runtimes.map((runtime) => ({ close: () => runtime.dispose() })),
        server,
        root,
      )
    }
  },
  120_000,
)
