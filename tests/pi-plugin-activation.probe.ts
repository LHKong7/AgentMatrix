import { createServer } from 'node:http'
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { SkillDirectoryStore } from '../src/main/assets/skill-directory-store'
import { RunInputStore } from '../src/main/engines/run-input-store'
import { planPi } from '../src/main/engines/adapters/pi/configuration'
import { connectPi } from '../src/main/engines/adapters/pi/runtime'
import type { RuntimeSession, RuntimeOutput } from '../src/main/engines/runtime'
import { piWorkspace } from './helpers/pi-fixture'

it.runIf(Boolean(process.env.AGENT_MATRIX_TEST_PI))(
  'loads selected installed Pi extensions and verifies factories, hooks, commands, dialogs and native resume',
  async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'agentmatrix-pi-activation-')))
    const cwd = join(root, 'project'),
      home = join(root, 'home'),
      installed = join(root, 'extensions 中文')
    const requests: { body: string; authorized: boolean }[] = []
    const runtimes: RuntimeSession[] = []
    const server = createServer(async (request, response) => {
      try {
        let body = ''
        for await (const chunk of request) {
          body += String(chunk)
          if (body.length > 4_194_304) throw new Error('Fixture limit')
        }
        const parsed = JSON.parse(body)
        requests.push({
          body,
          authorized: request.headers.authorization === 'Bearer synthetic-pi-plugin-key',
        })
        const result = parsed.messages.some(
          (message: { role: string; content: unknown }) =>
            message.role === 'tool' &&
            JSON.stringify(message.content).includes('PI_EXTENSION_TOOL_RESULT'),
        )
        response.writeHead(200, { 'Content-Type': 'text/event-stream' })
        const chunk = (delta: object, finish_reason: string | null = null) =>
          response.write(
            `data: ${JSON.stringify({ id: 'fixture', object: 'chat.completion.chunk', created: 1, model: parsed.model, choices: [{ index: 0, delta, finish_reason }] })}\n\n`,
          )
        if (!result) {
          chunk({
            role: 'assistant',
            tool_calls: [
              {
                index: 0,
                id: 'fixture-extension-tool',
                type: 'function',
                function: { name: 'fixture_extension_tool', arguments: '{}' },
              },
            ],
          })
          chunk({}, 'tool_calls')
        } else {
          chunk({ role: 'assistant', content: 'PI_EXTENSION_REPLY' })
          chunk({}, 'stop')
        }
        response.end('data: [DONE]\n\n')
      } catch {
        response.writeHead(400).end()
      }
    })
    try {
      await mkdir(cwd)
      await mkdir(home)
      await mkdir(installed)
      await mkdir(join(cwd, '.pi/extensions'), { recursive: true })
      await writeFile(join(cwd, '.pi/SYSTEM.md'), 'UNSELECTED_PROJECT_SYSTEM')
      await writeFile(
        join(cwd, '.pi/extensions/unselected.ts'),
        "export default (pi) => { pi.on('before_agent_start', (event) => ({systemPrompt: event.systemPrompt + ' UNSELECTED_EXTENSION'})); }",
      )
      await writeFile(
        join(installed, 'package.json'),
        JSON.stringify({
          name: '@fixture/pi-extensions',
          version: '1.2.3',
          pi: { extensions: ['./alpha.ts', './beta.ts'] },
          peerDependencies: { '@earendil-works/pi-coding-agent': '^0.85.0' },
        }),
      )
      await writeFile(
        join(installed, 'helper.ts'),
        "export const marker: string = 'PI_EXTENSION_BETA'\n",
      )
      await writeFile(
        join(installed, 'alpha.ts'),
        `import { Type } from 'typebox';
export default async function (pi) {
  await new Promise(resolve => setTimeout(resolve, 20));
  pi.on('session_start', (_event, ctx) => { if (!ctx.sessionManager.getSessionId()) throw new Error('Missing native session'); });
  pi.on('before_agent_start', (event) => ({ systemPrompt: event.systemPrompt + '\\nPI_EXTENSION_ALPHA' }));
  pi.registerTool({ name:'fixture_extension_tool', label:'Fixture', description:'Return the fixture result', parameters:Type.Object({}),
    async execute() { return { content:[{type:'text', text:'PI_EXTENSION_TOOL_RESULT'}], details:{} }; } });
  pi.registerCommand('fixture-confirm', { description:'Fixture confirmation', async handler(_args, ctx) {
    const confirmed = await ctx.ui.confirm('Fixture extension', 'Continue?');
    ctx.ui.notify(confirmed ? 'PI_EXTENSION_CONFIRMED' : 'PI_EXTENSION_CANCELLED', 'info');
  }});
  pi.on('input', (event) => event.text === 'HANDLE_WITHOUT_MODEL' ? { action:'handled' } : { action:'continue' });
}
`,
      )
      await writeFile(
        join(installed, 'beta.ts'),
        `import { marker } from './helper.ts';
export default (pi) => { pi.on('before_agent_start', (event) => ({systemPrompt:event.systemPrompt + '\\n' + marker})); };
`,
      )
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject)
        server.listen(0, '127.0.0.1', resolve)
      })
      const address = server.address()
      if (!address || typeof address === 'string') throw new Error('No fixture address')
      const workspace = piWorkspace(process.env.AGENT_MATRIX_TEST_PI!, cwd)
      workspace.agents[0]!.skillBindings = []
      workspace.agents[0]!.promptBindings = []
      workspace.connections[0]!.baseUrl = `http://127.0.0.1:${address.port}/v1`
      const plugin = (path: string) => ({
        id: 'selected',
        name: 'Fixture extensions',
        nativeId: 'label',
        version: '1.2.3',
        source: 'installed fixture',
        engineInstallationId: 'pi',
        path,
      })
      workspace.nativePlugins = [plugin(installed)]
      workspace.agents[0]!.nativePluginIds = ['selected']
      const store = new RunInputStore(
        join(root, 'runs'),
        new SkillDirectoryStore(join(root, 'skills')),
      )
      const capture = (id: string) =>
        store.create(id, workspace, 'reviewer', (configuration, paths) =>
          planPi(configuration, paths, {
            sources: { coverage: 'partial', files: [] },
            readSkillEntry: async () => '',
          }),
        )
      const connect = async (snapshotId: string, previousNativeSessionId?: string) => {
        const runtime = await connectPi({
          store,
          snapshotId,
          previousNativeSessionId,
          resolveSecret: async () => 'synthetic-pi-plugin-key',
          environment: { ...process.env, HOME: home },
          signal: new AbortController().signal,
        })
        runtimes.push(runtime)
        return runtime
      }
      const output: RuntimeOutput[] = []
      let confirmations = 0
      const handlers = {
        output: async (event: RuntimeOutput) => {
          output.push(event)
        },
        interaction: async () => {
          confirmations++
          return { kind: 'confirm' as const, accepted: true }
        },
      }
      await capture('success')
      let runtime = await connect('success')
      expect(runtime.configurationChecks).toContain('pi.plugins')
      const sessionId = runtime.nativeSessionId
      expect((await runtime.send('/fixture-confirm', handlers)).nativeStopReason).toBe(
        'extension-handled',
      )
      expect((await runtime.send('HANDLE_WITHOUT_MODEL', handlers)).nativeStopReason).toBe(
        'extension-handled',
      )
      expect(requests).toHaveLength(0)
      const first = await runtime.send('Use the fixture extension tool.', handlers)
      expect(first.outcome).toBe('completed')
      expect(output).toContainEqual(
        expect.objectContaining({
          kind: 'tool.updated',
          title: 'fixture_extension_tool',
          status: 'completed',
        }),
      )
      expect(
        requests.every(
          (request) =>
            request.authorized &&
            request.body.includes('PI_EXTENSION_ALPHA') &&
            request.body.includes('PI_EXTENSION_BETA') &&
            !request.body.includes('UNSELECTED_EXTENSION') &&
            !request.body.includes('UNSELECTED_PROJECT_SYSTEM'),
        ),
      ).toBe(true)
      const before = requests.length
      const command = await runtime.send('/fixture-confirm', handlers)
      expect(command).toMatchObject({ outcome: 'completed', nativeStopReason: 'extension-handled' })
      expect(confirmations).toBe(2)
      expect(output).toContainEqual(
        expect.objectContaining({ kind: 'engine.notice', text: 'PI_EXTENSION_CONFIRMED' }),
      )
      const handled = await runtime.send('HANDLE_WITHOUT_MODEL', handlers)
      expect(handled.nativeStopReason).toBe('extension-handled')
      expect(requests).toHaveLength(before)
      let waiting!: () => void
      const dialogWaiting = new Promise<void>((resolve) => {
        waiting = resolve
      })
      const cancelled = runtime.send('/fixture-confirm', {
        output: handlers.output,
        interaction: async (_request, signal) => {
          waiting()
          await new Promise<void>((resolve) =>
            signal.addEventListener('abort', () => resolve(), { once: true }),
          )
          return { kind: 'cancelled' }
        },
      })
      await dialogWaiting
      await runtime.cancel()
      expect((await cancelled).outcome).toBe('cancelled')
      expect(requests).toHaveLength(before)
      await runtime.dispose()
      await runtime.closed
      runtime = await connect('success', sessionId)
      expect(runtime.nativeSessionId).toBe(sessionId)
      expect(runtime.configurationChecks).toContain('pi.plugins')
      expect((await runtime.send('Reply again.', handlers)).outcome).toBe('completed')
      await runtime.dispose()
      await runtime.closed
      const rejected: string[] = []
      for (const [extension, source] of [
        ['cjs', 'module.exports = function (pi) { pi.on("session_start", () => {}); }'],
        ['mjs', 'export default function (pi) { pi.on("session_start", () => {}); }'],
      ]) {
        const path = join(root, `format.${extension}`)
        await writeFile(path, source!)
        workspace.nativePlugins = [plugin(path)]
        await capture(extension!)
        const format = await connect(extension!)
        expect(format.configurationChecks).toContain('pi.plugins')
        await format.dispose()
        await format.closed
      }
      for (const [id, source] of [
        ['import', "throw new Error('synthetic import failure'); export default () => {}"],
        ['factory', "export default async () => { throw new Error('synthetic factory failure') }"],
        [
          'startup',
          "export default (pi) => pi.on('session_start', () => { throw new Error('synthetic startup failure') })",
        ],
        [
          'resources',
          "export default (pi) => pi.on('resources_discover', () => { throw new Error('synthetic resources failure') })",
        ],
        ['missing-dependency', "import './absent.ts'; export default () => {}"],
        ['invalid-factory', 'export default {notAFactory: true}'],
      ]) {
        const path = join(root, `${id}.ts`)
        await writeFile(path, source!)
        workspace.nativePlugins = [plugin(path)]
        await capture(id!)
        await expect(connect(id!)).rejects.toThrow()
        rejected.push(id!)
      }
      await writeFile(join(installed, 'alpha.ts'), 'export default () => {}')
      await expect(connect('success', sessionId)).rejects.toThrow()
      rejected.push('changed-entry-on-resume')
      const report = {
        checkedAt: new Date().toISOString(),
        engine: 'pi',
        engineVersion: '0.85.1',
        platform: process.platform,
        arch: process.arch,
        explicitMultiEntryPackage: true,
        asyncFactoryAwaited: true,
        relativeTypeScriptImport: true,
        virtualTypeboxImport: true,
        customToolReachedProvider: true,
        systemHooksReachedProvider: true,
        disabledAmbientDiscovery: true,
        projectTrustDenyPreserved: true,
        extensionCommandDialog: true,
        extensionCommandCancellation: true,
        extensionWorkBeforeFirstModelReply: true,
        commonJsAndEsmEntries: true,
        inputHandledWithoutModel: true,
        nativeResume: true,
        rejected,
        provider: 'local synthetic HTTP fixture',
        sourceCoverage: 'entry files and adjacent package; transitive dependencies not captured',
      }
      if (process.env.AGENT_MATRIX_PI_PLUGIN_REPORT)
        await writeFile(
          process.env.AGENT_MATRIX_PI_PLUGIN_REPORT,
          JSON.stringify(report, null, 2) + '\n',
        )
    } finally {
      for (const runtime of runtimes) {
        await runtime.dispose()
        await runtime.closed
      }
      server.closeAllConnections()
      await new Promise<void>((resolve) => server.close(() => resolve()))
      await rm(root, { recursive: true, force: true })
    }
  },
)
