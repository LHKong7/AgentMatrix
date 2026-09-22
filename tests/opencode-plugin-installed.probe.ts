import { createServer } from 'node:http'
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { expect, it, vi } from 'vitest'
import { SkillDirectoryStore } from '../src/main/assets/skill-directory-store'
import { RunInputStore } from '../src/main/engines/run-input-store'
import { planOpenCode } from '../src/main/engines/adapters/opencode/configuration'
import { inspectOpenCodePlugin } from '../src/main/engines/adapters/opencode/plugin-inspection'
import { connectOpenCode } from '../src/main/engines/adapters/opencode/runtime'
import type { RuntimeSession } from '../src/main/engines/runtime'
import { openCodeWorkspace } from './helpers/opencode-fixture'
import { AcpClient } from '../src/main/engines/acp/client'

interface Receipt {
  stage: string
  id: string
  pid: number
  command: string
  cycle: number
  marker?: string
  directory?: string
  option?: string
}

it.runIf(Boolean(process.env.AGENT_MATRIX_TEST_OPENCODE))(
  'distinguishes native plugin hooks, soft failures, pure mode, and reinitialization on resume',
  async () => {
    const executable = process.env.AGENT_MATRIX_TEST_OPENCODE!
    const root = await realpath(await mkdtemp(join(tmpdir(), 'agentmatrix-opencode-plugins-')))
    const cwd = join(root, 'project')
    const home = join(root, 'home')
    const configHome = join(root, 'config')
    const installed = join(root, 'installed plugins 中文')
    const receiptsPath = join(root, 'receipts.jsonl')
    const syntheticKey = 'synthetic-plugin-probe-key'
    let runtime: RuntimeSession | undefined
    const sessionReadbacks: string[] = []
    const originalNewSession = AcpClient.prototype.newSession
    const newSessionObserver = vi
      .spyOn(AcpClient.prototype, 'newSession')
      .mockImplementation(async function (this: AcpClient, ...args) {
        const reply = await originalNewSession.apply(this, args)
        sessionReadbacks.push(JSON.stringify(reply))
        return reply
      })
    const originalResumeSession = AcpClient.prototype.resumeSession
    const resumeSessionObserver = vi
      .spyOn(AcpClient.prototype, 'resumeSession')
      .mockImplementation(async function (this: AcpClient, ...args) {
        const reply = await originalResumeSession.apply(this, args)
        sessionReadbacks.push(JSON.stringify(reply))
        return reply
      })
    const originalLoadSession = AcpClient.prototype.loadSession
    const loadSessionObserver = vi
      .spyOn(AcpClient.prototype, 'loadSession')
      .mockImplementation(async function (this: AcpClient, ...args) {
        const reply = await originalLoadSession.apply(this, args)
        sessionReadbacks.push(JSON.stringify(reply))
        return reply
      })
    const requests: { label: string; system: string; authorized: boolean }[] = []
    const server = createServer(async (request, response) => {
      try {
        if (request.url !== '/v1/chat/completions') {
          response.writeHead(404).end()
          return
        }
        let body = ''
        for await (const chunk of request) {
          body += String(chunk)
          if (body.length > 2_097_152) throw new Error('Request limit')
        }
        const input = JSON.parse(body)
        const lastUser = input.messages
          ?.filter((message: { role: string }) => message.role === 'user')
          .at(-1)
        const label = ['initial', 'resumed', 'pure'].find((value) =>
          JSON.stringify(lastUser?.content ?? '').includes(`PLUGIN_PROBE_${value}`),
        )
        if (label && input.stream)
          requests.push({
            label,
            system: JSON.stringify(
              input.messages.filter((message: { role: string }) => message.role === 'system'),
            ),
            authorized: request.headers.authorization === `Bearer ${syntheticKey}`,
          })
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
                  message: { role: 'assistant', content: 'Plugin probe' },
                  finish_reason: 'stop',
                },
              ],
              usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 },
            }),
          )
          return
        }
        response.writeHead(200, { 'Content-Type': 'text/event-stream' })
        const chunk = (delta: object, finish_reason: string | null = null) =>
          response.write(
            `data: ${JSON.stringify({
              id: 'fixture',
              object: 'chat.completion.chunk',
              created: 1,
              model: input.model,
              choices: [{ index: 0, delta, finish_reason }],
            })}\n\n`,
          )
        chunk({ role: 'assistant', content: 'PLUGIN_RESPONSE_MARKER' })
        chunk({}, 'stop')
        response.end('data: [DONE]\n\n')
      } catch {
        response.writeHead(400).end('Invalid fixture request')
      }
    })
    try {
      await mkdir(join(cwd, '.git'), { recursive: true })
      await mkdir(home)
      await mkdir(configHome)
      await mkdir(installed)
      await writeFile(receiptsPath, '')
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject)
        server.listen(0, '127.0.0.1', resolve)
      })
      const address = server.address()
      if (!address || typeof address === 'string') throw new Error('Missing fixture address')
      const record = `import { appendFileSync } from 'node:fs';
const cycles = new Map();
function record(stage, id, extra = {}) {
  if (stage === 'init') cycles.set(id, (cycles.get(id) ?? 0) + 1);
  const command = process.argv.includes('acp') ? 'acp' : process.argv.includes('debug') ? 'debug' : 'other';
  appendFileSync(${JSON.stringify(receiptsPath)}, JSON.stringify({stage, id, pid: process.pid, command, cycle: cycles.get(id) ?? 0, ...extra}) + '\\n');
}
function hooks(id, configFailure = false) {
  const cycle = cycles.get(id);
  return {
    config(config) {
      const marker = id === 'v1' ? 'PLUGIN_INSTANCE_' + process.pid + '_' + cycle : undefined;
      if (marker) config.agent.build.description = marker;
      record('config', id, {cycle, marker});
      if (configFailure) throw new Error('Fixture config failure');
    },
    'experimental.chat.system.transform'(_input, output) { output.system.push('PLUGIN_HOOK_' + id); record('system', id, {cycle}); },
    dispose() { record('dispose', id, {cycle}); },
  };
}
`
      const legacy = join(installed, 'legacy.mjs')
      await writeFile(
        legacy,
        `${record}
export async function Alpha(input, options) { record('init', 'legacy-a', {directory: input.directory, option: options.marker}); return hooks('legacy-a'); }
export const Alias = Alpha;
export async function Beta(input, options) { record('init', 'legacy-b', {directory: input.directory, option: options.marker}); return hooks('legacy-b'); }
`,
      )
      const packaged = join(installed, 'packaged')
      await mkdir(join(packaged, 'dist'), { recursive: true })
      await writeFile(
        join(packaged, 'package.json'),
        JSON.stringify({
          name: '@fixture/server-plugin',
          version: '1.2.3',
          engines: { opencode: '>=999.0.0' },
          exports: { './server': './dist/server.ts' },
          main: './never-load.mjs',
        }),
      )
      await writeFile(
        join(packaged, 'dist', 'identity.ts'),
        "export const identity: string = 'v1';\n",
      )
      await writeFile(
        join(packaged, 'dist', 'server.ts'),
        `${record}
import { identity } from './identity.ts';
export default { id: 'fixture-v1', async server(input, options) {
  record('init', identity, {directory: input.directory, option: options.marker}); return hooks(identity);
} };
// A V1 module's unrelated named exports must not be treated as legacy initializers.
export const metadata = 'not a plugin';
`,
      )
      const configFailure = join(installed, 'config-failure.mjs')
      await writeFile(
        configFailure,
        `${record}
export default { id: 'fixture-config-failure', async server(input) {
  record('init', 'config-failure', {directory: input.directory}); return hooks('config-failure', true);
} };
`,
      )
      const initFailure = join(installed, 'init-failure.mjs')
      await writeFile(
        initFailure,
        `${record}
export default { id: 'fixture-init-failure', async server() { record('attempt', 'init-failure'); throw new Error('Fixture initialization failure'); } };
`,
      )
      const importFailure = join(installed, 'import-failure.mjs')
      await writeFile(
        importFailure,
        `${record}
record('attempt', 'import-failure'); throw new Error('Fixture import failure');
export default async function plugin() { record('unexpected', 'import-failure'); return {}; }
`,
      )
      const missingDependency = join(installed, 'missing-dependency.mjs')
      await writeFile(
        missingDependency,
        `import './never-installed-relative-dependency.mjs';
export default async function plugin() { return {}; }
`,
      )
      const inspected = await inspectOpenCodePlugin(packaged)
      expect(inspected.entry.path).toBe(join(packaged, 'dist', 'server.ts'))
      expect(inspected.package?.version).toBe('1.2.3')
      const specifications = [
        [pathToFileURL(legacy).href, { marker: 'legacy-options' }],
        [pathToFileURL(packaged).href, { marker: 'v1-options' }],
        ...[configFailure, initFailure, importFailure, missingDependency].map(
          (path) => pathToFileURL(path).href,
        ),
      ]
      const workspace = openCodeWorkspace(executable, cwd)
      workspace.agents[0]!.promptBindings = []
      workspace.agents[0]!.skillBindings = []
      workspace.connections[0]!.baseUrl = `http://127.0.0.1:${address.port}/v1`
      const store = new RunInputStore(
        join(root, 'runs'),
        new SkillDirectoryStore(join(root, 'skills')),
      )
      for (const [id, pure] of [
        ['active', false],
        ['pure', true],
      ] as const) {
        await store.create(id, workspace, 'reviewer', async (configuration, paths) => {
          const plan = await planOpenCode(configuration, paths, {
            configHome,
            sources: { coverage: 'partial', files: [] },
            readSkillEntry: async () => {
              throw new Error('Unexpected Skill')
            },
          })
          // Native contract probe only: production binding validation remains in force. The test
          // adds native declarations directly to the fixture's captured generated configuration.
          const nativeFile = plan.files.find((file) => file.path === 'opencode.json')!
          const config = JSON.parse(nativeFile.content)
          config.plugin = specifications
          nativeFile.content = JSON.stringify(config).replaceAll('{file:', '\\u007bfile:')
          for (const [name, value] of Object.entries({
            OPENCODE_TEST_HOME: home,
            OPENCODE_PURE: String(pure),
            OPENCODE_DISABLE_MODELS_FETCH: 'true',
            OPENCODE_DISABLE_DEFAULT_PLUGINS: 'true',
            OPENCODE_DISABLE_CLAUDE_CODE: 'true',
            OPENCODE_DISABLE_EXTERNAL_SKILLS: 'true',
          }))
            plan.launch.environment[name] = { kind: 'literal', value }
          return plan
        })
      }
      const receipts = async (): Promise<Receipt[]> =>
        (await readFile(receiptsPath, 'utf8'))
          .split('\n')
          .filter(Boolean)
          .map((line) => JSON.parse(line))
      const connect = (snapshotId: string, previousNativeSessionId?: string) =>
        connectOpenCode({
          store,
          snapshotId,
          resolveSecret: async () => syntheticKey,
          environment: { ...process.env, HOME: home },
          signal: new AbortController().signal,
          previousNativeSessionId,
        })
      const turn = async (label: string) => {
        const output: string[] = []
        const result = await runtime!.send(
          `PLUGIN_PROBE_${label}. Reply once without using tools.`,
          {
            output: async (event) => {
              if (event.kind === 'message.delta') output.push(event.text)
            },
            interaction: async () => ({ kind: 'cancelled' }),
          },
        )
        expect(result.nativeStopReason).toBe('end_turn')
        expect(output.join('')).toContain('PLUGIN_RESPONSE_MARKER')
      }
      runtime = await connect('active')
      const nativeSessionId = runtime.nativeSessionId
      expect(runtime.configurationChecks).not.toContain('opencode.plugins')
      const initial = await receipts()
      const expectedOrder = ['legacy-a', 'legacy-b', 'v1', 'config-failure']
      const debugInitializers = initial.filter(
        (row) => row.stage === 'init' && row.command === 'debug',
      )
      const acpInitializers = initial.filter((row) => row.stage === 'init' && row.command === 'acp')
      expect(debugInitializers.map((row) => row.id)).toEqual(expectedOrder)
      expect(acpInitializers.map((row) => row.id)).toEqual([...expectedOrder, ...expectedOrder])
      expect(acpInitializers.map((row) => row.cycle)).toEqual([1, 1, 1, 1, 2, 2, 2, 2])
      const currentMarker = initial.find(
        (row) =>
          row.command === 'acp' && row.stage === 'config' && row.id === 'v1' && row.cycle === 2,
      )!.marker!
      const oldMarker = initial.find(
        (row) =>
          row.command === 'acp' && row.stage === 'config' && row.id === 'v1' && row.cycle === 1,
      )!.marker!
      expect(sessionReadbacks[0]).toContain(currentMarker)
      expect(sessionReadbacks[0]).not.toContain(oldMarker)
      expect(
        initial
          .filter((row) => row.stage === 'config' && row.command === 'acp')
          .map((row) => row.id),
      ).toEqual([...expectedOrder, ...expectedOrder])
      expect(
        initial.filter((row) => row.stage === 'init').every((row) => row.directory === cwd),
      ).toBe(true)
      expect(initial.find((row) => row.id === 'legacy-a' && row.stage === 'init')?.option).toBe(
        'legacy-options',
      )
      expect(initial.find((row) => row.id === 'v1' && row.stage === 'init')?.option).toBe(
        'v1-options',
      )
      expect(initial.some((row) => row.stage === 'attempt' && row.id === 'init-failure')).toBe(true)
      expect(initial.some((row) => row.stage === 'attempt' && row.id === 'import-failure')).toBe(
        true,
      )
      expect(initial.some((row) => row.stage === 'unexpected')).toBe(false)
      await turn('initial')
      const withHooks = requests.at(-1)!
      expect(withHooks.label).toBe('initial')
      expect(withHooks.authorized).toBe(true)
      const markers = ['legacy-a', 'legacy-b', 'v1', 'config-failure'].map(
        (id) => `PLUGIN_HOOK_${id}`,
      )
      for (const marker of markers) expect(withHooks.system).toContain(marker)
      expect(markers.map((marker) => withHooks.system.indexOf(marker))).toEqual(
        markers.map((marker) => withHooks.system.indexOf(marker)).sort((a, b) => a - b),
      )
      const beforeExit = await receipts()
      expect([
        ...new Set(
          beforeExit
            .filter((row) => row.stage === 'system' && row.command === 'acp')
            .map((row) => row.cycle),
        ),
      ]).toEqual([2])
      await runtime.dispose()
      runtime = undefined
      const afterExit = await receipts()
      const initialPid = acpInitializers[0]!.pid
      const initialDisposals = afterExit
        .slice(beforeExit.length)
        .filter((row) => row.stage === 'dispose')
        .map((row) => row.id)

      runtime = await connect('active', nativeSessionId)
      expect(runtime.nativeSessionId).toBe(nativeSessionId)
      const resumeReceipts = (await receipts()).slice(afterExit.length)
      const restarted = resumeReceipts.filter(
        (row) => row.stage === 'init' && row.command === 'acp',
      )
      expect(restarted.map((row) => row.id)).toEqual([...expectedOrder, ...expectedOrder])
      expect(restarted.every((row) => row.pid !== initialPid)).toBe(true)
      const resumedMarker = resumeReceipts.find(
        (row) =>
          row.command === 'acp' && row.stage === 'config' && row.id === 'v1' && row.cycle === 2,
      )!.marker!
      expect(sessionReadbacks).toHaveLength(2)
      expect(sessionReadbacks[1]).toContain(resumedMarker)
      expect(sessionReadbacks[1]).not.toContain(currentMarker)
      await turn('resumed')
      expect(requests.at(-1)!.label).toBe('resumed')
      for (const marker of markers) expect(requests.at(-1)!.system).toContain(marker)
      await runtime.dispose()
      runtime = undefined
      const beforePure = await readFile(receiptsPath, 'utf8')
      runtime = await connect('pure')
      await turn('pure')
      expect(requests.at(-1)!.label).toBe('pure')
      expect(requests.at(-1)!.system).not.toContain('PLUGIN_HOOK_')
      expect(await readFile(receiptsPath, 'utf8')).toBe(beforePure)
      await runtime.dispose()
      runtime = undefined
      await store.verifyForReuse('active')
      await store.verifyForReuse('pure')
      if (process.env.AGENT_MATRIX_OPENCODE_PLUGIN_REPORT)
        await writeFile(
          process.env.AGENT_MATRIX_OPENCODE_PLUGIN_REPORT,
          JSON.stringify(
            {
              checkedAt: new Date().toISOString(),
              engine: 'opencode',
              engineVersion: '1.18.16',
              platform: process.platform,
              architecture: process.arch,
              scope:
                'Installed CLI contract probe with direct native fixture declarations; product plugin bindings remain blocked',
              route: 'Local synthetic Chat Completions endpoint',
              externalProviderCalls: false,
              legacyMultipleExports: true,
              legacyAliasDeduplication: true,
              v1ServerEntrypointAndRelativeTypeScriptDependency: true,
              v1UnrelatedNamedExportIgnored: true,
              nativeOptionsForwarded: true,
              sequentialInitializersAndSystemHooks: true,
              hookChangesObservedAtProvider: true,
              localPackageEngineRangeIsNotEnforced: true,
              readyDespiteImportInitAndConfigFailures: true,
              missingRelativeDependencyDoesNotPreventReady: true,
              nativeResumeReinitializesPluginsInNewProcess: true,
              readbackDebugProcessAlsoInitializesPlugins: true,
              acpInitializationsPerPluginAtNewSession: 2,
              acpInitializationsPerPluginAtResume: 2,
              initialAcpLifecycle: [1, 2].map((cycle) => ({
                cycle,
                initialized: initial
                  .filter(
                    (row) => row.command === 'acp' && row.stage === 'init' && row.cycle === cycle,
                  )
                  .map((row) => row.id),
                configured: initial
                  .filter(
                    (row) => row.command === 'acp' && row.stage === 'config' && row.cycle === cycle,
                  )
                  .map((row) => row.id),
                disposedBeforeReady: initial
                  .filter(
                    (row) =>
                      row.command === 'acp' && row.stage === 'dispose' && row.cycle === cycle,
                  )
                  .map((row) => row.id),
              })),
              firstTurnUsesSecondInitializationCycle: true,
              nativeSessionModeDescriptionIdentifiesCurrentInstance: true,
              initializationEvidenceMustCoverCurrentInstanceNotOnlyPid: true,
              pureModeSkipsExternalPluginsDespiteConfigReadback: true,
              disposeHooksObservedAfterOwnedProcessTermination: initialDisposals,
              generatedInputIntegrityAfterExit: true,
              limitations: [
                'No generic activation verifier yet',
                'No arbitrary plugin installation',
                'No external provider acceptance',
                'No cross-platform acceptance',
                'Native engine startup may maintain its own SDK dependencies; this probe does not assert zero registry traffic',
              ],
            },
            null,
            2,
          ) + '\n',
        )
    } finally {
      newSessionObserver.mockRestore()
      resumeSessionObserver.mockRestore()
      loadSessionObserver.mockRestore()
      await runtime?.dispose()
      server.closeAllConnections()
      if (server.listening) await new Promise<void>((resolve) => server.close(() => resolve()))
      await rm(root, { recursive: true, force: true })
    }
  },
)
