import { createServer } from 'node:http'
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { expect, it, vi } from 'vitest'
import { SkillDirectoryStore } from '../src/main/assets/skill-directory-store'
import { RunInputStore, observeExternalFile } from '../src/main/engines/run-input-store'
import { planDsh } from '../src/main/engines/adapters/dsh/configuration'
import {
  inspectDshComposition,
  parseDshYaml,
  writeDshYaml,
  type DshRow,
} from '../src/main/engines/adapters/dsh/composition'
import { prepareDshLaunch } from '../src/main/engines/adapters/dsh/launch'
import { attachAcpProcess, type AcpAttachment } from '../src/main/engines/acp/attachment'
import { dshWorkspace } from './helpers/dsh-fixture'
import { closeNativeFixture } from './helpers/close-native-fixture'

interface Receipt {
  stage: string
  id: string
  pid: number
  uid?: number
  sessionId?: string
  marker?: string
  states?: { id: string; state: number }[]
}

it.runIf(Boolean(process.env.AGENT_MATRIX_TEST_DSH))(
  'verifies native DSH plugin shapes, configuration, dependency settlement and lifecycle',
  async () => {
    const executable = process.env.AGENT_MATRIX_TEST_DSH!
    const root = await realpath(await mkdtemp(join(tmpdir(), 'agentmatrix-dsh-plugins-')))
    const cwd = join(root, 'project'),
      home = join(root, 'home')
    const installed = join(root, 'installed plugins 中文')
    const receiptsPath = join(root, 'receipts.jsonl')
    const key = 'synthetic-dsh-plugin-key'
    const attachments: AcpAttachment[] = []
    const requests: { system: string; tools: string[]; toolResult: boolean }[] = []
    let serverError: unknown
    const server = createServer(async (request, response) => {
      try {
        let body = ''
        for await (const part of request) {
          body += String(part)
          if (body.length > 2_097_152) throw new Error('Fixture request limit')
        }
        const input = JSON.parse(body)
        if (request.headers.authorization !== `Bearer ${key}` || !input.stream)
          throw new Error('Unexpected provider request')
        const toolResult = JSON.stringify(input.messages).includes('DSH_PLUGIN_TOOL_RESULT')
        requests.push({
          system: JSON.stringify(
            input.messages.filter((message: { role: string }) => message.role === 'system'),
          ),
          tools: input.tools.map((tool: { function: { name: string } }) => tool.function.name),
          toolResult,
        })
        response.writeHead(200, { 'Content-Type': 'text/event-stream' })
        const chunk = (delta: object, finish_reason: string | null = null) =>
          response.write(
            `data: ${JSON.stringify({ id: 'fixture', object: 'chat.completion.chunk', created: 1, model: input.model, choices: [{ index: 0, delta, finish_reason }] })}\n\n`,
          )
        if (!toolResult) {
          chunk({
            role: 'assistant',
            tool_calls: [
              {
                index: 0,
                id: `plugin-tool-${requests.length}`,
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
      await writeFile(receiptsPath, '')
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
      const address = server.address()
      if (!address || typeof address === 'string') throw new Error('Missing fixture address')
      const workspace = dshWorkspace(executable, cwd)
      workspace.connections[0]!.baseUrl = `http://127.0.0.1:${address.port}/v1`
      workspace.agents[0]!.promptBindings = []
      workspace.agents[0]!.skillBindings = []
      const store = new RunInputStore(
        join(root, 'runs'),
        new SkillDirectoryStore(join(root, 'skills')),
      )
      const composition = await inspectDshComposition(executable, cwd)
      const require = createRequire(await realpath(executable))
      const nativeComponents = []
      for (const name of [
        '@deepseek-ai/dsh',
        '@deepseek-ai/dsh-app-boot',
        '@deepseek-ai/dsh-acp',
        '@deepseek-ai/cordis',
        '@deepseek-ai/cordis-plugin-loader',
        '@deepseek-ai/cordis-plugin-include',
      ]) {
        const packagePath =
          name === '@deepseek-ai/dsh'
            ? composition.components.find((component) => component.name === name)!.manifest
            : require.resolve(`${name}/package.json`)
        const metadata = JSON.parse(await readFile(packagePath, 'utf8'))
        const manifest = await observeExternalFile(packagePath)
        const entry = await observeExternalFile(
          name === '@deepseek-ai/dsh' ? executable : require.resolve(name),
        )
        if (!manifest.exists || !entry.exists) throw new Error('Missing native component')
        nativeComponents.push({
          name,
          version: metadata.version,
          manifestSha256: manifest.sha256,
          entrySha256: entry.sha256,
        })
      }
      const helper = join(installed, 'helper.cjs')
      await writeFile(
        helper,
        `const {appendFileSync} = require('node:fs');
exports.record = (stage, ctx, extra = {}) => appendFileSync(${JSON.stringify(receiptsPath)}, JSON.stringify({stage, id:ctx.fiber.entry.options.id, uid:ctx.fiber.uid, pid:process.pid, ...extra}) + '\\n');
exports.install = (ctx, config) => {
  exports.record('apply', ctx, {marker:config.marker});
  ctx.on('session/created', session => exports.record('session', ctx, {sessionId:session.id}));
  ctx.on('session/disposed', session => exports.record('session-disposed', ctx, {sessionId:session.id}));
  ctx.effect(() => () => exports.record('dispose', ctx));
  ctx.systemPrompt.section({name:'fixture:' + ctx.fiber.entry.options.id, order:900, text:'DSH_PLUGIN_' + config.marker});
};
exports.Config = {'~standard': {version:1, vendor:'fixture', validate(value) {
  return typeof value?.marker === 'string' ? {value:{...value, marker:value.marker + '_validated'}} : {issues:[{message:'marker required'}]};
}}};
`,
      )
      const object = join(installed, 'object.cjs')
      await writeFile(
        object,
        `const {install, Config} = require('./helper.cjs');
exports.name = 'fixture-object'; exports.inject = ['systemPrompt', 'tools']; exports.Config = Config;
exports.apply = async (ctx, config) => {
  await new Promise(resolve => setTimeout(resolve, 20)); install(ctx, config);
  if (config.tool) ctx.tools.register({name:'fixture_plugin_tool',description:'Fixture tool',parameters:{type:'object',properties:{},additionalProperties:false},output:{schema:{type:'string'},render:(_args,value)=>[{type:'text',text:value}]},execute:async()=> 'DSH_PLUGIN_TOOL_RESULT'});
};
`,
      )
      const fn = join(installed, 'function.mjs')
      await writeFile(
        fn,
        `import {install,Config} from './helper.cjs';
const plugin = (ctx, config) => install(ctx, config);
plugin.inject = ['systemPrompt']; plugin.Config = Config;
export default plugin;
export function apply() { throw new Error('Named export must not override default'); }
`,
      )
      const klass = join(installed, 'class.mjs')
      await writeFile(
        klass,
        `import {install,Config} from './helper.cjs';
export default class FixturePlugin {
  static inject = ['systemPrompt']; static Config = Config;
  constructor(ctx, config) { install(ctx, config); }
}
`,
      )
      const generator = join(installed, 'generator.mjs')
      await writeFile(
        generator,
        `import {install,record,Config} from './helper.cjs';
export const inject = ['systemPrompt']; export {Config};
export async function* apply(ctx, config) {
  await new Promise(resolve => setTimeout(resolve, 20)); install(ctx, config);
  yield () => record('generator-dispose', ctx);
}
`,
      )
      const readReceipts = async (): Promise<Receipt[]> =>
        (await readFile(receiptsPath, 'utf8'))
          .trim()
          .split('\n')
          .filter(Boolean)
          .map((line) => JSON.parse(line))
      const row = (id: string, path: string, config: object = { marker: id }): DshRow => ({
        id,
        name: pathToFileURL(path).href,
        config,
      })
      const observer = join(installed, 'observer.cjs')
      await writeFile(
        observer,
        `const {record} = require('./helper.cjs');
exports.inject = ['loader', 'appReady'];
exports.apply = ctx => {
  ctx.effect(() => ctx.appReady.onReady(() => record('app-ready', ctx, {
    states:[...ctx.loader.entries()].filter(entry=>!entry.disabled).map(entry=>({id:entry.id,state:entry.fiber?.state})),
  })));
};`,
      )
      const capture = async (id: string, selected: DshRow[], gateAcp = false) => {
        await store.create(id, workspace, 'reviewer', async (configuration, paths) => {
          const generated = await planDsh(configuration, paths, {
            composition,
            readSkillEntry: async () => '',
          })
          const patch = generated.files.find((file) => file.path === 'profile/cordis.patch.yml')!
          const value = parseDshYaml(patch.content) as { insert: DshRow[] }[]
          if (gateAcp)
            value[0]!.insert.find((item) => item.id === 'acp')!.inject = ['fixturePluginsReady']
          const fixtureRows = [...selected, row('observer', observer)]
          value[0]!.insert.push(...fixtureRows)
          patch.content = writeDshYaml(value)
          generated.externalSources = structuredClone(generated.externalSources)
          for (const selectedRow of fixtureRows) {
            const path = new URL(selectedRow.name!)
            generated.externalSources.files.push(await observeExternalFile(fileURLToPath(path)))
          }
          return generated
        })
      }
      const prepare = async (id: string) => {
        const before = await readReceipts()
        const prepared = await prepareDshLaunch(
          store,
          id,
          async () => key,
          { ...process.env, HOME: home },
          new AbortController().signal,
        )
        expect(await readReceipts()).toEqual(before)
        return prepared.launch
      }
      const attach = async (id: string) => {
        const attached = await attachAcpProcess(
          await prepare(id),
          {
            update: async () => {},
            permission: async () => ({ outcome: { outcome: 'selected', optionId: 'allow-once' } }),
          },
          { requestTimeoutMs: 15_000 },
        )
        attachments.push(attached)
        return attached
      }
      const selected = [
        row('object-a', object, { marker: 'OBJECT_A', tool: true }),
        row('object-b', object),
        row('function', fn),
        row('class', klass),
        row('generator', generator),
      ]
      await capture('valid', selected)
      const first = await attach('valid')
      await first.client.initialize('0.1.0')
      const created = await first.client.newSession({ cwd, mcpServers: [] })
      const waitReady = (attached: AcpAttachment) =>
        vi.waitFor(
          async () => {
            const ready = (await readReceipts()).filter(
              (item) => item.pid === attached.process.pid && item.stage === 'app-ready',
            )
            expect(ready).toHaveLength(1)
            expect(ready[0]!.states!.every((entry) => entry.state === 2)).toBe(true)
          },
          { timeout: 10_000 },
        )
      await waitReady(first)
      await vi.waitFor(async () =>
        expect(
          (await readReceipts()).filter(
            (item) => item.pid === first.process.pid && item.stage === 'apply',
          ),
        ).toHaveLength(5),
      )
      const applied = (await readReceipts()).filter(
        (item) => item.pid === first.process.pid && item.stage === 'apply',
      )
      expect(new Set(applied.map((item) => item.uid)).size).toBe(5)
      expect(applied.every((item) => item.marker?.endsWith('_validated'))).toBe(true)
      expect(
        (
          await first.client.prompt(
            {
              sessionId: created.sessionId,
              prompt: [{ type: 'text', text: 'Use fixture_plugin_tool.' }],
            },
            20_000,
          )
        ).stopReason,
      ).toBe('end_turn')
      expect(serverError).toBeUndefined()
      expect(requests.at(-1)?.toolResult).toBe(true)
      expect(requests.every((item) => item.tools.includes('fixture_plugin_tool'))).toBe(true)
      for (const appliedRow of applied)
        expect(requests[0]!.system).toContain(`DSH_PLUGIN_${appliedRow.marker}`)
      await first.client.closeSession(created.sessionId)
      await first.close()
      const firstReceipts = (await readReceipts()).filter((item) => item.pid === first.process.pid)
      expect(
        firstReceipts.filter((item) => item.stage === 'session').map((item) => item.sessionId),
      ).toEqual(Array(5).fill(created.sessionId))
      expect(firstReceipts.filter((item) => item.stage === 'session-disposed')).toHaveLength(5)
      expect(firstReceipts.filter((item) => item.stage === 'dispose')).toHaveLength(5)
      expect(firstReceipts.some((item) => item.stage === 'generator-dispose')).toBe(true)
      const resumed = await attach('valid')
      await resumed.client.initialize('0.1.0')
      await resumed.client.resumeSession({ sessionId: created.sessionId, cwd, mcpServers: [] })
      await waitReady(resumed)
      expect(
        (
          await resumed.client.prompt(
            {
              sessionId: created.sessionId,
              prompt: [{ type: 'text', text: 'Continue.' }],
            },
            20_000,
          )
        ).stopReason,
      ).toBe('end_turn')
      expect(
        (await readReceipts())
          .filter((item) => item.pid === resumed.process.pid && item.stage === 'session')
          .map((item) => item.sessionId),
      ).toEqual(Array(5).fill(created.sessionId))
      await resumed.close()

      const failures: { kind: string; initializedBeforeExit: boolean; exitCode: number | null }[] =
        []
      for (const [kind, source] of [
        ['import', 'throw new Error("Fixture import failure");'],
        ['dependency', 'require("./does-not-exist.cjs");'],
        ['shape', 'module.exports = 12;'],
        ['config', `exports.Config = require('./helper.cjs').Config; exports.apply = () => {};`],
        ['apply', 'exports.apply = () => { throw new Error("Fixture apply failure"); };'],
        [
          'async-apply',
          'exports.apply = async () => { await new Promise(resolve=>setTimeout(resolve,30)); throw new Error("Fixture async failure"); };',
        ],
        ['pending', 'exports.inject = ["fixtureMissingService"]; exports.apply = () => {};'],
      ]) {
        const path = join(installed, `${kind}.cjs`)
        await writeFile(path, source!)
        await capture(kind!, [row(`failure-${kind}`, path, {})])
        const attached = await attach(kind!)
        let initializedBeforeExit = false
        const initialized = attached.client.initialize('0.1.0').then(
          () => {
            initializedBeforeExit = true
          },
          () => {},
        )
        let result: Awaited<typeof attached.process.closed> | undefined
        void attached.process.closed.then((value) => {
          result = value
        })
        await vi.waitFor(() => expect(result).toBeDefined(), { timeout: 15_000 })
        await initialized
        expect(result!.code).toBe(1)
        await attached.close()
        expect(
          (await readReceipts()).some(
            (item) => item.pid === attached.process.pid && item.stage === 'app-ready',
          ),
        ).toBe(false)
        failures.push({ kind: kind!, initializedBeforeExit, exitCode: result!.code })
      }
      const gate = join(root, 'release-gate')
      const delayed = join(installed, 'delayed.cjs')
      await writeFile(
        delayed,
        `const {existsSync} = require('node:fs'); const {record} = require('./helper.cjs');
exports.apply = async ctx => {
  record('waiting',ctx);
  while (!existsSync(${JSON.stringify(gate)})) await new Promise(resolve=>setTimeout(resolve,10));
  record('released',ctx);
};`,
      )
      const guard = join(installed, 'guard.cjs')
      await writeFile(
        guard,
        `const {record} = require('./helper.cjs');
exports.inject = {loader:{await:true},sessions:null};
exports.apply = ctx => {
  const states = [...ctx.loader.entries()].filter(entry=>entry.options.id==='delayed').map(entry=>({id:entry.options.id,state:entry.fiber?.state}));
  if (states.length !== 1 || states[0].state !== 2) throw new Error('Selected plugin is not active');
  record('guard-ready',ctx,{states}); ctx.provide('fixturePluginsReady',true);
};`,
      )
      await capture('ungated', [row('delayed', delayed)])
      const ungated = await attach('ungated')
      await ungated.client.initialize('0.1.0')
      const earlySession = await ungated.client.newSession({ cwd, mcpServers: [] })
      expect(earlySession.sessionId).toBeTruthy()
      await vi.waitFor(async () =>
        expect(
          (await readReceipts()).some(
            (item) => item.pid === ungated.process.pid && item.stage === 'waiting',
          ),
        ).toBe(true),
      )
      expect(
        (await readReceipts()).some(
          (item) => item.pid === ungated.process.pid && item.stage === 'app-ready',
        ),
      ).toBe(false)
      await writeFile(gate, 'release')
      await waitReady(ungated)
      await ungated.close()
      await rm(gate)
      await capture('gated', [row('delayed', delayed), row('guard', guard)], true)
      const gated = await attach('gated')
      let ready = false
      const initializing = gated.client.initialize('0.1.0').then((value) => {
        ready = true
        return value
      })
      await vi.waitFor(async () =>
        expect(
          (await readReceipts()).some(
            (item) => item.pid === gated.process.pid && item.stage === 'waiting',
          ),
        ).toBe(true),
      )
      expect(ready).toBe(false)
      await writeFile(gate, 'release')
      await initializing
      await waitReady(gated)
      const nativeOrder = (await readReceipts())
        .filter((item) => item.pid === gated.process.pid)
        .map((item) => item.stage)
      expect(nativeOrder.indexOf('released')).toBeLessThan(nativeOrder.indexOf('guard-ready'))
      expect(nativeOrder).toContain('guard-ready')
      await gated.close()
      const report = {
        checkedAt: new Date().toISOString(),
        engine: 'deepseek-harness',
        version: '0.1.5-rc.2',
        platform: process.platform,
        arch: process.arch,
        nativeComponents,
        provider: 'local synthetic HTTP fixture',
        scope: 'Native composition fixture; selected-plugin application bindings remain disabled',
        dumpDoesNotExecute: true,
        shapes: [
          'cjs-object',
          'esm-default-function',
          'esm-default-class',
          'esm-named-async-generator',
        ],
        sameModuleSeparateFibers: true,
        nativeConfigValidation: true,
        relativeImports: true,
        systemSectionsReachedProvider: true,
        customToolResult: true,
        sessionCreatedAndDisposed: true,
        generatorDisposal: true,
        nativeResume: true,
        loaderSettlementGate: true,
        acpSessionBeforePluginSettles: true,
        appReadyAfterActiveTree: true,
        failedTreesNeverAppReady: true,
        failures,
      }
      if (process.env.AGENT_MATRIX_DSH_PLUGIN_REPORT)
        await writeFile(
          process.env.AGENT_MATRIX_DSH_PLUGIN_REPORT,
          JSON.stringify(report, null, 2) + '\n',
        )
    } finally {
      await closeNativeFixture(attachments, server, root)
    }
  },
)
