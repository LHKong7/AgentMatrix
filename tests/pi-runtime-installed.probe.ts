import { createServer } from 'node:http'
import { mkdir, mkdtemp, readFile, realpath, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { isAbsolute, join } from 'node:path'
import { expect, it, vi } from 'vitest'
import { RunInputStore } from '../src/main/engines/run-input-store'
import { SkillDirectoryStore } from '../src/main/assets/skill-directory-store'
import { planPi } from '../src/main/engines/adapters/pi/configuration'
import { inspectPiSources } from '../src/main/engines/adapters/pi/sources'
import { connectPi } from '../src/main/engines/adapters/pi/runtime'
import type { RuntimeSession } from '../src/main/engines/runtime'
import { SessionCoordinator } from '../src/main/sessions/coordinator'
import { SessionJournal } from '../src/main/sessions/journal'
import { piWorkspace } from './helpers/pi-fixture'
import { closeNativeFixture } from './helpers/close-native-fixture'

const executable = process.env.AGENT_MATRIX_TEST_PI
it.runIf(Boolean(executable))(
  'coordinates real Pi turns, cancellation, provider errors, redaction and native restoration',
  async () => {
    if (!executable || !isAbsolute(executable))
      throw new Error('An absolute Pi executable is required')
    const root = await realpath(await mkdtemp(join(tmpdir(), 'agentmatrix-pi-runtime-')))
    const cwd = join(root, 'project'),
      home = join(root, 'home')
    await mkdir(cwd)
    await mkdir(home)
    await writeFile(join(cwd, 'fixture.txt'), 'PI_RUNTIME_FILE_MARKER')
    const key = 'synthetic-pi-runtime-key'
    let phase: 'tools' | 'stream' | 'resume' | 'error' = 'tools'
    let step = 0,
      requests = 0,
      serverError: unknown = null
    const bodies: string[] = []
    const server = createServer(async (request, response) => {
      try {
        let body = ''
        for await (const part of request) {
          body += String(part)
          if (body.length > 4_194_304) throw new Error('Fixture request limit')
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
            `data: ${JSON.stringify({ id: `pi-runtime-${requests}`, object: 'chat.completion.chunk', created: 1, model: input.model, choices: [{ index: 0, delta, finish_reason }] })}\n\n`,
          )
        chunk({ role: 'assistant' })
        if (phase === 'stream') {
          chunk({ content: 'PI_ACTIVE_STREAM_MARKER' + '.'.repeat(100) })
          return
        }
        if (phase === 'tools' && step++ === 0) {
          chunk({
            tool_calls: [
              {
                index: 0,
                id: 'read-fixture',
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
          chunk({
            content:
              (phase === 'resume' ? 'PI_RESTORED_MARKER ' : 'PI_NORMALIZED_MARKER ') +
              key.slice(0, 10),
          })
          chunk({ content: key.slice(10) + ' 中文🙂\u2028\u2029' })
          chunk({}, 'stop')
        }
        response.write(
          `data: ${JSON.stringify({ id: 'pi-runtime', object: 'chat.completion.chunk', created: 1, model: input.model, choices: [], usage: { prompt_tokens: 12, completion_tokens: 5, total_tokens: 17 } })}\n\n`,
        )
        response.end('data: [DONE]\n\n')
      } catch (error) {
        serverError = error
        response.writeHead(500)
        response.end()
      }
    })
    const runtimes: RuntimeSession[] = []
    const coordinators: SessionCoordinator[] = []
    const store = new RunInputStore(
      join(root, 'runs'),
      new SkillDirectoryStore(join(root, 'skills')),
    )
    const journalDirectory = join(root, 'journal')
    try {
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
      const address = server.address()
      if (!address || typeof address === 'string') throw new Error('Missing fixture address')
      const workspace = piWorkspace(executable, cwd)
      workspace.connections[0]!.baseUrl = `http://127.0.0.1:${address.port}/v1`
      const sources = await inspectPiSources(cwd)
      const manifest = await store.create('inputs', workspace, 'reviewer', (configuration, paths) =>
        planPi(configuration, paths, {
          sources,
          readSkillEntry: async () => {
            throw new Error('Unexpected directory')
          },
        }),
      )
      const createCoordinator = () => {
        const coordinator = new SessionCoordinator(new SessionJournal(journalDirectory), {
          create: async () => ({
            agentId: manifest.agent.id,
            installationId: manifest.installation.id,
            engineVersion: manifest.installation.version!,
            mode: manifest.launch.mode,
            cwd,
            snapshotId: manifest.id,
            snapshotDigest: manifest.digest,
          }),
          connect: async (snapshot, signal) => {
            const runtime = await connectPi({
              store,
              snapshotId: manifest.id,
              environment: { ...process.env, HOME: home },
              resolveSecret: async () => key,
              signal,
              ...(snapshot.status === 'resuming'
                ? { previousNativeSessionId: snapshot.nativeSessionId! }
                : {}),
            })
            runtimes.push(runtime)
            return runtime
          },
        })
        coordinators.push(coordinator)
        return coordinator
      }
      let coordinator = createCoordinator()
      const created = await coordinator.command({
        kind: 'create',
        commandId: 'create',
        agentId: manifest.agent.id,
      })
      await coordinator.command({ kind: 'start', commandId: 'start', sessionId: created.id })
      const wait = async (status: string) => {
        await vi.waitFor(
          async () =>
            expect((await coordinator.get({ sessionId: created.id })).status).toBe(status),
          { timeout: 20_000 },
        )
        return coordinator.get({ sessionId: created.id })
      }
      const ready = await wait('ready')
      const send = async (commandId: string) => {
        const state = await coordinator.get({ sessionId: created.id })
        return coordinator.command({
          kind: 'send',
          commandId,
          sessionId: created.id,
          runId: state.runId!,
          messageId: `message-${commandId}`,
          text: 'Read the fixture and retain its context.',
        })
      }
      const originalCommand = {
        kind: 'send',
        commandId: 'send',
        sessionId: created.id,
        runId: ready.runId!,
        messageId: 'message-send',
        text: 'Read the fixture and retain its context.',
      }
      await coordinator.command(originalCommand)
      expect((await wait('ready')).lastTurn?.outcome).toBe('completed')
      let history = (
        await coordinator.readEvents({ sessionId: created.id, afterCursor: 0, limit: 500 })
      ).events
      expect(
        history.some(
          (event) =>
            event.data.kind === 'tool.updated' &&
            event.data.status === 'completed' &&
            event.data.content?.includes('PI_RUNTIME_FILE_MARKER'),
        ),
      ).toBe(true)
      expect(
        history
          .filter((event) => event.data.kind === 'message.delta')
          .map((event) => (event.data.kind === 'message.delta' ? event.data.text : ''))
          .join(''),
      ).toContain('PI_NORMALIZED_MARKER [redacted] 中文🙂\u2028\u2029')
      const count = requests
      await coordinator.command(originalCommand)
      expect(requests).toBe(count)
      phase = 'stream'
      const running = await send('stream')
      await vi.waitFor(
        async () => {
          const events = (
            await coordinator.readEvents({ sessionId: created.id, afterCursor: 0, limit: 500 })
          ).events
          expect(
            events.some(
              (event) =>
                event.data.kind === 'message.delta' &&
                event.data.text.includes('PI_ACTIVE_STREAM_MARKER'),
            ),
          ).toBe(true)
        },
        { timeout: 15_000 },
      )
      await coordinator.command({
        kind: 'cancel',
        commandId: 'cancel',
        sessionId: created.id,
        runId: running.runId!,
        turnId: running.activeTurn!.id,
      })
      expect((await wait('ready')).lastTurn?.outcome).toBe('cancelled')
      await coordinator.shutdown()
      coordinator = createCoordinator()
      const interrupted = await coordinator.get({ sessionId: created.id })
      expect(interrupted.status).toBe('interrupted')
      expect(interrupted.nativeSessionId).toBe(ready.nativeSessionId)
      await coordinator.command({
        kind: 'resume',
        commandId: 'resume',
        sessionId: created.id,
        previousRunId: interrupted.runId!,
      })
      expect((await wait('ready')).nativeSessionId).toBe(ready.nativeSessionId)
      phase = 'resume'
      await send('restored')
      expect((await wait('ready')).lastTurn?.outcome).toBe('completed')
      expect(bodies.at(-1)).toContain('PI_RUNTIME_FILE_MARKER')
      phase = 'error'
      await send('provider-error')
      expect((await wait('ready')).lastTurn?.outcome).toBe('failed')
      history = (
        await coordinator.readEvents({ sessionId: created.id, afterCursor: 0, limit: 500 })
      ).events
      expect(
        history.some(
          (event) => event.data.kind === 'turn.finished' && event.data.nativeStopReason === 'error',
        ),
      ).toBe(true)
      expect(await readFile(join(journalDirectory, `${created.id}.jsonl`), 'utf8')).not.toContain(
        key,
      )
      expect(serverError).toBeNull()
      await coordinator.shutdown()
      expect(await store.read('inputs')).toEqual(manifest)
      if (process.env.AGENT_MATRIX_PI_RUNTIME_REPORT)
        await writeFile(
          process.env.AGENT_MATRIX_PI_RUNTIME_REPORT,
          JSON.stringify(
            {
              checkedAt: new Date().toISOString(),
              platform: process.platform,
              architecture: process.arch,
              engineVersion: manifest.installation.version,
              externalProviderCalls: false,
              normalizedStreamingAndTools: true,
              splitCredentialRedaction: true,
              acceptanceAndTerminalSeparation: true,
              coordinatorJournalAndCommandReplay: true,
              nativeCancellation: true,
              nativeRestoration: true,
              restoredFileToolContext: true,
              postAcceptanceFailure: true,
              unknownModelCost: true,
              providerCalls: requests,
            },
            null,
            2,
          ) + '\n',
        )
    } finally {
      await Promise.allSettled(coordinators.map((coordinator) => coordinator.shutdown()))
      await closeNativeFixture(
        runtimes.map((runtime) => ({ close: () => runtime.dispose() })),
        server,
        root,
      )
    }
  },
)
