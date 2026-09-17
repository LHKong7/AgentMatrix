import { createServer } from 'node:http'
import { mkdir, mkdtemp, readFile, realpath, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { isAbsolute, join } from 'node:path'
import { expect, it, vi } from 'vitest'
import { RunInputStore } from '../src/main/engines/run-input-store'
import { SkillDirectoryStore } from '../src/main/assets/skill-directory-store'
import { DesktopSessionFactory } from '../src/main/sessions/desktop-factory'
import { SessionCoordinator } from '../src/main/sessions/coordinator'
import { SessionJournal } from '../src/main/sessions/journal'
import type { RuntimeSession } from '../src/main/engines/runtime'
import { dshWorkspace } from './helpers/dsh-fixture'
import { closeNativeFixture } from './helpers/close-native-fixture'

const executable = process.env.AGENT_MATRIX_TEST_DSH
for (const route of ['pi-ai', 'deepseek-native'] as const) {
  it.runIf(Boolean(executable))(
    `runs DSH ${route} through the desktop factory and durable coordinator`,
    async () => {
      if (!executable || !isAbsolute(executable))
        throw new Error('An absolute DSH executable is required')
      const root = await realpath(await mkdtemp(join(tmpdir(), 'agentmatrix-dsh-runtime-')))
      const cwd = join(root, 'project'),
        home = join(root, 'home')
      await mkdir(join(cwd, '.git'), { recursive: true })
      await mkdir(home)
      await writeFile(join(cwd, 'fixture.txt'), 'DSH_RUNTIME_FILE_MARKER')
      const key = 'synthetic-dsh-runtime-key'
      let phase = 'tools',
        step = 0,
        requests = 0,
        streamStarted = false,
        serverError: unknown = null
      const bodies: string[] = []
      const server = createServer(async (request, response) => {
        try {
          let body = ''
          for await (const part of request) {
            body += String(part)
            if (body.length > 4_194_304) throw new Error('Request limit')
          }
          bodies.push(body)
          requests++
          const input = JSON.parse(body)
          if (
            request.url !== '/v1/chat/completions' ||
            request.headers.authorization !== `Bearer ${key}` ||
            input.model !== 'fixture-model' ||
            !input.stream
          )
            throw new Error('Unexpected provider request')
          if (phase === 'error') {
            response.writeHead(400, { 'Content-Type': 'application/json' })
            response.end(
              JSON.stringify({
                error: { message: 'Fixture rejection', type: 'invalid_request_error' },
              }),
            )
            return
          }
          response.writeHead(200, { 'Content-Type': 'text/event-stream' })
          const chunk = (delta: object, finish_reason: string | null = null) =>
            response.write(
              `data: ${JSON.stringify({ id: `dsh-runtime-${requests}`, object: 'chat.completion.chunk', created: 1, model: input.model, choices: [{ index: 0, delta, finish_reason }] })}\n\n`,
            )
          chunk({ role: 'assistant' })
          if (phase === 'stream') {
            chunk({ content: 'UNCOMMITTED_DSH_TEXT' + '.'.repeat(100) })
            streamStarted = true
            return
          }
          if (phase === 'permission' || (phase === 'tools' && step++ === 0)) {
            chunk({
              tool_calls: [
                {
                  index: 0,
                  id: `read-${requests}`,
                  type: 'function',
                  function: {
                    name: 'read',
                    arguments: JSON.stringify({ file_path: join(cwd, 'fixture.txt') }),
                  },
                },
              ],
            })
            chunk({}, 'tool_calls')
          } else {
            chunk({
              content:
                (phase === 'resume' ? 'DSH_RESTORED_MARKER ' : 'DSH_NORMALIZED_MARKER ') +
                key.slice(0, 10),
            })
            chunk({ content: key.slice(10) + ' 中文🙂\u2028\u2029' })
            chunk({}, 'stop')
          }
          response.write(
            `data: ${JSON.stringify({ id: 'dsh-runtime', object: 'chat.completion.chunk', created: 1, model: input.model, choices: [], usage: { prompt_tokens: 12, completion_tokens: 5, total_tokens: 17 } })}\n\n`,
          )
          response.end('data: [DONE]\n\n')
        } catch (error) {
          serverError = error
          response.writeHead(500)
          response.end()
        }
      })
      const runtimes: RuntimeSession[] = [],
        coordinators: SessionCoordinator[] = [],
        factories: DesktopSessionFactory[] = []
      const skills = new SkillDirectoryStore(join(root, 'skills'))
      const runs = new RunInputStore(join(root, 'runs'), skills)
      const journalDirectory = join(root, 'journal')
      try {
        await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
        const address = server.address()
        if (!address || typeof address === 'string') throw new Error('Missing fixture address')
        let state = dshWorkspace(executable, cwd)
        state.installations[0]!.version = null
        state.installations[0]!.probedAt = null
        state.installations[0]!.modes = []
        state.agents[0]!.execution.approval = 'ask'
        state.connections[0]!.baseUrl = `http://127.0.0.1:${address.port}/v1`
        if (route === 'deepseek-native') {
          state.connections[0]!.protocol = 'deepseek-official'
          state.connections[0]!.headers = {}
        }
        const workspace = {
          load: async () => structuredClone(state),
          save: async (value: typeof state) => {
            state = structuredClone(value)
            return structuredClone(state)
          },
        }
        const createCoordinator = async () => {
          const factory = new DesktopSessionFactory({
            workspace,
            runs,
            skills,
            dataDirectory: root,
            environment: { ...process.env, HOME: home },
            resolveSecret: async () => key,
          })
          factories.push(factory)
          const coordinator = new SessionCoordinator(new SessionJournal(journalDirectory), {
            create: (id, command) => factory.create(id, command),
            configuration: (snapshot) => factory.configuration(snapshot),
            connect: async (snapshot, signal) => {
              const runtime = await factory.connect(snapshot, signal)
              runtimes.push(runtime)
              return runtime
            },
          })
          coordinators.push(coordinator)
          await factory.probe({ installationId: 'dsh' })
          return coordinator
        }
        let coordinator = await createCoordinator()
        const created = await coordinator.command({
          kind: 'create',
          commandId: 'create',
          agentId: 'reviewer',
        })
        await coordinator.command({ kind: 'start', commandId: 'start', sessionId: created.id })
        const wait = async (status: string) => {
          await vi.waitFor(
            async () =>
              expect((await coordinator.get({ sessionId: created.id })).status).toBe(status),
            { timeout: 25_000 },
          )
          return coordinator.get({ sessionId: created.id })
        }
        const ready = await wait('ready')
        const report = await coordinator.configuration({ sessionId: created.id })
        expect(report.observation?.runId).toBe(ready.runId)
        expect(report.fields.find((field) => field.id === 'model')?.status).toBe('observed')
        expect(report.fields.find((field) => field.id === 'authentication')?.status).toBe(
          'composition',
        )
        expect(report.fields.find((field) => field.id === 'reasoning')?.status).toBe(
          route === 'deepseek-native' ? 'observed' : 'unknown',
        )
        const send = async (commandId: string) => {
          const snapshot = await coordinator.get({ sessionId: created.id })
          const command = {
            kind: 'send' as const,
            commandId,
            sessionId: created.id,
            runId: snapshot.runId!,
            messageId: `message-${commandId}`,
            text: 'Read fixture.txt and retain its context.',
          }
          await coordinator.command(command)
          return command
        }
        const history = async () =>
          (await coordinator.readEvents({ sessionId: created.id, afterCursor: 0, limit: 500 }))
            .events
        const permission = async () => {
          await vi.waitFor(
            async () =>
              expect(
                (await coordinator.get({ sessionId: created.id })).pendingRequests.length,
              ).toBe(1),
            { timeout: 15_000 },
          )
          return coordinator.get({ sessionId: created.id })
        }
        const command = await send('tools')
        const pending = await permission()
        const request = pending.pendingRequests[0]!
        if (request.kind !== 'permission') throw new Error('Expected permission')
        await coordinator.command({
          kind: 'respond',
          commandId: 'allow',
          sessionId: created.id,
          runId: pending.runId!,
          turnId: pending.activeTurn!.id,
          requestId: request.id,
          response: {
            kind: 'choice',
            optionId: request.options.find((option) => option.kind === 'allow_once')!.id,
          },
        })
        expect((await wait('ready')).lastTurn?.outcome).toBe('completed')
        expect(
          (await history()).reverse().find((event) => event.data.kind === 'turn.finished')?.data,
        ).toMatchObject({ usage: null })
        expect(
          (await history()).some(
            (event) =>
              event.data.kind === 'tool.updated' &&
              event.data.status === 'completed' &&
              event.data.content?.includes('DSH_RUNTIME_FILE_MARKER'),
          ),
        ).toBe(true)
        expect(
          (await history())
            .filter((event) => event.data.kind === 'message.delta')
            .map((event) => (event.data.kind === 'message.delta' ? event.data.text : ''))
            .join(''),
        ).toContain('DSH_NORMALIZED_MARKER [redacted] 中文🙂\u2028\u2029')
        const count = requests
        await coordinator.command(command)
        expect(requests).toBe(count)
        phase = 'stream'
        await send('stream')
        await vi.waitFor(() => expect(streamStarted).toBe(true), { timeout: 15_000 })
        expect(JSON.stringify(await history())).not.toContain('UNCOMMITTED_DSH_TEXT')
        const cancel = async (commandId: string) => {
          const snapshot = await coordinator.get({ sessionId: created.id })
          await coordinator.command({
            kind: 'cancel',
            commandId,
            sessionId: created.id,
            runId: snapshot.runId!,
            turnId: snapshot.activeTurn!.id,
          })
          expect((await wait('ready')).lastTurn?.outcome).toBe('cancelled')
        }
        await cancel('cancel-stream')
        phase = 'permission'
        await send('permission')
        await permission()
        await cancel('cancel-permission')
        expect((await coordinator.get({ sessionId: created.id })).pendingRequests).toEqual([])
        await coordinator.shutdown()
        coordinator = await createCoordinator()
        const interrupted = await coordinator.get({ sessionId: created.id })
        expect(interrupted.status).toBe('interrupted')
        const previousEvents = (await history()).filter(
          (event) => event.data.kind === 'message.delta',
        ).length
        await coordinator.command({
          kind: 'resume',
          commandId: 'resume',
          sessionId: created.id,
          previousRunId: interrupted.runId!,
        })
        expect((await wait('ready')).nativeSessionId).toBe(ready.nativeSessionId)
        expect(
          (await history()).filter((event) => event.data.kind === 'message.delta').length,
        ).toBe(previousEvents)
        phase = 'resume'
        await send('restored')
        expect((await wait('ready')).lastTurn?.outcome).toBe('completed')
        expect(bodies.at(-1)).toContain('DSH_RUNTIME_FILE_MARKER')
        phase = 'error'
        await send('provider-error')
        expect((await wait('failed')).failure?.code).toBe('engine')
        expect(await readFile(join(journalDirectory, `${created.id}.jsonl`), 'utf8')).not.toContain(
          key,
        )
        expect(serverError).toBeNull()
        await coordinator.shutdown()
        await runs.verifyForReuse(created.snapshotId)
        if (process.env.AGENT_MATRIX_DSH_RUNTIME_REPORT)
          await writeFile(
            `${process.env.AGENT_MATRIX_DSH_RUNTIME_REPORT}.${route}.json`,
            JSON.stringify(
              {
                checkedAt: new Date().toISOString(),
                platform: process.platform,
                architecture: process.arch,
                engineVersion: '0.1.5-rc.2',
                acpAgentVersion: '0.0.1',
                route,
                externalProviderCalls: false,
                desktopFactory: true,
                versionAndModelReadback: true,
                committedMessagesAndTools: true,
                splitCredentialRedaction: true,
                commandReplayWithoutResubmit: true,
                permissionReply: true,
                providerStreamCancellation: true,
                permissionCancellation: true,
                nativeResumeWithToolContext: true,
                resumeWithoutTranscriptReplay: true,
                providerFailureRejected: true,
                usageAndCostUnknown: true,
                providerCalls: requests,
              },
              null,
              2,
            ) + '\n',
          )
      } finally {
        await Promise.allSettled(coordinators.map((coordinator) => coordinator.shutdown()))
        await Promise.allSettled(factories.map((factory) => factory.shutdown()))
        await closeNativeFixture(
          runtimes.map((runtime) => ({ close: () => runtime.dispose() })),
          server,
          root,
        )
      }
    },
  )
}
