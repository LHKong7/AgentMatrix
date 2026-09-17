import { createServer } from 'node:http'
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { isAbsolute, join } from 'node:path'
import { expect, it, vi } from 'vitest'
import { z } from 'zod'
import { attachPiProcess, type PiAttachment } from '../src/main/engines/pi/attachment'
import { type PiDialog, type PiDialogAnswer, type PiRecord } from '../src/main/engines/pi/protocol'
import { baseProcessEnvironment } from '../src/main/engines/process/managed-process'
import { captureCommand } from '../src/main/engines/process/capture-command'

const executable = process.env.AGENT_MATRIX_TEST_PI
const stateSchema = z.looseObject({
  sessionId: z.string().min(1),
  sessionFile: z.string().min(1),
  isStreaming: z.boolean(),
  isCompacting: z.boolean(),
  pendingMessageCount: z.number(),
  model: z.looseObject({
    id: z.string(),
    provider: z.string(),
    api: z.string(),
    baseUrl: z.string(),
  }),
})
interface RequestBody {
  model: string
  stream: boolean
  messages: { role: string; content: unknown }[]
}

it.runIf(Boolean(executable))(
  'exercises Pi RPC turns, cancellation, restoration, and project trust against a local provider',
  async () => {
    if (!executable || !isAbsolute(executable))
      throw new Error('An absolute Pi executable is required')
    const root = await realpath(await mkdtemp(join(tmpdir(), 'agentmatrix-pi-runtime-')))
    const home = join(root, 'home'),
      config = join(root, 'config'),
      cwd = join(root, 'project')
    const sessions = join(root, 'sessions')
    for (const path of [home, config, cwd, sessions]) await mkdir(path)
    const key = 'synthetic-pi-key-"-$-!'
    const env = {
      ...baseProcessEnvironment(process.env),
      HOME: home,
      PI_CODING_AGENT_DIR: config,
      PI_OFFLINE: 'true',
      PI_TELEMETRY: 'false',
      AM_PI_KEY: key,
      XDG_CONFIG_HOME: join(home, 'config'),
      XDG_DATA_HOME: join(home, 'data'),
      XDG_CACHE_HOME: join(home, 'cache'),
      XDG_STATE_HOME: join(home, 'state'),
    }
    await writeFile(join(config, 'SYSTEM.md'), 'PI_ROLE_MARKER')
    await writeFile(join(config, 'APPEND_SYSTEM.md'), 'PI_APPEND_MARKER')
    await writeFile(
      join(config, 'settings.json'),
      JSON.stringify({ retry: { enabled: false }, compaction: { enabled: false } }),
    )
    await writeFile(join(cwd, 'fixture.txt'), 'PI_TOOL_RESULT_MARKER')
    let phase: 'tool' | 'stream' | 'resume' | 'error' | 'trust' = 'tool'
    const requests: { authorization: string | undefined; body: RequestBody }[] = []
    let serverError: unknown = null
    const server = createServer(async (request, response) => {
      try {
        if (request.url !== '/v1/chat/completions') throw new Error('Unexpected fixture route')
        let body = ''
        for await (const part of request) {
          body += String(part)
          if (body.length > 2_097_152) throw new Error('Fixture request limit')
        }
        const input = JSON.parse(body) as RequestBody
        requests.push({ authorization: request.headers.authorization, body: input })
        if (phase === 'error') {
          response.writeHead(400, { 'Content-Type': 'application/json' })
          response.end(
            JSON.stringify({
              error: { message: 'Synthetic provider rejection', type: 'invalid_request_error' },
            }),
          )
          return
        }
        if (!input.stream) throw new Error('Fixture expects streaming requests')
        response.writeHead(200, { 'Content-Type': 'text/event-stream' })
        const chunk = (delta: object, finish_reason: string | null = null) =>
          response.write(
            `data: ${JSON.stringify({
              id: 'pi-fixture',
              object: 'chat.completion.chunk',
              created: 1,
              model: input.model,
              choices: [{ index: 0, delta, finish_reason }],
            })}\n\n`,
          )
        chunk({ role: 'assistant' })
        if (phase === 'stream') {
          chunk({ content: 'PI_STREAM_MARKER' })
          return
        }
        const hasToolResult = input.messages.some(
          (message) =>
            message.role === 'tool' &&
            JSON.stringify(message.content).includes('PI_TOOL_RESULT_MARKER'),
        )
        if (phase === 'tool' && !hasToolResult) {
          chunk({
            tool_calls: [
              {
                index: 0,
                id: 'pi-read',
                type: 'function',
                function: {
                  name: 'read',
                  arguments: JSON.stringify({ path: join(cwd, 'fixture.txt') }),
                },
              },
            ],
          })
          chunk({}, 'tool_calls')
        } else {
          chunk({ content: 'PI_TEXT_中文🙂\u2028\u2029_MARKER' })
          chunk({}, 'stop')
        }
        response.write(
          `data: ${JSON.stringify({
            id: 'pi-fixture',
            object: 'chat.completion.chunk',
            created: 1,
            model: input.model,
            choices: [],
            usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
          })}\n\n`,
        )
        response.end('data: [DONE]\n\n')
      } catch (error) {
        serverError = error
        response.writeHead(500)
        response.end()
      }
    })
    const attachments: PiAttachment[] = []
    const events: PiRecord[] = []
    const dialogs: PiDialog[] = []
    let answer: (request: PiDialog, signal: AbortSignal) => Promise<PiDialogAnswer> = async () => ({
      cancelled: true,
    })
    const launch = async (
      extra: string[] = [],
      trust: 'deny' | 'allow' | 'default' = 'deny',
      resources = false,
    ) => {
      const attachment = await attachPiProcess(
        {
          executable,
          cwd,
          environment: env,
          secrets: [key],
          args: [
            '--mode',
            'rpc',
            '--provider',
            'agentmatrix-fixture',
            '--model',
            'fixture-model',
            '--tools',
            'read',
            '--session-dir',
            sessions,
            '--no-skills',
            '--no-prompt-templates',
            ...(resources ? [] : ['--no-extensions']),
            ...(trust === 'deny' ? ['--no-approve'] : trust === 'allow' ? ['--approve'] : []),
            ...extra,
          ],
        },
        {
          event: async (event) => {
            events.push(event)
          },
          dialog: async (request, signal) => {
            dialogs.push(request)
            return answer(request, signal)
          },
        },
        { requestTimeoutMs: 20_000 },
      )
      attachments.push(attachment)
      return attachment
    }
    const settled = async (from: number) =>
      vi.waitFor(
        () => expect(events.slice(from).some((event) => event.type === 'agent_settled')).toBe(true),
        { timeout: 20_000 },
      )
    try {
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
      const address = server.address()
      if (!address || typeof address === 'string') throw new Error('Missing fixture address')
      const baseUrl = `http://127.0.0.1:${address.port}/v1`
      await writeFile(
        join(config, 'models.json'),
        JSON.stringify({
          providers: {
            'agentmatrix-fixture': {
              api: 'openai-completions',
              baseUrl,
              apiKey: '$AM_PI_KEY',
              models: [
                {
                  id: 'fixture-model',
                  reasoning: false,
                  contextWindow: 128000,
                  maxTokens: 4096,
                  compat: {
                    supportsDeveloperRole: false,
                    supportsStore: false,
                    supportsReasoningEffort: false,
                  },
                },
              ],
            },
          },
        }),
      )
      const version = (
        await captureCommand(
          { executable, cwd, args: ['--version'], environment: env },
          new AbortController().signal,
        )
      ).trim()
      expect(version).toBe('0.85.1')
      let attachment = await launch()
      const initial = stateSchema.parse(await attachment.client.request({ type: 'get_state' }))
      expect(initial.model).toMatchObject({
        id: 'fixture-model',
        provider: 'agentmatrix-fixture',
        api: 'openai-completions',
        baseUrl,
      })
      let from = events.length
      await attachment.client.request({ type: 'prompt', message: 'Read fixture.txt.' })
      await settled(from)
      expect(
        events
          .slice(from)
          .some(
            (event) =>
              event.type === 'tool_execution_end' &&
              event.isError === false &&
              JSON.stringify(event.result).includes('PI_TOOL_RESULT_MARKER'),
          ),
      ).toBe(true)
      expect(
        events
          .slice(from)
          .some(
            (event) =>
              event.type === 'message_update' &&
              JSON.stringify(event).includes('PI_TEXT_中文🙂\u2028\u2029_MARKER'),
          ),
      ).toBe(true)
      expect(dialogs).toHaveLength(0)
      expect(requests.length).toBe(2)
      expect(
        requests.every(
          (request) =>
            request.authorization === `Bearer ${key}` && request.body.model === 'fixture-model',
        ),
      ).toBe(true)
      expect(JSON.stringify(requests[0]!.body.messages)).toContain('PI_ROLE_MARKER')
      expect(JSON.stringify(requests[0]!.body.messages)).toContain('PI_APPEND_MARKER')

      phase = 'stream'
      from = events.length
      await attachment.client.request({ type: 'prompt', message: 'Stream until cancelled.' })
      await vi.waitFor(
        () =>
          expect(
            events
              .slice(from)
              .some(
                (event) =>
                  event.type === 'message_update' &&
                  JSON.stringify(event).includes('PI_STREAM_MARKER'),
              ),
          ).toBe(true),
        { timeout: 15_000 },
      )
      expect(events.slice(from).some((event) => event.type === 'agent_settled')).toBe(false)
      await attachment.client.request({ type: 'clear_queue' })
      await attachment.client.request({ type: 'abort' })
      await settled(from)
      expect(
        events
          .slice(from)
          .some(
            (event) =>
              event.type === 'message_end' &&
              JSON.stringify(event.message).includes('"stopReason":"aborted"'),
          ),
      ).toBe(true)
      expect(
        stateSchema.parse(await attachment.client.request({ type: 'get_state' })),
      ).toMatchObject({ isStreaming: false, pendingMessageCount: 0 })

      phase = 'error'
      from = events.length
      await attachment.client.request({
        type: 'prompt',
        message: 'Trigger synthetic provider failure.',
      })
      await settled(from)
      expect(
        events
          .slice(from)
          .some(
            (event) =>
              event.type === 'message_end' &&
              JSON.stringify(event.message).includes('"stopReason":"error"'),
          ),
      ).toBe(true)
      const beforeRestart = stateSchema.parse(
        await attachment.client.request({ type: 'get_state' }),
      )
      const history = await attachment.client.request({ type: 'get_messages' })
      expect(JSON.stringify(history)).toContain('PI_TOOL_RESULT_MARKER')
      const cleanup = await attachment.close()
      expect(attachment.process.done).toBe(true)
      expect(cleanup.failure).toBeNull()
      expect(await readFile(beforeRestart.sessionFile, 'utf8')).toContain('PI_TOOL_RESULT_MARKER')

      phase = 'resume'
      attachment = await launch()
      const fresh = stateSchema.parse(await attachment.client.request({ type: 'get_state' }))
      expect(fresh.sessionId).not.toBe(beforeRestart.sessionId)
      expect(
        await attachment.client.request({
          type: 'switch_session',
          sessionPath: beforeRestart.sessionFile,
        }),
      ).toMatchObject({ cancelled: false })
      const restored = stateSchema.parse(await attachment.client.request({ type: 'get_state' }))
      expect(restored.sessionId).toBe(beforeRestart.sessionId)
      expect(await attachment.client.request({ type: 'get_messages' })).toEqual(history)
      from = events.length
      await attachment.client.request({ type: 'prompt', message: 'Use the retained file context.' })
      await settled(from)
      expect(JSON.stringify(requests.at(-1)!.body.messages)).toContain('PI_TOOL_RESULT_MARKER')
      await attachment.close()

      // Only this explicitly selected, local test extension is allowed to show a dialog.
      const extension = join(root, 'dialog.ts')
      await writeFile(
        extension,
        `export default function (pi) {
      pi.registerCommand('matrix-dialog', { description: 'Fixture dialog', handler: async (_args, ctx) => {
        const value = await ctx.ui.select('Fixture selection', ['First', 'Second']);
        ctx.ui.notify(value === 'Second' ? 'PI_DIALOG_SECOND' : 'PI_DIALOG_CANCELLED', 'info');
      } });
    }`,
      )
      attachment = await launch(['--extension', extension])
      await attachment.client.request({ type: 'get_state' })
      answer = async () => ({ value: 'Second' })
      const callsBeforeDialog = requests.length
      from = events.length
      await attachment.client.request({ type: 'prompt', message: '/matrix-dialog' })
      await vi.waitFor(() =>
        expect(events.slice(from).some((event) => event.message === 'PI_DIALOG_SECOND')).toBe(true),
      )
      expect(events.slice(from).some((event) => event.type === 'agent_settled')).toBe(false)
      answer = (_request, signal) =>
        new Promise((resolve) =>
          signal.addEventListener('abort', () => resolve({ cancelled: true }), { once: true }),
        )
      const dialogCount = dialogs.length
      from = events.length
      const waiting = attachment.client.request({ type: 'prompt', message: '/matrix-dialog' })
      await vi.waitFor(() => expect(dialogs.length).toBe(dialogCount + 1))
      await attachment.client.request({ type: 'abort' })
      await waiting
      await vi.waitFor(() =>
        expect(events.slice(from).some((event) => event.message === 'PI_DIALOG_CANCELLED')).toBe(
          true,
        ),
      )
      expect(requests.length).toBe(callsBeforeDialog)
      await attachment.close()

      phase = 'trust'
      const projectConfig = join(cwd, '.pi'),
        marker = join(cwd, 'extension-loaded.txt')
      await mkdir(join(projectConfig, 'extensions'), { recursive: true })
      await writeFile(join(projectConfig, 'SYSTEM.md'), 'PI_PROJECT_ROLE_MARKER')
      await writeFile(
        join(projectConfig, 'extensions', 'trust.ts'),
        `import { writeFileSync } from 'node:fs'; export default function () { writeFileSync(${JSON.stringify(marker)}, 'loaded'); }`,
      )
      const trustFile = join(config, 'trust.json')
      const trustBefore = JSON.stringify({ [join(root, 'unrelated-project')]: false }) + '\n'
      await writeFile(trustFile, trustBefore)
      for (const trust of ['default', 'deny', 'allow'] as const) {
        attachment = await launch([], trust, true)
        await attachment.client.request({ type: 'get_state' })
        const markerExists = await readFile(marker, 'utf8').catch(() => null)
        expect(markerExists).toBe(trust === 'allow' ? 'loaded' : null)
        from = events.length
        await attachment.client.request({ type: 'prompt', message: 'Report the fixture role.' })
        await settled(from)
        expect(
          JSON.stringify(requests.at(-1)!.body.messages).includes('PI_PROJECT_ROLE_MARKER'),
        ).toBe(trust === 'allow')
        await attachment.close()
      }
      expect(await readFile(trustFile, 'utf8').catch(() => null)).toBe(trustBefore)
      expect(serverError).toBeNull()
      expect(attachments.every((item) => item.process.done)).toBe(true)
      const report = {
        checkedAt: new Date().toISOString(),
        platform: process.platform,
        architecture: process.arch,
        engine: 'pi',
        version,
        route: 'Local Chat Completions protocol fixture',
        externalProviderCalls: false,
        applicationRpcClient: true,
        streamingUnicode: true,
        toolRoundTrip: true,
        keyEnvironmentReference: true,
        replacementAndAppendPrompt: true,
        acceptanceBeforeSettlement: true,
        postAcceptanceFailure: true,
        streamingCancellation: true,
        processRestart: true,
        nativeSessionRestoration: true,
        restoredProviderContext: true,
        extensionDialogReply: true,
        extensionDialogCancellation: true,
        extensionCommandWithoutAgentSettlement: true,
        projectTrustDefaultDenied: true,
        projectTrustOverrides: true,
        unrelatedTrustDecisionsUnchanged: true,
        universalToolApproval: false,
        coreMcpExtension: null,
        cleanup: { scope: cleanup.cleanup, failure: cleanup.failure, forced: cleanup.forced },
      }
      if (process.env.AGENT_MATRIX_PI_REPORT)
        await writeFile(process.env.AGENT_MATRIX_PI_REPORT, JSON.stringify(report, null, 2) + '\n')
    } finally {
      const stopped = await Promise.allSettled(attachments.map((attachment) => attachment.close()))
      server.closeAllConnections()
      await new Promise<void>((resolve) => server.close(() => resolve()))
      if (stopped.some((result) => result.status === 'rejected'))
        throw new Error('Pi fixture cleanup is unconfirmed; its isolated files were retained')
      await rm(root, { recursive: true, force: true })
    }
  },
)
