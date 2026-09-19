import { createServer } from 'node:http'
import { mkdir, mkdtemp, readFile, realpath, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import { SkillDirectoryStore } from '../src/main/assets/skill-directory-store'
import { RunInputStore } from '../src/main/engines/run-input-store'
import { planDsh } from '../src/main/engines/adapters/dsh/configuration'
import { inspectDshComposition } from '../src/main/engines/adapters/dsh/composition'
import { connectDsh } from '../src/main/engines/adapters/dsh/runtime'
import type { RuntimeSession, RuntimeTurnHandlers } from '../src/main/engines/runtime'
import { dshWorkspace } from './helpers/dsh-fixture'
import { closeNativeFixture } from './helpers/close-native-fixture'

for (const route of ['pi-ai', 'deepseek-native'] as const)
  it.runIf(Boolean(process.env.AGENT_MATRIX_TEST_DSH))(
    `activates selected DSH plugins through the production ${route} adapter and verifies current instances`,
    async () => {
      const root = await realpath(await mkdtemp(join(tmpdir(), 'agentmatrix-dsh-activation-')))
      const cwd = join(root, 'project'),
        home = join(root, 'home'),
        installed = join(root, 'plugins 中文')
      const gate = join(root, 'release'),
        waiting = join(root, 'waiting')
      const key = 'synthetic-dsh-plugin-activation-key'
      const runtimes: RuntimeSession[] = [],
        requests: string[] = []
      let serverError: unknown
      const server = createServer(async (request, response) => {
        try {
          let body = ''
          for await (const part of request) {
            body += String(part)
            if (body.length > 2_097_152) throw new Error('Fixture request limit')
          }
          const parsed = JSON.parse(body)
          if (request.headers.authorization !== `Bearer ${key}` || !parsed.stream)
            throw new Error('Invalid fixture request')
          requests.push(body)
          const done = JSON.stringify(parsed.messages).includes('DSH_EXTENSION_TOOL_RESULT')
          response.writeHead(200, { 'Content-Type': 'text/event-stream' })
          const chunk = (delta: object, finish_reason: string | null = null) =>
            response.write(
              `data: ${JSON.stringify({ id: 'fixture', object: 'chat.completion.chunk', created: 1, model: parsed.model, choices: [{ index: 0, delta, finish_reason }] })}\n\n`,
            )
          if (!done) {
            chunk({
              role: 'assistant',
              tool_calls: [
                {
                  index: 0,
                  id: `tool-${requests.length}`,
                  type: 'function',
                  function: { name: 'fixture_plugin_tool', arguments: '{}' },
                },
              ],
            })
            chunk({}, 'tool_calls')
          } else {
            chunk({ role: 'assistant', content: 'DSH_PLUGIN_REPLY' })
            chunk({}, 'stop')
          }
          response.end('data: [DONE]\n\n')
        } catch (error) {
          serverError = error
          response.writeHead(500).end()
        }
      })
      try {
        await mkdir(join(cwd, '.git'), { recursive: true })
        await mkdir(home)
        await mkdir(installed)
        await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
        const address = server.address()
        if (!address || typeof address === 'string') throw new Error('Missing fixture address')
        const executable = process.env.AGENT_MATRIX_TEST_DSH!
        const workspace = dshWorkspace(executable, cwd)
        workspace.agents[0]!.promptBindings = []
        workspace.agents[0]!.skillBindings = []
        workspace.connections[0]!.baseUrl = `http://127.0.0.1:${address.port}/v1`
        if (route === 'deepseek-native') {
          workspace.connections[0]!.protocol = 'deepseek-official'
          workspace.connections[0]!.headers = {}
        }
        const helper = join(installed, 'helper.cjs')
        await writeFile(helper, `exports.marker = 'DSH_EXTENSION_MARKER';`)
        const entry = join(installed, 'index.cjs')
        await writeFile(
          join(installed, 'package.json'),
          JSON.stringify({
            version: '1.0.0',
            exports: { '.': { import: './index.cjs', default: './missing.js' } },
            peerDependencies: { '@deepseek-ai/dsh': '0.1.5-rc.2', '@deepseek-ai/cordis': '^4.0.2' },
          }),
        )
        await writeFile(
          entry,
          `const {existsSync,writeFileSync} = require('node:fs'); const {marker} = require('./helper.cjs');
exports.inject=['systemPrompt','tools'];
exports.Config={'~standard':{version:1,vendor:'fixture',validate(value){return typeof value?.marker==='string'?{value}:{issues:[{message:'marker required'}]}}}};
exports.apply=async(ctx,config)=>{
  writeFileSync(${JSON.stringify(waiting)},'waiting');
  while(!existsSync(${JSON.stringify(gate)}))await new Promise(resolve=>setTimeout(resolve,10));
  ctx.systemPrompt.section({name:'fixture:'+config.marker,order:900,text:marker+' '+config.marker});
  if(config.tool)ctx.tools.register({name:'fixture_plugin_tool',description:'Fixture tool',parameters:{type:'object',properties:{},additionalProperties:false},output:{schema:{type:'string'},render:(_args,value)=>[{type:'text',text:value}]},execute:async()=> 'DSH_EXTENSION_TOOL_RESULT'});
};`,
        )
        const plugin = (id: string, path = installed, config = { marker: id, tool: false }) => ({
          id,
          name: id,
          nativeId: id,
          engineInstallationId: 'dsh',
          version: path === installed ? '1.0.0' : 'fixture',
          source: 'local fixture',
          path,
          options: { kind: 'deepseek-harness' as const, config },
        })
        workspace.nativePlugins = [
          plugin('fixture-a', installed, { marker: 'FIRST', tool: true }),
          plugin('fixture-b', installed, { marker: 'SECOND', tool: false }),
        ]
        workspace.agents[0]!.nativePluginIds = workspace.nativePlugins.map((item) => item.id)
        const store = new RunInputStore(
          join(root, 'runs'),
          new SkillDirectoryStore(join(root, 'skills')),
        )
        const composition = await inspectDshComposition(executable, cwd)
        const capture = (id: string) =>
          store.create(id, workspace, 'reviewer', (configuration, paths) =>
            planDsh(configuration, paths, { composition, readSkillEntry: async () => '' }),
          )
        const connect = async (id: string, previousNativeSessionId?: string) => {
          const runtime = await connectDsh({
            store,
            snapshotId: id,
            resolveSecret: async () => key,
            environment: { ...process.env, HOME: home },
            signal: new AbortController().signal,
            previousNativeSessionId,
          })
          runtimes.push(runtime)
          return runtime
        }
        const captured = await capture('success')
        let started = false
        const starting = connect('success').then((runtime) => {
          started = true
          return runtime
        })
        void starting.catch(() => {})
        await Promise.race([
          starting.then(() => {
            throw new Error('Ready before plugin gate released')
          }),
          vi.waitFor(async () => expect(await readFile(waiting, 'utf8')).toBe('waiting'), {
            timeout: 15_000,
          }),
        ])
        expect(started).toBe(false)
        expect(requests).toEqual([])
        await writeFile(gate, 'release')
        const runtime = await starting
        expect(runtime.configurationChecks).toContain('dsh.plugins')
        const handlers: RuntimeTurnHandlers = {
          output: async () => {},
          interaction: async () => ({ kind: 'cancelled' }),
        }
        expect((await runtime.send('Use fixture_plugin_tool.', handlers)).outcome).toBe('completed')
        expect(serverError).toBeUndefined()
        expect(requests.at(-1)).toContain('DSH_EXTENSION_TOOL_RESULT')
        for (const body of requests) {
          expect(body).toContain('DSH_EXTENSION_MARKER FIRST')
          expect(body).toContain('DSH_EXTENSION_MARKER SECOND')
        }
        const nativeId = runtime.nativeSessionId
        await runtime.dispose()
        await runtime.closed
        const resumed = await connect('success', nativeId)
        expect(resumed.nativeSessionId).toBe(nativeId)
        expect(resumed.configurationChecks).toContain('dsh.plugins')
        expect((await resumed.send('Continue.', handlers)).outcome).toBe('completed')
        await resumed.dispose()
        await resumed.closed
        const rejected: string[] = []
        for (const [id, source] of [
          ['import', 'throw new Error("fixture import error");'],
          ['shape', 'module.exports = 12;'],
          ['apply', 'exports.apply=async()=>{throw new Error("fixture apply error")}'],
          ['pending', 'exports.inject=["fixtureMissingService"];exports.apply=()=>{}'],
          [
            'config',
            'exports.Config={"~standard":{version:1,vendor:"fixture",validate:()=>({issues:[{message:"invalid fixture"}]})}};exports.apply=()=>{}',
          ],
        ]) {
          const path = join(root, `${id}.cjs`)
          await writeFile(path, source!)
          workspace.nativePlugins = [plugin(id!, path)]
          workspace.agents[0]!.nativePluginIds = [id!]
          await capture(id!)
          await expect(connect(id!)).rejects.toThrow()
          rejected.push(id!)
        }
        const changed = join(root, 'change.cjs')
        const trigger = join(root, 'dispose-plugin')
        await writeFile(
          changed,
          `const {existsSync} = require('node:fs');exports.apply=ctx=>{
        const timer=setInterval(()=>{if(existsSync(${JSON.stringify(trigger)})){clearInterval(timer);void ctx.fiber.dispose()}},10);
        ctx.effect(()=>()=>clearInterval(timer));
      };`,
        )
        workspace.nativePlugins = [plugin('disposable', changed)]
        workspace.agents[0]!.nativePluginIds = ['disposable']
        await capture('disposal')
        const disposable = await connect('disposal')
        await writeFile(trigger, 'dispose')
        // Its native effect disposer is the deterministic point after the fiber is no longer active.
        await vi.waitFor(
          async () => {
            const sources = await readFile(
              join(store.paths('disposal').state, 'dsh/profiles/agentmatrix/cordis.yml'),
              'utf8',
            )
            expect(sources).toContain('disabled: true')
          },
          { timeout: 10_000 },
        )
        const before = requests.length
        await expect(disposable.send('Must not reach provider.', handlers)).rejects.toThrow()
        expect(requests).toHaveLength(before)
        rejected.push('disposed-before-turn')
        await disposable.dispose()
        await disposable.closed
        const dependencyBefore = await readFile(helper)
        const beforeDependencyRequests = requests.length
        await writeFile(helper, "exports.marker = 'CHANGED_EXTENSION'")
        await expect(connect('success', nativeId)).rejects.toThrow()
        expect(requests).toHaveLength(beforeDependencyRequests)
        rejected.push('changed-relative-dependency-on-resume')
        await writeFile(helper, dependencyBefore)
        await store.verifyForReuse('success')
        await writeFile(entry, 'exports.apply=()=>{}')
        await expect(connect('success', nativeId)).rejects.toThrow()
        rejected.push('changed-entry-on-resume')
        expect((await store.read('success')).digest).toBe(captured.digest)
        const report = {
          checkedAt: new Date().toISOString(),
          engine: 'deepseek-harness',
          version: '0.1.5-rc.2',
          route,
          platform: process.platform,
          arch: process.arch,
          provider: 'local synthetic HTTP fixture',
          productionAdapter: true,
          explicitPackageExports: true,
          perInstanceOptions: true,
          sameModuleSeparateInstances: true,
          awaitsNativeBoot: true,
          systemSectionsReachedProvider: true,
          customToolResult: true,
          freshSessionChecks: true,
          nativeResume: true,
          immutableInputs: true,
          rejected,
          sourceCoverage:
            'partial: entries, explicit relative modules, package scopes and pinned framework entries; package and computed imports remain unobserved',
        }
        if (process.env.AGENT_MATRIX_DSH_ACTIVATION_REPORT)
          await writeFile(
            `${process.env.AGENT_MATRIX_DSH_ACTIVATION_REPORT}.${route}.json`,
            JSON.stringify(report, null, 2) + '\n',
          )
      } finally {
        await closeNativeFixture(
          runtimes.map((runtime) => ({ close: () => runtime.dispose() })),
          server,
          root,
        )
      }
    },
  )
