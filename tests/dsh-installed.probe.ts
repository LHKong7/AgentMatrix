import { createServer } from 'node:http'
import { mkdir, mkdtemp, readFile, realpath, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { createRequire } from 'node:module'
import { dirname, isAbsolute, join } from 'node:path'
import { createHash } from 'node:crypto'
import { parseDocument, stringify } from 'yaml'
import { afterAll, expect, it } from 'vitest'
import type { RequestPermissionRequest, SessionNotification } from '@agentclientprotocol/sdk'
import { attachAcpProcess, type AcpAttachment } from '../src/main/engines/acp/attachment'
import { baseProcessEnvironment } from '../src/main/engines/process/managed-process'
import { captureCommand } from '../src/main/engines/process/capture-command'
import { closeNativeFixture } from './helpers/close-native-fixture'

const executable = process.env.AGENT_MATRIX_TEST_DSH
const results: object[] = []
const release = '0.1.5-rc.2'
const model = 'agentmatrix-dsh-fixture'
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { resolve, promise }
}
async function waitForProgress<T>(progress: Promise<void>, operation: Promise<T>): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    await Promise.race([
      progress,
      operation.then(() => {
        throw new Error('Native operation ended before the expected fixture phase')
      }),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error('Fixture phase timed out')), 15_000)
      }),
    ])
  } finally {
    clearTimeout(timer)
  }
}
interface Row {
  id: string
  name?: string
  config?: Record<string, unknown>
  disabled?: boolean
}
interface Body {
  model: string
  stream: boolean
  messages: { role: string; content: unknown }[]
}

async function installedComponents(bin: string) {
  const require = createRequire(await realpath(bin))
  const components: { name: string; version: string; entryDigest: string }[] = []
  for (const name of [
    'dsh-base',
    'dsh-acp-app',
    'dsh-acp',
    'dsh-llm-deepseek',
    'dsh-llm-pi-ai',
    'dsh-system-prompt',
    'dsh-session-persistence-jsonl',
    'dsh-tool-fs',
    'dsh-user-approval',
  ]) {
    const qualified = `@deepseek-ai/${name}`
    const entry = require.resolve(qualified)
    let directory = dirname(entry)
    for (;;) {
      const manifest = await readFile(join(directory, 'package.json'), 'utf8')
        .then((bytes) => JSON.parse(bytes) as { name: string; version: string })
        .catch(() => null)
      if (manifest?.name === qualified) {
        expect(manifest.version).toBe(release)
        components.push({
          name: qualified,
          version: manifest.version,
          entryDigest: createHash('sha256')
            .update(await readFile(entry))
            .digest('hex'),
        })
        break
      }
      const parent = dirname(directory)
      if (parent === directory) throw new Error('Cannot identify an installed DSH component')
      directory = parent
    }
  }
  return components
}

