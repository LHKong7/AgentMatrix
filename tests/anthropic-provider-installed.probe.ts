import { createServer } from 'node:http'
import { mkdir, mkdtemp, readFile, realpath, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { isAbsolute, join } from 'node:path'
import { expect, it, vi } from 'vitest'
import { SkillDirectoryStore } from '../src/main/assets/skill-directory-store'
import { RunInputStore } from '../src/main/engines/run-input-store'
import { DesktopSessionFactory } from '../src/main/sessions/desktop-factory'
import { createSessionSnapshot } from '../src/shared/sessions/state'
import type { RuntimeSession, RuntimeOutput } from '../src/main/engines/runtime'
import { openCodeWorkspace } from './helpers/opencode-fixture'
import { piWorkspace } from './helpers/pi-fixture'
import { dshWorkspace } from './helpers/dsh-fixture'
import { closeNativeFixture } from './helpers/close-native-fixture'

for (const engine of ['opencode', 'pi', 'dsh'] as const) {
  for (const endpointStyle of ['root', 'versioned'] as const) {
    const executable = process.env[`AGENT_MATRIX_TEST_${engine.toUpperCase()}`]
    it.runIf(Boolean(executable))(
      `verifies the Anthropic Messages route through ${engine} with a ${endpointStyle} endpoint`,
      async () => {
        if (!executable || !isAbsolute(executable)) throw new Error('Absolute executable required')
        const root = await realpath(
          await mkdtemp(join(tmpdir(), `agentmatrix-anthropic-${engine}-`)),
        )
        const cwd = join(root, 'project'),
          home = join(root, 'home')
        const runtimes: RuntimeSession[] = []
        const errors: unknown[] = [],
          outputs: RuntimeOutput[] = []
        const requests: { path: string; primary: boolean; phase: string }[] = []
        const bodies: string[] = []
        const key = 'synthetic-anthropic-key',
          headerKey = 'synthetic-anthropic-header'
        let phase: 'tools' | 'stream' | 'resume' | 'error' | 'auth-error' = 'tools',
          step = 0,
          streaming = false
        const server = createServer(async (request, response) => {
          try {
            let raw = ''
            for await (const part of request) {
              raw += String(part)
              if (raw.length > 4_194_304) throw new Error('Request limit')
            }
            const input = JSON.parse(raw)
            const tools = input.tools as { name: string; input_schema: unknown }[] | undefined
            const primary = Boolean(tools?.some((tool) => tool.name === 'read'))
            requests.push({ path: request.url!, primary, phase })
            expect(request.url?.split('?')[0]).toBe('/proxy/v1/messages')
            expect(request.headers['x-api-key']).toBe(key)
            expect(request.headers.authorization).toBeUndefined()
            expect(request.headers['anthropic-version']).toBe('2023-06-01')
            expect(request.headers['x-literal']).toBe('anthropic-route')
            expect(request.headers['x-private']).toBe(headerKey)
            expect(input.model).toBe('fixture-anthropic-model')
            if (primary) {
              bodies.push(raw)
              expect(JSON.stringify(input.system)).toContain('ROLE_MARKER')
              expect(JSON.stringify(input.system)).toContain('APPEND_MARKER')
              expect(input.stream).toBe(true)
            }
            if (primary && (phase === 'error' || phase === 'auth-error')) {
              response
                .writeHead(phase === 'error' ? 400 : 401, { 'Content-Type': 'application/json' })
                .end(
                  JSON.stringify({
                    type: 'error',
                    error: {
                      type: phase === 'error' ? 'invalid_request_error' : 'authentication_error',
                      message: `Fixture rejection ${key}`,
                    },
                  }),
                )
              return
            }
            const message = {
              id: `msg_${requests.length}`,
              type: 'message',
              role: 'assistant',
              model: input.model,
              content: [],
              stop_reason: null,
              stop_sequence: null,
              usage: { input_tokens: 10, output_tokens: 1 },
            }
            if (!input.stream) {
              response.writeHead(200, { 'Content-Type': 'application/json' }).end(
                JSON.stringify({
                  ...message,
                  content: [{ type: 'text', text: 'Fixture title' }],
                  stop_reason: 'end_turn',
                }),
              )
              return
            }
            response.writeHead(200, { 'Content-Type': 'text/event-stream' })
            const event = (type: string, data: object = {}) =>
              response.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`)
            event('message_start', { message })
            event('ping')
            const tool = primary && phase === 'tools' && step++ === 0
            if (tool) {
              event('content_block_start', {
                index: 0,
                content_block: { type: 'tool_use', id: 'tool_fixture', name: 'read', input: {} },
              })
              const args = JSON.stringify({
                [engine === 'opencode' ? 'filePath' : engine === 'pi' ? 'path' : 'file_path']: join(
                  cwd,
                  'fixture.txt',
                ),
              })
              const split = Math.floor(args.length / 2)
              for (const partial_json of [args.slice(0, split), args.slice(split)])
                event('content_block_delta', {
                  index: 0,
                  delta: { type: 'input_json_delta', partial_json },
                })
            } else {
              event('content_block_start', { index: 0, content_block: { type: 'text', text: '' } })
              const text = primary
                ? `ANTHROPIC_${phase}_REPLY ${key} ${headerKey} 中文🙂`
                : 'Fixture title'
              for (const value of [text.slice(0, 28), text.slice(28)])
                event('content_block_delta', {
                  index: 0,
                  delta: { type: 'text_delta', text: value },
                })
            }
            if (primary && phase === 'stream') {
              streaming = true
              return
            }
            event('content_block_stop', { index: 0 })
            event('message_delta', {
              delta: { stop_reason: tool ? 'tool_use' : 'end_turn', stop_sequence: null },
              usage: { output_tokens: 5 },
            })
            event('message_stop')
            response.end()
          } catch (error) {
            errors.push(error)
            if (!response.headersSent)
              response.writeHead(400, { 'Content-Type': 'application/json' })
            response.end(
              JSON.stringify({
                type: 'error',
                error: { type: 'invalid_request_error', message: 'Fixture rejected request' },
              }),
            )
          }
        })
        let factory: DesktopSessionFactory | undefined
        try {
          for (const path of [join(cwd, '.git'), home]) await mkdir(path, { recursive: true })
          await writeFile(join(cwd, 'fixture.txt'), 'ANTHROPIC_FILE_MARKER')
          await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
          const address = server.address()
          if (!address || typeof address === 'string') throw new Error('Missing address')
          const state = (
            engine === 'opencode' ? openCodeWorkspace : engine === 'pi' ? piWorkspace : dshWorkspace
          )(executable, cwd)
          const installation = state.installations[0]!
          state.connections[0]!.protocol = 'anthropic-messages'
          state.connections[0]!.baseUrl = `http://127.0.0.1:${address.port}/proxy${endpointStyle === 'versioned' ? '/v1/' : ''}`
          state.connections[0]!.auth = {
            kind: 'api-key',
            header: 'x-api-key',
            secret: { kind: 'environment', name: 'PROVIDER_KEY' },
          }
          state.connections[0]!.headers = { 'X-Literal': 'anthropic-route' }
          state.connections[0]!.secretHeaders = {
            'X-Private': { kind: 'environment', name: 'HEADER_KEY' },
          }
          state.models[0]!.modelId = 'fixture-anthropic-model'
          state.agents[0]!.execution.approval = 'unrestricted'
          state.agents[0]!.skillBindings = []
          state.skills = []
          const skills = new SkillDirectoryStore(join(root, 'skills'))
          const runs = new RunInputStore(join(root, 'runs'), skills)
          factory = new DesktopSessionFactory({
            workspace: {
              load: async () => structuredClone(state),
              save: async () => structuredClone(state),
            },
            runs,
            skills,
            dataDirectory: root,
            environment: {
              ...process.env,
              HOME: home,
              XDG_CONFIG_HOME: join(home, '.config'),
              ANTHROPIC_API_KEY: 'ambient-key-must-not-be-inherited',
            },
            resolveSecret: async (reference) => {
              if (reference.kind !== 'environment') throw new Error('Unexpected reference')
              return reference.name === 'PROVIDER_KEY' ? key : headerKey
            },
          })
          await factory.probe({ installationId: installation.id })
          const identity = await factory.create('fixture-session', {
            kind: 'create',
            commandId: 'create',
            agentId: 'reviewer',
          })
          const manifestBefore = await readFile(
            join(runs.paths(identity.snapshotId).root, 'manifest.json'),
            'utf8',
          )
          let snapshot = createSessionSnapshot({
            ...identity,
            id: 'fixture-session',
            createdAt: new Date().toISOString(),
          })
          const connect = async () => {
            const runtime = await factory!.connect(snapshot, new AbortController().signal)
            runtimes.push(runtime)
            return runtime
          }
          let runtime = await connect()
          const handlers = {
            output: async (event: RuntimeOutput) => {
              outputs.push(event)
            },
            interaction: async () => ({ kind: 'cancelled' as const }),
          }
          const completed = await runtime.send('Read fixture.txt and retain the context.', handlers)
          expect(errors).toEqual([])
          expect(completed.outcome).toBe('completed')
          expect(
            outputs.some(
              (event) =>
                event.kind === 'tool.updated' &&
                event.status === 'completed' &&
                event.content?.includes('ANTHROPIC_FILE_MARKER'),
            ),
          ).toBe(true)
          expect(
            bodies.some(
              (body) => body.includes('ANTHROPIC_FILE_MARKER') && body.includes('tool_result'),
            ),
          ).toBe(true)
          expect(
            outputs
              .filter((event) => event.kind === 'message.delta')
              .map((event) => event.text)
              .join(''),
          ).toContain('ANTHROPIC_tools_REPLY [redacted] [redacted] 中文🙂')
          phase = 'stream'
          const pending = runtime.send('Stream until cancellation.', handlers)
          await vi.waitFor(
            () => {
              expect(errors).toEqual([])
              expect(streaming).toBe(true)
            },
            { timeout: 15_000 },
          )
          await runtime.cancel()
          expect((await pending).outcome).toBe('cancelled')
          const nativeId = runtime.nativeSessionId
          await runtime.dispose()
          snapshot = { ...snapshot, status: 'resuming', nativeSessionId: nativeId }
          phase = 'resume'
          runtime = await connect()
          expect(runtime.nativeSessionId).toBe(nativeId)
          expect(
            (await runtime.send('Continue from the retained file result.', handlers)).outcome,
          ).toBe('completed')
          expect(bodies.at(-1)).toContain('ANTHROPIC_FILE_MARKER')
          for (const failedPhase of ['error', 'auth-error'] as const) {
            phase = failedPhase
            const before = requests.filter((request) => request.primary).length
            const failed = await runtime.send('The provider must reject this turn.', handlers).then(
              (result) => result.outcome,
              (error) => {
                expect(error).toMatchObject({ code: 'engine' })
                return 'failed'
              },
            )
            expect(failed).toBe('failed')
            expect(requests.filter((request) => request.primary).length).toBeGreaterThan(before)
          }
          expect(errors).toEqual([])
          for (const value of [key, headerKey]) expect(JSON.stringify(outputs)).not.toContain(value)
          expect(
            await readFile(join(runs.paths(identity.snapshotId).root, 'manifest.json'), 'utf8'),
          ).toBe(manifestBefore)
          if (process.env.AGENT_MATRIX_PROVIDER_REPORT)
            await writeFile(
              `${process.env.AGENT_MATRIX_PROVIDER_REPORT}.${engine}.${endpointStyle}.json`,
              JSON.stringify(
                {
                  checkedAt: new Date().toISOString(),
                  platform: process.platform,
                  architecture: process.arch,
                  engine,
                  endpointStyle,
                  version: installation.version,
                  protocol: 'anthropic-messages',
                  model: state.models[0]!.modelId,
                  externalProviderCalls: false,
                  requestPath: '/proxy/v1/messages',
                  requests: requests.length,
                  primaryRequests: requests.filter((request) => request.primary).length,
                  apiKeyAndHeaderIsolation: true,
                  replacementAndAppendedPrompts: true,
                  fragmentedToolInputAndNativeResult: true,
                  nativeCancellation: true,
                  nativeResumeWithContext: true,
                  providerFailure: true,
                  authenticationFailure: true,
                  outputSecretsRedacted: true,
                  immutableManifest: true,
                },
                null,
                2,
              ) + '\n',
            )
        } finally {
          await factory?.shutdown()
          await closeNativeFixture(
            runtimes.map((runtime) => ({ close: () => runtime.dispose() })),
            server,
            root,
          )
        }
      },
    )
  }
}
