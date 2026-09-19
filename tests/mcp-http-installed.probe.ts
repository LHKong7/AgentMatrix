import { createServer } from 'node:http'
import { mkdir, mkdtemp, readFile, realpath, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { isAbsolute, join } from 'node:path'
import { expect, it, vi } from 'vitest'
import { SkillDirectoryStore } from '../src/main/assets/skill-directory-store'
import { RunInputStore } from '../src/main/engines/run-input-store'
import { planOpenCode } from '../src/main/engines/adapters/opencode/configuration'
import { connectOpenCode } from '../src/main/engines/adapters/opencode/runtime'
import * as instanceObserver from '../src/main/engines/adapters/opencode/instance-config'
import { inspectDshComposition } from '../src/main/engines/adapters/dsh/composition'
import { planDsh } from '../src/main/engines/adapters/dsh/configuration'
import { connectDsh } from '../src/main/engines/adapters/dsh/runtime'
import type { RuntimeOutput, RuntimeSession } from '../src/main/engines/runtime'
import { RuntimeFailure } from '../src/main/engines/runtime'
import { openCodeWorkspace } from './helpers/opencode-fixture'
import { dshWorkspace } from './helpers/dsh-fixture'
import { closeNativeFixture } from './helpers/close-native-fixture'
import {
  httpMcpFixture,
  httpMcpKinds,
  httpMcpLiteral,
  httpMcpSecrets,
} from './helpers/http-mcp-fixture'

for (const route of ['opencode', 'dsh-pi-ai', 'dsh-deepseek-native'] as const) {
  const isOpenCode = route === 'opencode'
  const executable = isOpenCode
    ? process.env.AGENT_MATRIX_TEST_OPENCODE
    : process.env.AGENT_MATRIX_TEST_DSH
  it.runIf(Boolean(executable))(
    `verifies HTTP MCP authentication, tools, errors and restoration through ${route}`,
    async () => {
      if (!executable || !isAbsolute(executable)) throw new Error('Absolute executable required')
      const root = await realpath(await mkdtemp(join(tmpdir(), `agentmatrix-http-${route}-`)))
      const cwd = join(root, 'project'),
        home = join(root, 'home'),
        configHome = join(root, 'config')
      const runtimes: RuntimeSession[] = []
      const observations = vi.spyOn(instanceObserver, 'prepareOpenCodeConfigurationAttachment')
      const mcp = httpMcpFixture()
      const providerErrors: unknown[] = []
      const outputs: RuntimeOutput[] = []
      let phase: 'success' | 'tool-error' | 'rpc-error' | 'unavailable' = 'success'
      let step = 0,
        providerCalls = 0
      const modelBodies: string[] = []
      const server = createServer(async (request, response) => {
        if (request.url?.startsWith('/mcp/')) return mcp.handler(request, response)
        try {
          let body = ''
          for await (const part of request) {
            body += String(part)
            if (body.length > 4_194_304) throw new Error('Provider fixture request limit')
          }
          const input = JSON.parse(body)
          expect(request.url).toBe('/v1/chat/completions')
          expect(request.headers.authorization).toBe(`Bearer ${httpMcpSecrets.provider}`)
          for (const value of [httpMcpSecrets.bearer, httpMcpSecrets.header])
            expect(JSON.stringify(request.headers)).not.toContain(value)
          providerCalls++
          if (!input.stream) {
            response.writeHead(200, { 'Content-Type': 'application/json' }).end(
              JSON.stringify({
                id: 'fixture',
                object: 'chat.completion',
                created: 1,
                model: input.model,
                choices: [
                  {
                    index: 0,
                    message: { role: 'assistant', content: 'HTTP MCP fixture' },
                    finish_reason: 'stop',
                  },
                ],
              }),
            )
            return
          }
          const tools = (input.tools ?? []) as { function: { name: string } }[]
          const main = tools.some((tool) => tool.function.name === 'read')
          if (main) modelBodies.push(body)
          const names = tools.filter((tool) =>
            /http_(bearer|headers|none)$/.test(tool.function.name),
          )
          if (main) {
            if (phase === 'unavailable') expect(names).toHaveLength(0)
            else expect(names).toHaveLength(3)
          }
          const count = phase === 'success' ? 3 : phase === 'unavailable' ? 0 : 1
          const current = main ? step++ : count
          response.writeHead(200, { 'Content-Type': 'text/event-stream' })
          const chunk = (delta: object, finish_reason: string | null = null) =>
            response.write(
              `data: ${JSON.stringify({ id: `http-${providerCalls}`, object: 'chat.completion.chunk', created: 1, model: input.model, choices: [{ index: 0, delta, finish_reason }] })}\n\n`,
            )
          if (current < count) {
            const kind = phase === 'success' ? httpMcpKinds[current]! : 'bearer'
            const name = names.find((tool) => tool.function.name.endsWith(`http_${kind}`))!.function
              .name
            chunk({
              role: 'assistant',
              tool_calls: [
                {
                  index: 0,
                  id: `http-call-${providerCalls}`,
                  type: 'function',
                  function: { name, arguments: JSON.stringify({ behavior: phase }) },
                },
              ],
            })
            chunk({}, 'tool_calls')
          } else {
            chunk({ role: 'assistant', content: 'HTTP_MCP_REPLY' })
            chunk({}, 'stop')
          }
          response.end('data: [DONE]\n\n')
        } catch (error) {
          providerErrors.push(error)
          if (!response.headersSent) response.writeHead(500)
          response.end()
        }
      })
      try {
        for (const path of [join(cwd, '.git'), home, configHome])
          await mkdir(path, { recursive: true })
        await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
        const address = server.address()
        if (!address || typeof address === 'string') throw new Error('Missing address')
        const base = `http://127.0.0.1:${address.port}`
        const workspace = isOpenCode
          ? openCodeWorkspace(executable, cwd)
          : dshWorkspace(executable, cwd)
        workspace.connections[0]!.baseUrl = `${base}/v1`
        workspace.connections[0]!.headers = {}
        workspace.connections[0]!.auth = {
          kind: 'bearer',
          secret: { kind: 'environment', name: 'HTTP_PROVIDER_KEY' },
        }
        if (route === 'dsh-deepseek-native')
          workspace.connections[0]!.protocol = 'deepseek-official'
        workspace.agents[0]!.skillBindings = []
        workspace.skills = []
        workspace.agents[0]!.execution.approval = 'unrestricted'
        workspace.mcpServers = httpMcpKinds.map((kind): (typeof workspace.mcpServers)[number] => ({
          id: kind,
          name: `HTTP ${kind}`,
          description: '',
          enabled: true,
          transport: 'streamable-http',
          url: `${base}/mcp/${kind}`,
          timeoutMs: 5000,
          headers: { 'X-Literal': httpMcpLiteral },
          secretHeaders:
            kind === 'none'
              ? {}
              : { 'X-Private': { kind: 'environment', name: 'HTTP_MCP_HEADER' } },
          auth:
            kind === 'bearer'
              ? { kind: 'bearer', secret: { kind: 'environment', name: 'HTTP_MCP_KEY' } }
              : { kind: 'none' },
        }))
        workspace.agents[0]!.mcpServerIds = [...httpMcpKinds]
        const store = new RunInputStore(
          join(root, 'runs'),
          new SkillDirectoryStore(join(root, 'skills')),
        )
        const composition = isOpenCode ? null : await inspectDshComposition(executable, cwd)
        const capture = (id: string) =>
          store.create(id, workspace, 'reviewer', async (configuration, paths) => {
            if (composition)
              return planDsh(configuration, paths, { composition, readSkillEntry: async () => '' })
            const generated = await planOpenCode(configuration, paths, {
              configHome,
              sources: { coverage: 'partial', files: [] },
              readSkillEntry: async () => '',
            })
            for (const [name, value] of Object.entries({
              OPENCODE_TEST_HOME: home,
              OPENCODE_DISABLE_MODELS_FETCH: 'true',
              OPENCODE_DISABLE_DEFAULT_PLUGINS: 'true',
              OPENCODE_DISABLE_CLAUDE_CODE: 'true',
              OPENCODE_DISABLE_EXTERNAL_SKILLS: 'true',
            }))
              generated.launch.environment[name] = { kind: 'literal', value }
            return generated
          })
        const manifest = await capture('capture')
        const connect = async (snapshotId = 'capture', previousNativeSessionId?: string) => {
          const runtime = await (isOpenCode ? connectOpenCode : connectDsh)({
            store,
            snapshotId,
            previousNativeSessionId,
            environment: { ...process.env, HOME: home },
            signal: new AbortController().signal,
            resolveSecret: async (reference) => {
              if (reference.kind !== 'environment') throw new Error('Unexpected reference')
              switch (reference.name) {
                case 'HTTP_PROVIDER_KEY':
                  return httpMcpSecrets.provider
                case 'HTTP_MCP_KEY':
                  return httpMcpSecrets.bearer
                case 'HTTP_MCP_HEADER':
                  return httpMcpSecrets.header
                default:
                  throw new Error('Unexpected secret')
              }
            },
          })
          runtimes.push(runtime)
          return runtime
        }
        const statuses = async () => {
          const attachment = await observations.mock.results.at(-1)!.value
          const url = new URL(`http://127.0.0.1:${attachment.args.at(-1)}/mcp`)
          url.searchParams.set('directory', cwd)
          const result = await fetch(url, {
            headers: { Authorization: attachment.secrets[2]! },
            signal: AbortSignal.timeout(10_000),
          })
          expect(result.status).toBe(200)
          const data = (await result.json()) as Record<string, { status: string }>
          return httpMcpKinds.map((kind) => data[`agentmatrix-${kind}`]?.status)
        }
        const send = async (runtime: RuntimeSession, behavior: typeof phase) => {
          phase = behavior
          step = 0
          expect(
            (
              await runtime.send('Exercise the HTTP MCP fixture.', {
                output: async (event) => {
                  outputs.push(event)
                },
                interaction: async () => ({ kind: 'cancelled' }),
              })
            ).outcome,
          ).toBe('completed')
          expect(providerErrors).toEqual([])
          expect(mcp.errors).toEqual([])
          expect(step).toBe(behavior === 'success' ? 4 : behavior === 'unavailable' ? 1 : 2)
        }
        let runtime = await connect()
        await send(runtime, 'success')
        for (const kind of httpMcpKinds) {
          expect(modelBodies.at(-1)).toContain(`HTTP_MCP_RESULT_${kind}`)
          for (const method of [
            'initialize',
            'notifications/initialized',
            'tools/list',
            'tools/call',
          ])
            expect(mcp.methods).toContainEqual({ kind, method })
        }
        if (isOpenCode) expect(await statuses()).toEqual(['connected', 'connected', 'connected'])
        for (const behavior of ['tool-error', 'rpc-error'] as const) {
          const start = outputs.length
          await send(runtime, behavior)
          expect(modelBodies.at(-1)).toContain(
            behavior === 'tool-error' ? 'HTTP_MCP_TOOL_ERROR' : 'HTTP_MCP_RPC_ERROR',
          )
          expect(
            outputs
              .slice(start)
              .some((event) => event.kind === 'tool.updated' && event.status === 'failed'),
          ).toBe(true)
        }
        for (const secret of Object.values(httpMcpSecrets))
          expect(JSON.stringify(outputs)).not.toContain(secret)
        const captured = [
          JSON.stringify(manifest),
          ...(await Promise.all(
            manifest.files.map((file) =>
              readFile(join(store.paths('capture').inputs, file.path), 'utf8'),
            ),
          )),
        ].join('\n')
        for (const secret of Object.values(httpMcpSecrets)) expect(captured).not.toContain(secret)
        const nativeId = runtime.nativeSessionId
        await runtime.dispose()
        runtime = await connect('capture', nativeId)
        expect(runtime.nativeSessionId).toBe(nativeId)
        await send(runtime, 'success')
        await runtime.dispose()
        const failureResults: Record<string, string> = {}
        for (const failure of ['unauthorized', 'list-error'] as const) {
          mcp.fail(failure)
          await capture(failure)
          const before = providerCalls
          const requestStart = mcp.requests.length
          const methodStart = mcp.methods.length
          const callStart = mcp.calls.length
          if (isOpenCode) {
            runtime = await connect(failure)
            const observed = await statuses()
            expect(observed).toEqual(['failed', 'failed', 'failed'])
            expect(providerCalls).toBe(before)
            await send(runtime, 'unavailable')
            failureResults[failure] = observed[0]!
            await runtime.dispose()
          } else {
            await expect(connect(failure)).rejects.toBeInstanceOf(RuntimeFailure)
            expect(providerCalls).toBe(before)
            failureResults[failure] = 'startup-rejected'
          }
          for (const kind of httpMcpKinds) {
            expect(mcp.requests.slice(requestStart)).toContainEqual({
              kind,
              verb: 'POST',
              rejected: failure === 'unauthorized',
            })
            if (failure === 'list-error')
              expect(mcp.methods.slice(methodStart)).toContainEqual({ kind, method: 'tools/list' })
          }
          expect(mcp.calls).toHaveLength(callStart)
        }
        mcp.fail('none')
        runtime = await connect('capture', nativeId)
        await send(runtime, 'success')
        await runtime.dispose()
        expect(mcp.errors).toEqual([])
        expect(providerErrors).toEqual([])
        expect(mcp.calls).toHaveLength(11)
        await store.verifyForReuse('capture')
        if (process.env.AGENT_MATRIX_HTTP_MCP_REPORT)
          await writeFile(
            `${process.env.AGENT_MATRIX_HTTP_MCP_REPORT}.${route}.json`,
            JSON.stringify(
              {
                checkedAt: new Date().toISOString(),
                platform: process.platform,
                architecture: process.arch,
                route,
                engineVersion: workspace.installations[0]!.version,
                mcpProtocol: '2025-06-18',
                externalProviderCalls: false,
                externalMcpCalls: false,
                authModes: ['bearer', 'secret-header', 'none'],
                ordinaryHeadersPreserved: true,
                jsonAndSseStreamableHttpResponses: true,
                sessionAndProtocolHeadersVerified: true,
                providerAndMcpAuthorizationSeparated: true,
                toolResultsReachModel: true,
                toolAndRpcErrorsReported: true,
                normalizedOutputRedactsSecrets: true,
                secretsAbsentFromCapturedInputs: true,
                nativeResume: true,
                nativeResumeAfterMcpRecovery: true,
                capturedInputsPreserved: true,
                failures: failureResults,
                toolCalls: mcp.calls.length,
                providerCalls,
                oauthFlowVerified: false,
                legacySseVerified: false,
                runtimeConnectivityReceiptImplemented: false,
              },
              null,
              2,
            ) + '\n',
          )
      } finally {
        observations.mockRestore()
        await closeNativeFixture(
          runtimes.map((runtime) => ({ close: () => runtime.dispose() })),
          server,
          root,
        )
      }
    },
    180_000,
  )
}
