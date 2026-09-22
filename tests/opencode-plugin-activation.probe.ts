import { createServer } from 'node:http'
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { SkillDirectoryStore } from '../src/main/assets/skill-directory-store'
import { RunInputStore } from '../src/main/engines/run-input-store'
import { planOpenCode } from '../src/main/engines/adapters/opencode/configuration'
import { connectOpenCode } from '../src/main/engines/adapters/opencode/runtime'
import type { RuntimeSession } from '../src/main/engines/runtime'
import { openCodeWorkspace } from './helpers/opencode-fixture'

it.runIf(Boolean(process.env.AGENT_MATRIX_TEST_OPENCODE))(
  'activates captured plugins through the production adapter and refuses native soft failures',
  async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'agentmatrix-plugin-activation-')))
    const cwd = join(root, 'project'),
      home = join(root, 'home'),
      configHome = join(root, 'config')
    const installed = join(root, 'installed plugins 中文'),
      receipts = join(root, 'fixture-receipts.jsonl')
    let runtime: RuntimeSession | undefined
    const requests: { system: string; authorized: boolean }[] = []
    const server = createServer(async (request, response) => {
      try {
        const chunks: Buffer[] = []
        for await (const chunk of request) chunks.push(Buffer.from(chunk))
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8'))
        requests.push({
          system: JSON.stringify(body.messages),
          authorized: request.headers.authorization === 'Bearer synthetic-activation-key',
        })
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
                  message: { role: 'assistant', content: 'Managed plugins' },
                  finish_reason: 'stop',
                },
              ],
            }),
          )
          return
        }
        response.writeHead(200, { 'Content-Type': 'text/event-stream' })
        for (const [delta, finish_reason] of [
          [{ role: 'assistant', content: 'ACTIVATION_RESPONSE' }, null],
          [{}, 'stop'],
        ])
          response.write(
            `data: ${JSON.stringify({ id: 'fixture', object: 'chat.completion.chunk', created: 1, model: body.model, choices: [{ index: 0, delta, finish_reason }] })}\n\n`,
          )
        response.end('data: [DONE]\n\n')
      } catch {
        response.writeHead(400).end()
      }
    })
    try {
      await mkdir(join(cwd, '.git'), { recursive: true })
      await mkdir(home)
      await mkdir(configHome)
      await mkdir(installed)
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject)
        server.listen(0, '127.0.0.1', resolve)
      })
      const address = server.address()
      if (!address || typeof address === 'string') throw new Error('No fixture port')
      const record = `import { appendFileSync } from 'node:fs';
function hooks(id, options) {
  if (options?.nested?.[0] !== false || options.nested[1] !== 0 || options.nested[2] !== null || options['{env:OPTIONS_POISON}'] !== '{file:missing.txt}') throw new Error('Options changed');
  return Object.freeze({
  config(config) { config.agent.build.description = 'Existing plugin description'; appendFileSync(${JSON.stringify(receipts)}, JSON.stringify({id, pid:process.pid, stage:'config'})+'\\n'); },
  'experimental.chat.system.transform'(_input, output) { output.system.push('MANAGED_PLUGIN_' + id, 'OPTIONS_' + options.marker); appendFileSync(${JSON.stringify(receipts)}, JSON.stringify({id, pid:process.pid, stage:'system'})+'\\n'); },
}); }
`
      const legacy = join(installed, 'legacy.mjs')
      await writeFile(
        legacy,
        `${record}
export async function Alpha(_input, options) { return hooks('alpha', options) }
export const Alias = Alpha;
export async function Beta(_input, options) { return hooks('beta', options) }
`,
      )
      const packaged = join(installed, 'v1')
      await mkdir(packaged)
      await writeFile(
        join(packaged, 'package.json'),
        JSON.stringify({
          name: '@fixture/managed-plugin',
          version: '1.2.3',
          engines: { opencode: '^1.18.0' },
          exports: { './server': './server.ts' },
        }),
      )
      await writeFile(join(packaged, 'identity.ts'), "export const name: string = 'v1'\n")
      await writeFile(
        join(packaged, 'server.ts'),
        `${record}
import { name } from './identity.ts';
const plugin = Object.freeze({ id:'fixture-v1', async server(_input, options) { if (this !== plugin) throw new Error('Lost server receiver'); return hooks(name, options); } });
export default plugin;
export const metadata = 'ignored by V1';
`,
      )
      const workspace = openCodeWorkspace(process.env.AGENT_MATRIX_TEST_OPENCODE!, cwd)
      workspace.agents[0]!.promptBindings = []
      workspace.agents[0]!.skillBindings = []
      workspace.connections[0]!.baseUrl = `http://127.0.0.1:${address.port}/v1`
      const plugin = (id: string, path: string, nativeId = id) => ({
        id,
        name: id,
        path,
        nativeId,
        version: '1.2.3',
        source: 'installed fixture',
        engineInstallationId: 'oc',
      })
      workspace.nativePlugins = [plugin('legacy', legacy), plugin('v1', packaged, 'fixture-v1')]
      for (const selected of workspace.nativePlugins)
        selected.options = {
          kind: 'opencode',
          config: {
            marker: selected.id + '-original',
            nested: [false, 0, null],
            '{env:OPTIONS_POISON}': '{file:missing.txt}',
          },
        }
      workspace.agents[0]!.nativePluginIds = ['legacy', 'v1']
      const store = new RunInputStore(
        join(root, 'runs'),
        new SkillDirectoryStore(join(root, 'skills')),
      )
      const capture = async (id: string, pure = false) =>
        store.create(id, workspace, 'reviewer', async (configuration, paths) => {
          const plan = await planOpenCode(configuration, paths, {
            configHome,
            sources: { coverage: 'partial', files: [] },
            readSkillEntry: async () => '',
          })
          for (const [name, value] of Object.entries({
            OPENCODE_TEST_HOME: home,
            OPENCODE_PURE: String(pure),
            OPENCODE_DISABLE_MODELS_FETCH: 'true',
            OPENCODE_DISABLE_DEFAULT_PLUGINS: 'true',
            OPENCODE_DISABLE_CLAUDE_CODE: 'true',
            OPENCODE_DISABLE_EXTERNAL_SKILLS: 'true',
            OPTIONS_POISON: 'must-not-expand',
          }))
            plan.launch.environment[name] = { kind: 'literal', value }
          return plan
        })
      const connect = (snapshotId: string, previousNativeSessionId?: string) =>
        connectOpenCode({
          store,
          snapshotId,
          previousNativeSessionId,
          resolveSecret: async () => 'synthetic-activation-key',
          environment: { ...process.env, HOME: home },
          signal: new AbortController().signal,
        })
      const originalCapture = await capture('success')
      const observed: { stage: string; checks: readonly string[] }[] = []
      for (const stage of ['new', 'resume']) {
        const previousNativeSessionId = runtime?.nativeSessionId
        if (runtime) {
          await runtime.dispose()
          await runtime.closed
        }
        runtime = await connect('success', previousNativeSessionId)
        expect(runtime.configurationChecks).toContain('opencode.plugins')
        const output: string[] = []
        await runtime.send('Reply once without tools.', {
          output: async (event) => {
            if (event.kind === 'message.delta') output.push(event.text)
          },
          interaction: async () => ({ kind: 'cancelled' }),
        })
        expect(output.join('')).toContain('ACTIVATION_RESPONSE')
        expect(requests.at(-1)!.system).toContain('OPTIONS_legacy-original')
        expect(requests.at(-1)!.system).toContain('OPTIONS_v1-original')
        expect(requests.at(-1)!.system).not.toContain('-edited')
        for (const selected of workspace.nativePlugins)
          selected.options!.config.marker = selected.id + '-edited'
        expect(await store.read('success')).toEqual(originalCapture)
        observed.push({ stage, checks: runtime.configurationChecks! })
      }
      const nativeSessionId = runtime!.nativeSessionId
      await runtime!.dispose()
      await runtime!.closed
      runtime = undefined
      const nativeReceipts: { id: string; stage: string; pid: number }[] = (
        await readFile(receipts, 'utf8')
      )
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line))
      const byPid = new Map<number, string[]>()
      for (const entry of nativeReceipts.filter((entry) => entry.stage === 'system'))
        byPid.set(entry.pid, [...(byPid.get(entry.pid) ?? []), entry.id])
      expect(byPid.size).toBe(2)
      for (const ids of byPid.values()) {
        expect(ids.length % 3).toBe(0)
        for (let index = 0; index < ids.length; index += 3)
          expect(ids.slice(index, index + 3)).toEqual(['alpha', 'beta', 'v1'])
      }
      expect(
        requests.filter((request) =>
          ['alpha', 'beta', 'v1'].every((name) =>
            request.system.includes('MANAGED_PLUGIN_' + name),
          ),
        ).length,
      ).toBeGreaterThanOrEqual(2)
      expect(requests.every((request) => request.authorized)).toBe(true)
      await capture('edited')
      runtime = await connect('edited')
      await runtime.send('Reply with the updated configuration.', {
        output: async () => {},
        interaction: async () => ({ kind: 'cancelled' }),
      })
      expect(requests.at(-1)!.system).toContain('OPTIONS_legacy-edited')
      expect(requests.at(-1)!.system).toContain('OPTIONS_v1-edited')
      expect(requests.at(-1)!.system).not.toContain('-original')
      await runtime.dispose()
      await runtime.closed
      runtime = undefined
      const rejected: string[] = []
      await capture('pure', true)
      await expect(connect('pure')).rejects.toThrow('native.plugins')
      rejected.push('pure')
      for (const [id, source] of [
        ['import', "throw new Error('synthetic import failure'); export default async () => ({})"],
        [
          'init',
          "export default async () => { throw new Error('synthetic initialization failure') }",
        ],
        [
          'config',
          "export default async () => ({ config() { throw new Error('synthetic config failure') } })",
        ],
        ['missing-dependency', "import './absent.mjs'; export default async () => ({})"],
        ['wrong-id', "export default { id: 'wrong', server: async () => ({}) }"],
      ]) {
        const path = join(installed, `${id}.mjs`)
        await writeFile(path, source!)
        workspace.nativePlugins = [plugin(id!, path)]
        workspace.agents[0]!.nativePluginIds = [id!]
        await capture(id!)
        await expect(connect(id!)).rejects.toThrow('native.plugins')
        rejected.push(id!)
      }
      const dependency = join(packaged, 'identity.ts')
      const dependencyBefore = await readFile(dependency)
      const beforeDependencyRequests = requests.length
      const beforeDependencyReceipts = await readFile(receipts)
      await writeFile(dependency, "export const name: string = 'changed'\n")
      await expect(connect('success', nativeSessionId)).rejects.toThrow()
      expect(requests).toHaveLength(beforeDependencyRequests)
      expect(await readFile(receipts)).toEqual(beforeDependencyReceipts)
      rejected.push('changed-relative-dependency-on-resume')
      await writeFile(dependency, dependencyBefore)
      await store.verifyForReuse('success')
      await writeFile(legacy, 'export default async () => ({})')
      await expect(connect('success', nativeSessionId)).rejects.toThrow()
      rejected.push('changed-entry-on-resume')
      const report = {
        checkedAt: new Date().toISOString(),
        engine: 'opencode',
        engineVersion: '1.18.16',
        platform: process.platform,
        arch: process.arch,
        selectedBindings: ['legacy', 'v1'],
        nativeTupleOptions: {
          legacyAndV1: true,
          nestedLiteralsAndMacroKeys: true,
          capturedOptionsSurviveSavedEditsAndNativeResume: true,
          newCaptureUsesEditedOptions: true,
        },
        observed,
        hookOrderByAttachment: [...byPid.values()],
        rejected,
        provider: 'local synthetic HTTP fixture',
        sourceCoverage:
          'partial: entries, explicit relative modules and package scopes; package and computed imports remain unobserved',
      }
      if (process.env.AGENT_MATRIX_OPENCODE_ACTIVATION_REPORT)
        await writeFile(
          process.env.AGENT_MATRIX_OPENCODE_ACTIVATION_REPORT,
          JSON.stringify(report, null, 2) + '\n',
        )
    } finally {
      if (runtime) {
        await runtime.dispose()
        await runtime.closed
      }
      server.closeAllConnections()
      await new Promise<void>((resolve) => server.close(() => resolve()))
      await rm(root, { recursive: true, force: true })
    }
  },
)
