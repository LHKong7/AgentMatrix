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
  const executable = process.env[`AGENT_MATRIX_TEST_${engine.toUpperCase()}`]
  it.runIf(Boolean(executable))(
    `verifies the OpenAI Responses route through ${engine} with a versioned endpoint`,
    async () => {
      if (!executable || !isAbsolute(executable)) throw new Error('Absolute executable required')
      const root = await realpath(await mkdtemp(join(tmpdir(), `agentmatrix-responses-${engine}-`)))
      const cwd = join(root, 'project'),
        home = join(root, 'home')
      const runtimes: RuntimeSession[] = []
      const errors: unknown[] = [],
        outputs: RuntimeOutput[] = []
      const requests: { path: string; primary: boolean; phase: string }[] = []
      const bodies: string[] = []
      const key = 'synthetic-responses-key',
        headerKey = 'synthetic-responses-header'
      let phase: 'tools' | 'stream' | 'resume' | 'error' | 'auth-error' | 'unsupported-route' =
          'tools',
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
          const tools = input.tools as { name: string; type: string }[] | undefined
          const primary = Boolean(tools?.some((tool) => tool.name === 'read'))
          requests.push({ path: request.url!, primary, phase })
          expect(request.url?.split('?')[0]).toBe('/proxy/v1/responses')
          expect(request.headers.authorization).toBe(`Bearer ${key}`)
          expect(request.headers['x-api-key']).toBeUndefined()
          expect(request.headers['x-literal']).toBe('responses-route')
          expect(request.headers['x-private']).toBe(headerKey)
          expect(input.model).toBe('fixture-responses-model')
          if (primary) {
            bodies.push(raw)
            expect(
              JSON.stringify({ instructions: input.instructions, input: input.input }),
            ).toContain('ROLE_MARKER')
            expect(
              JSON.stringify({ instructions: input.instructions, input: input.input }),
            ).toContain('APPEND_MARKER')
            expect(input.stream).toBe(true)
          }
          if (primary && ['error', 'auth-error', 'unsupported-route'].includes(phase)) {
            response
              .writeHead(phase === 'auth-error' ? 401 : phase === 'unsupported-route' ? 404 : 400, {
                'Content-Type': 'application/json',
              })
              .end(
                JSON.stringify({
                  error: {
                    type: phase === 'auth-error' ? 'authentication_error' : 'invalid_request_error',
                    message:
                      phase === 'unsupported-route'
                        ? `This gateway supports only /chat/completions. ${key}`
                        : `Fixture rejection ${key}`,
                    code: phase === 'unsupported-route' ? 'unsupported_endpoint' : null,
                    param: null,
                  },
                }),
              )
            return
          }
          const base = {
            id: `resp_${requests.length}`,
            object: 'response',
            created_at: Math.floor(Date.now() / 1000),
            status: 'in_progress',
            model: input.model,
            error: null,
            incomplete_details: null,
            output: [],
            usage: {
              input_tokens: 10,
              input_tokens_details: { cached_tokens: 0 },
              output_tokens: 5,
              output_tokens_details: { reasoning_tokens: 0 },
              total_tokens: 15,
            },
          }
          const reply = primary
            ? `RESPONSES_${phase}_REPLY ${key} ${headerKey} 中文🙂`
            : 'Fixture title'
          const part = { type: 'output_text', text: reply, annotations: [], logprobs: [] }
          const message = {
            type: 'message',
            id: `msg_${requests.length}`,
            role: 'assistant',
            status: 'completed',
            content: [part],
          }
          if (!input.stream) {
            response
              .writeHead(200, { 'Content-Type': 'application/json' })
              .end(JSON.stringify({ ...base, status: 'completed', output: [message] }))
            return
          }
          response.writeHead(200, { 'Content-Type': 'text/event-stream' })
          let sequence = 0
          const event = (type: string, data: object = {}) =>
            response.write(
              `event: ${type}\ndata: ${JSON.stringify({ type, sequence_number: sequence++, ...data })}\n\n`,
            )
          event('response.created', { response: base })
          event('response.in_progress', { response: base })
          const tool = primary && phase === 'tools' && step++ === 0
          let item: object
          if (tool) {
            const call = {
              type: 'function_call',
              id: 'fc_fixture',
              call_id: 'call_fixture',
              name: 'read',
              arguments: '',
              status: 'in_progress',
            }
            event('response.output_item.added', {
              response_id: base.id,
              output_index: 0,
              item: call,
            })
            const args = JSON.stringify({
              [engine === 'opencode' ? 'filePath' : engine === 'pi' ? 'path' : 'file_path']: join(
                cwd,
                'fixture.txt',
              ),
            })
            const split = Math.floor(args.length / 2)
            const identity = { response_id: base.id, item_id: call.id, output_index: 0 }
            for (const delta of [args.slice(0, split), args.slice(split)])
              event('response.function_call_arguments.delta', { ...identity, delta })
            event('response.function_call_arguments.done', {
              ...identity,
              name: call.name,
              arguments: args,
            })
            item = { ...call, arguments: args, status: 'completed' }
          } else {
            event('response.output_item.added', {
              response_id: base.id,
              output_index: 0,
              item: { ...message, status: 'in_progress', content: [] },
            })
            const identity = {
              response_id: base.id,
              item_id: message.id,
              output_index: 0,
              content_index: 0,
            }
            event('response.content_part.added', { ...identity, part: { ...part, text: '' } })
            const split = reply.indexOf(key) + 7
            for (const delta of [reply.slice(0, split), reply.slice(split)])
              event('response.output_text.delta', { ...identity, delta, logprobs: [] })
            if (primary && phase === 'stream') {
              streaming = true
              return
            }
            event('response.output_text.done', { ...identity, text: reply, logprobs: [] })
            event('response.content_part.done', { ...identity, part })
            item = message
          }
          event('response.output_item.done', { response_id: base.id, output_index: 0, item })
          event('response.completed', {
            response: { ...base, status: 'completed', output: [item] },
          })
          response.end()
        } catch (error) {
          errors.push(error)
          if (!response.headersSent) response.writeHead(400, { 'Content-Type': 'application/json' })
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
        await writeFile(join(cwd, 'fixture.txt'), 'RESPONSES_FILE_MARKER')
        await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
        const address = server.address()
        if (!address || typeof address === 'string') throw new Error('Missing address')
        let state = (
          engine === 'opencode' ? openCodeWorkspace : engine === 'pi' ? piWorkspace : dshWorkspace
        )(executable, cwd)
        const installation = state.installations[0]!
        state.connections[0]!.protocol = 'openai-responses'
        state.connections[0]!.baseUrl = `http://127.0.0.1:${address.port}/proxy/v1/`
        state.connections[0]!.auth = {
          kind: 'bearer',
          secret: { kind: 'environment', name: 'PROVIDER_KEY' },
        }
        state.connections[0]!.headers = { 'X-Literal': 'responses-route' }
        state.connections[0]!.secretHeaders = {
          'X-Private': { kind: 'environment', name: 'HEADER_KEY' },
        }
        state.models[0]!.modelId = 'fixture-responses-model'
        state.agents[0]!.execution.approval = 'unrestricted'
        state.agents[0]!.skillBindings = []
        state.skills = []
        const skills = new SkillDirectoryStore(join(root, 'skills'))
        const runs = new RunInputStore(join(root, 'runs'), skills)
        factory = new DesktopSessionFactory({
          workspace: {
            load: async () => structuredClone(state),
            save: async (value) => {
              state = structuredClone(value)
              return structuredClone(state)
            },
          },
          runs,
          skills,
          dataDirectory: root,
          environment: {
            ...process.env,
            HOME: home,
            XDG_CONFIG_HOME: join(home, '.config'),
            OPENAI_API_KEY: 'ambient-key-must-not-be-inherited',
          },
          resolveSecret: async (reference) => {
            if (reference.kind !== 'environment') throw new Error('Unexpected reference')
            return reference.name === 'PROVIDER_KEY' ? key : headerKey
          },
        })
        await factory.probe({ installationId: installation.id })
        expect(state.installations[0]!.version).toBe(installation.version)
        expect(state.installations[0]!.modes.length).toBeGreaterThan(0)
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
              event.content?.includes('RESPONSES_FILE_MARKER'),
          ),
        ).toBe(true)
        expect(
          bodies.some((body) =>
            (JSON.parse(body).input as Record<string, unknown>[]).some(
              (item) =>
                item.type === 'function_call_output' &&
                item.call_id === 'call_fixture' &&
                JSON.stringify(item.output).includes('RESPONSES_FILE_MARKER'),
            ),
          ),
        ).toBe(true)
        expect(
          outputs
            .filter((event) => event.kind === 'message.delta')
            .map((event) => event.text)
            .join(''),
        ).toContain('RESPONSES_tools_REPLY [redacted] [redacted] 中文🙂')
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
        expect(bodies.at(-1)).toContain('RESPONSES_FILE_MARKER')
        for (const failedPhase of ['error', 'auth-error', 'unsupported-route'] as const) {
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
            `${process.env.AGENT_MATRIX_PROVIDER_REPORT}.responses.${engine}.json`,
            JSON.stringify(
              {
                checkedAt: new Date().toISOString(),
                platform: process.platform,
                architecture: process.arch,
                engine,
                endpointStyle: 'versioned',
                version: state.installations[0]!.version,
                protocol: 'openai-responses',
                model: state.models[0]!.modelId,
                externalProviderCalls: false,
                requestPath: '/proxy/v1/responses',
                requests: requests.length,
                primaryRequests: requests.filter((request) => request.primary).length,
                apiKeyAndHeaderIsolation: true,
                replacementAndAppendedPrompts: true,
                fragmentedToolInputAndNativeResult: true,
                nativeCancellation: true,
                nativeResumeWithContext: true,
                providerFailure: true,
                authenticationFailure: true,
                chatCompletionsOnlyGatewayRejected: true,
                noProtocolFallback: true,
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