for (const route of ['pi-ai', 'deepseek-native'] as const) {
  it.runIf(Boolean(executable))(
    `exercises DSH ACP with its ${route} provider component`,
    async () => {
      if (!executable || !isAbsolute(executable))
        throw new Error('An absolute DSH executable is required')
      const root = await realpath(await mkdtemp(join(tmpdir(), 'agentmatrix-dsh-runtime-')))
      const home = join(root, 'home'),
        harnessHome = join(root, 'dsh'),
        cwd = join(root, 'project')
      for (const path of [home, harnessHome, cwd]) await mkdir(path)
      const key = 'synthetic-dsh-key-quote-"'
      const environment = {
        ...baseProcessEnvironment(process.env),
        HOME: home,
        DSH_HOME: harnessHome,
        DSH_TELEMETRY_DISABLED: '1',
        AM_DSH_KEY: key,
        XDG_CONFIG_HOME: join(home, 'config'),
        XDG_DATA_HOME: join(home, 'data'),
        XDG_CACHE_HOME: join(home, 'cache'),
        XDG_STATE_HOME: join(home, 'state'),
      }
      const provider = route === 'pi-ai' ? 'agentmatrix-gateway' : 'deepseek-official'
      const target = join(cwd, 'approved.txt'),
        cancelledTarget = join(cwd, 'cancelled.txt')
      await writeFile(join(cwd, 'fixture.txt'), 'DSH_READ_MARKER')
      const overlay = join(root, 'run.patch.yml')
      const updates: SessionNotification[] = []
      const permissions: RequestPermissionRequest[] = []
      const attachments: AcpAttachment[] = []
      let phase: 'tools' | 'stream' | 'permission' | 'resume' | 'error' = 'tools'
      let phaseStep = 0
      const streamStarted = deferred<void>(),
        permissionStarted = deferred<void>()
      const requests: { path: string; authorization: string | undefined; input: Body }[] = []
      let serverError: unknown = null
      const server = createServer(async (request, response) => {
        try {
          let text = ''
          for await (const part of request) {
            text += String(part)
            if (text.length > 4_194_304) throw new Error('Fixture request limit')
          }
          const input = JSON.parse(text) as Body
          requests.push({
            path: request.url ?? '',
            authorization: request.headers.authorization,
            input,
          })
          if (request.url !== '/v1/chat/completions' || input.model !== model || !input.stream)
            throw new Error('Unexpected provider route')
          if (phase === 'error') {
            response.writeHead(400, { 'Content-Type': 'application/json' })
            response.end(
              JSON.stringify({
                error: { message: 'Synthetic provider failure', type: 'invalid_request_error' },
              }),
            )
            return
          }
          response.writeHead(200, { 'Content-Type': 'text/event-stream' })
          const chunk = (delta: object, finish_reason: string | null = null) =>
            response.write(
              `data: ${JSON.stringify({
                id: 'dsh-fixture',
                object: 'chat.completion.chunk',
                created: 1,
                model,
                choices: [{ index: 0, delta, finish_reason }],
              })}\n\n`,
            )
          chunk({ role: 'assistant' })
          if (phase === 'stream') {
            chunk({ content: 'DSH_UNCOMMITTED_STREAM_MARKER' })
            streamStarted.resolve()
            return
          }
          const step = phaseStep++
          const tool = (name: string, args: object) => {
            chunk({
              tool_calls: [
                {
                  index: 0,
                  id: `dsh-${phase}-${step}`,
                  type: 'function',
                  function: { name, arguments: JSON.stringify(args) },
                },
              ],
            })
            chunk({}, 'tool_calls')
          }
          if (phase === 'tools' && step === 0) tool('read', { file_path: join(cwd, 'fixture.txt') })
          else if ((phase === 'tools' && step === 1) || (phase === 'permission' && step === 0))
            tool('write', {
              file_path: phase === 'tools' ? target : cancelledTarget,
              content: 'DSH_WRITE_MARKER',
            })
          else if ((phase === 'tools' && step === 2) || (phase === 'permission' && step === 1))
            tool('write', {
              file_path: phase === 'tools' ? target : cancelledTarget,
              content: 'DSH_WRITE_MARKER',
              sandbox_permissions: 'workspace-write',
              justification: 'Write the isolated AgentMatrix fixture file.',
            })
          else {
            chunk({ content: 'DSH_ASSISTANT_MARKER' })
            chunk({}, 'stop')
          }
          response.write(
            `data: ${JSON.stringify({ id: 'dsh-fixture', object: 'chat.completion.chunk', created: 1, model, choices: [], usage: { prompt_tokens: 12, completion_tokens: 5, total_tokens: 17 } })}\n\n`,
          )
          response.end('data: [DONE]\n\n')
        } catch (error) {
          serverError = error
          response.writeHead(500)
          response.end()
        }
      })
      const launch = async () => {
        const attachment = await attachAcpProcess(
          {
            executable,
            cwd,
            environment,
            secrets: [key],
            args: ['--profile', 'acp', '--patch', overlay],
          },
          {
            update: async (update) => {
              updates.push(update)
            },
            permission: async (request, signal) => {
              permissions.push(request)
              if (phase === 'permission') {
                permissionStarted.resolve()
                await new Promise<void>((resolve) =>
                  signal.aborted
                    ? resolve()
                    : signal.addEventListener('abort', () => resolve(), { once: true }),
                )
                return { outcome: { outcome: 'cancelled' } }
              }
              expect(request.options.map((option) => option.kind).sort()).toEqual([
                'allow_once',
                'reject_once',
              ])
              const option = request.options.find((option) => option.kind === 'allow_once')!
              return { outcome: { outcome: 'selected', optionId: option.optionId } }
            },
          },
          { requestTimeoutMs: 20_000 },
        )
        attachments.push(attachment)
        await attachment.client.initialize('0.1.0')
        return attachment
      }
      try {
        await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
        const address = server.address()
        if (!address || typeof address === 'string') throw new Error('Missing fixture address')
        const baseURL = `http://127.0.0.1:${address.port}/v1`
        const providerConfig = {
          apiKeyEnv: 'AM_DSH_KEY',
          baseURL,
          models: [{ id: model, contextWindow: 128000, maxTokens: 4096 }],
          retryPolicy: { mode: 'normal', maxRetries: 0 },
        }
        const rows: Row[] = [
          { id: 'acp', config: { provider, model } },
          {
            id: 'system-prompt',
            config: {
              personaPrefix: 'DSH_PREFIX_MARKER',
              personaSuffix: 'DSH_SUFFIX_MARKER {{cwd}}',
              includeHarnessIdentity: false,
            },
          },
          { id: 'sandbox-policy', config: { mode: 'read-only', workspaceRoot: cwd } },
          { id: 'approval', config: { policy: 'ask' } },
          route === 'pi-ai'
            ? {
                id: 'llm-pi-ai',
                config: {
                  providers: {
                    [provider]: {
                      ...providerConfig,
                      api: 'openai-completions',
                      compat: {
                        supportsDeveloperRole: false,
                        supportsStore: false,
                        supportsReasoningEffort: false,
                      },
                    },
                  },
                },
              }
            : {
                id: 'llm-deepseek',
                config: { ...providerConfig, thinking: 'disabled', maxTokens: 4096 },
              },
          { id: 'session-telemetry-otel', disabled: true },
        ]
        await writeFile(overlay, stringify(rows))
        const version = (
          await captureCommand(
            { executable, cwd, environment, args: ['--version'] },
            new AbortController().signal,
          )
        ).trim()
        expect(version).toBe(release)
        const components = await installedComponents(executable)
        // Initialize the shipped profile, then exercise all user patch layers over its bundle rows.
        const dump = async () =>
          captureCommand(
            {
              executable,
              cwd,
              environment,
              args: ['--profile', 'acp', '--patch', overlay, '--dump-config'],
            },
            new AbortController().signal,
          )
        await dump()
        await writeFile(
          join(harnessHome, 'profiles/acp/cordis.patch.yml'),
          stringify([
            {
              id: 'system-prompt',
              config: {
                personaPrefix: 'PROFILE_MARKER',
                personaSuffix: 'REMOVED_SUFFIX',
                toolOrder: ['read'],
              },
            },
          ]),
        )
        await writeFile(
          join(harnessHome, 'cordis.patch.yml'),
          stringify([{ id: 'system-prompt', config: { personaPrefix: 'HOME_MARKER' } }]),
        )
        const document = parseDocument(await dump(), {
          customTags: [{ tag: 'tag:yaml.org,2002:js', resolve: (value: string) => value }],
        })
        expect(document.errors).toEqual([])
        const composed = document.toJS() as Row[]
        expect(composed.find((row) => row.id === 'system-prompt')?.config).toEqual(rows[1]!.config)
        expect(composed.find((row) => row.id === 'session-telemetry-otel')?.disabled).toBe(true)
        const profile = JSON.parse(
          await readFile(join(harnessHome, 'profiles/acp/package.json'), 'utf8'),
        )
        expect(profile.dsh.profile.patchReload).toBe('startup')
        let attachment = await launch()
        const acpAgentInfo = attachment.client.capabilities?.agentInfo
        expect(acpAgentInfo).toMatchObject({ name: 'deepseek-harness-acp', version: '0.0.1' })
        expect(
          attachment.client.capabilities?.agentCapabilities?.sessionCapabilities,
        ).toMatchObject({ list: {}, resume: {}, close: {} })
        const created = await attachment.client.newSession({ cwd, mcpServers: [] })
        const id = created.sessionId
        const selected = created.configOptions?.find((option) => option.id === 'model')
        expect(selected?.type).toBe('select')
        if (selected?.type !== 'select') throw new Error('Missing native model selector')
        expect(selected?.currentValue).toBeTruthy()
        const current = await attachment.client.setSessionConfigOption({
          sessionId: id,
          configId: 'model',
          value: selected!.currentValue,
        })
        expect(current.configOptions.find((option) => option.id === 'model')?.currentValue).toBe(
          selected!.currentValue,
        )
        const prompt = (message: string) =>
          attachment.client.prompt(
            { sessionId: id, prompt: [{ type: 'text', text: message }] },
            30_000,
          )
        const completed = await prompt('Read fixture.txt and write the isolated approval fixture.')
        expect(completed.stopReason).toBe('end_turn')
        expect(completed.usage).toBeUndefined()
        expect(await readFile(target, 'utf8')).toBe('DSH_WRITE_MARKER')
        expect(permissions).toHaveLength(1)
        expect(JSON.stringify(requests.at(-1)!.input.messages)).toContain('DSH_READ_MARKER')
        expect(JSON.stringify(requests[0]!.input.messages)).toContain('DSH_PREFIX_MARKER')
        expect(JSON.stringify(requests[0]!.input.messages)).toContain('DSH_SUFFIX_MARKER')
        expect(JSON.stringify(requests[0]!.input.messages)).not.toContain('PROFILE_MARKER')
        expect(updates.some((item) => item.update.sessionUpdate === 'agent_message_chunk')).toBe(
          true,
        )
        expect(
          updates.some(
            (item) =>
              item.update.sessionUpdate === 'tool_call_update' &&
              item.update.status === 'completed',
          ),
        ).toBe(true)

        // A startup-only patch must not replace a live bridge or its prompt composition.
        const changedRows = structuredClone(rows)
        changedRows[1]!.config!.personaPrefix = 'DSH_RESTART_PREFIX_MARKER'
        await writeFile(overlay, stringify(changedRows))
        await new Promise((resolve) => setTimeout(resolve, 350))
        phase = 'resume'
        expect((await prompt('Check the active composition after a patch edit.')).stopReason).toBe(
          'end_turn',
        )
        expect(JSON.stringify(requests.at(-1)!.input.messages)).toContain('DSH_PREFIX_MARKER')
        expect(JSON.stringify(requests.at(-1)!.input.messages)).not.toContain(
          'DSH_RESTART_PREFIX_MARKER',
        )
        await writeFile(overlay, stringify(rows))

        phase = 'stream'
        phaseStep = 0
        const updateStart = updates.length
        const streaming = prompt('Stream until cancelled.')
        await waitForProgress(streamStarted.promise, streaming)
        await new Promise((resolve) => setTimeout(resolve, 150))
        const partialCommitted = updates
          .slice(updateStart)
          .some((item) => item.update.sessionUpdate === 'agent_message_chunk')
        expect(partialCommitted).toBe(false)
        await attachment.client.cancel(id)
        expect((await streaming).stopReason).toBe('cancelled')
        phase = 'permission'
        phaseStep = 0
        const waiting = prompt('Try another isolated write, then request escalation.')
        await waitForProgress(permissionStarted.promise, waiting)
        await attachment.client.cancel(id)
        expect((await waiting).stopReason).toBe('cancelled')
        expect(await readFile(cancelledTarget, 'utf8').catch(() => null)).toBeNull()

        await attachment.client.closeSession(id)
        expect(
          (await attachment.client.listSessions({ cwd })).sessions.some(
            (session) => session.sessionId === id,
          ),
        ).toBe(true)
        const cleanup = await attachment.close()
        expect(cleanup.failure).toBeNull()
        phase = 'resume'
        phaseStep = 0
        attachment = await launch()
        expect(
          (await attachment.client.listSessions({ cwd })).sessions.some(
            (session) => session.sessionId === id,
          ),
        ).toBe(true)
        const resumeStart = updates.length
        await attachment.client.resumeSession({ sessionId: id, cwd, mcpServers: [] })
        expect(
          updates
            .slice(resumeStart)
            .some(
              (item) =>
                item.update.sessionUpdate === 'agent_message_chunk' ||
                item.update.sessionUpdate === 'tool_call',
            ),
        ).toBe(false)
        expect((await prompt('Use the previously read fixture context.')).stopReason).toBe(
          'end_turn',
        )
        expect(JSON.stringify(requests.at(-1)!.input.messages)).toContain('DSH_READ_MARKER')
        phase = 'error'
        phaseStep = 0
        await expect(prompt('Trigger a synthetic provider failure.')).rejects.toMatchObject({
          code: 'engine',
        })
        await attachment.client.closeSession(id)
        await attachment.close()
        await writeFile(overlay, stringify(changedRows))
        phase = 'resume'
        attachment = await launch()
        const changed = await attachment.client.newSession({ cwd, mcpServers: [] })
        expect(changed.sessionId).not.toBe(id)
        expect(
          (
            await attachment.client.prompt(
              {
                sessionId: changed.sessionId,
                prompt: [{ type: 'text', text: 'Check the new composition after restart.' }],
              },
              30_000,
            )
          ).stopReason,
        ).toBe('end_turn')
        expect(JSON.stringify(requests.at(-1)!.input.messages)).toContain(
          'DSH_RESTART_PREFIX_MARKER',
        )
        expect(JSON.stringify(requests.at(-1)!.input.messages)).not.toContain('DSH_PREFIX_MARKER')
        await attachment.client.closeSession(changed.sessionId)
        await attachment.close()
        expect(requests.every((request) => request.authorization === `Bearer ${key}`)).toBe(true)
        expect(serverError).toBeNull()
        expect(attachments.every((item) => item.process.done)).toBe(true)
        results.push({
          route,
          provider,
          model,
          engineVersion: version,
          acpAgentInfo,
          components,
          applicationAcpClient: true,
          providerCalls: requests.length,
          customEndpointAndKey: true,
          personaPrefixAndSuffix: true,
          patchOverlayPrecedence: true,
          startupReloadPolicy: true,
          startupPatchChangesRequireRestart: true,
          wholeRowConfigReplacement: true,
          opaqueModelSelection: true,
          readTool: true,
          approvedWrite: true,
          permissionCancellation: true,
          providerStreamCancellation: true,
          partialProviderDeltasForwarded: partialCommitted,
          nativeListAfterCloseAndRestart: true,
          nativeResumeWithToolContext: true,
          nativeTranscriptReplay: false,
          providerFailureRejected: true,
          promptUsageAbsent: completed.usage === undefined,
          contextUsageObserved: updates.some(
            (item) => item.update.sessionUpdate === 'usage_update',
          ),
          telemetryDisabled: true,
          cleanup: { scope: cleanup.cleanup, failure: cleanup.failure, forced: cleanup.forced },
        })
      } finally {
        await closeNativeFixture(attachments, server, root)
      }
    },
  )
}

afterAll(async () => {
  if (process.env.AGENT_MATRIX_DSH_REPORT && results.length === 2)
    await writeFile(
      process.env.AGENT_MATRIX_DSH_REPORT,
      JSON.stringify(
        {
          checkedAt: new Date().toISOString(),
          platform: process.platform,
          architecture: process.arch,
          externalProviderCalls: false,
          scope: 'Installed DSH ACP lifecycle with two isolated local provider fixtures',
          routes: results,
        },
        null,
        2,
      ) + '\n',
    )
})
