import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'
import { createServer } from 'node:http'
import { mkdir, mkdtemp, readFile, realpath, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { isAbsolute, join } from 'node:path'
import { expect, it, vi } from 'vitest'
import { SkillDirectoryStore } from '../src/main/assets/skill-directory-store'
import { RunInputStore } from '../src/main/engines/run-input-store'
import { DesktopSessionFactory } from '../src/main/sessions/desktop-factory'
import { capturedSkillSources } from '../src/main/engines/skill-readback'
import { createSessionSnapshot } from '../src/shared/sessions/state'
import type { SessionSnapshot } from '../src/shared/sessions/schema'
import type { RuntimeOutput, RuntimeSession } from '../src/main/engines/runtime'
import type { SecretCipher } from '../src/main/credentials/vault'
import { openCodeWorkspace } from './helpers/opencode-fixture'
import { piWorkspace } from './helpers/pi-fixture'
import { dshWorkspace } from './helpers/dsh-fixture'
import { closeNativeFixture } from './helpers/close-native-fixture'

const routes = ['opencode', 'pi', 'dsh-pi-ai', 'dsh-native'] as const
type Side = 'A' | 'B'
interface Run {
  side: Side
  snapshot: SessionSnapshot
  runtime?: RuntimeSession
  manifest: Buffer
  skillEntry: string
  stateEnvironment: Record<string, string>
  outputs: RuntimeOutput[]
  phase: string
  step: number
  requests: number
}

for (const route of routes) {
  const engine = route === 'opencode' || route === 'pi' ? route : 'dsh'
  const executable = process.env[`AGENT_MATRIX_TEST_${engine.toUpperCase()}`]
  it.runIf(Boolean(executable))(
    `isolates overlapping snapshots and native restores through ${route}`,
    async () => {
      if (!executable || !isAbsolute(executable)) throw new Error('Absolute executable required')
      const root = await realpath(await mkdtemp(join(tmpdir(), `agentmatrix-isolation-${route}-`)))
      const home = join(root, 'home')
      const keys = { A: 'synthetic-isolation-provider-A', B: 'synthetic-isolation-provider-B' }
      const headers = { A: 'synthetic-isolation-header-A', B: 'synthetic-isolation-header-B' }
      const ambient = 'synthetic-unselected-ambient-key'
      const runsBySide = new Map<Side, Run>()
      const attachments: RuntimeSession[] = [],
        errors: unknown[] = []
      const held = new Set<Side>()
      let release!: () => void
      const gate = new Promise<void>((resolve) => {
        release = resolve
      })
      let factory: DesktopSessionFactory | undefined
      let primaryRequests = 0
      const server = createServer(async (request, response) => {
        try {
          let raw = ''
          for await (const part of request) {
            raw += String(part)
            if (raw.length > 4_194_304) throw new Error('Request limit')
          }
          const input = JSON.parse(raw)
          const side = request.url?.startsWith('/A/') ? 'A' : 'B'
          const other = side === 'A' ? 'B' : 'A'
          expect(request.url).toBe(`/${side}/v1/chat/completions`)
          expect(request.headers.authorization).toBe(`Bearer ${keys[side]}`)
          expect(request.headers['x-private']).toBe(
            route === 'dsh-native' ? undefined : headers[side],
          )
          expect(input.model).toBe(`isolation-${side}`)
          expect(JSON.stringify(request.headers)).not.toContain(keys[other])
          expect(raw).not.toContain(keys[other])
          expect(raw).not.toContain(headers[other])
          expect(raw).not.toContain(ambient)
          const primary = input.tools?.some(
            (tool: { function?: { name: string } }) => tool.function?.name === 'read',
          )
          let delta: object = { role: 'assistant', content: 'Isolated fixture title' }
          let finish = 'stop'
          if (primary) {
            const run = runsBySide.get(side)!
            expect(run).toBeTruthy()
            run.requests++
            primaryRequests++
            expect(raw).toContain(`ISOLATION_PROMPT_${side}`)
            expect(raw).not.toContain(`ISOLATION_PROMPT_${other}`)
            expect(raw).not.toContain(`ISOLATION_SKILL_${other}`)
            expect(raw).not.toContain(`ISOLATION_WORKSPACE_${other}`)
            const foreign = runsBySide.get(other)
            if (foreign) expect(raw).not.toContain(foreign.snapshot.snapshotId)
            if (run.phase !== 'initial') expect(raw).toContain(`ISOLATION_REPLY_${side}_initial`)
            const toolId = (step: number) => `${side}-${run.phase}-${step}`
            const result = (step: number) => {
              const message = input.messages.find(
                (message: { role: string; tool_call_id?: string }) =>
                  message.role === 'tool' && message.tool_call_id === toolId(step),
              )
              expect(message).toBeTruthy()
              return typeof message.content === 'string'
                ? message.content
                : JSON.stringify(message.content)
            }
            let tool: { name: string; arguments: string } | undefined
            if (run.step === 0) {
              tool =
                engine === 'pi'
                  ? { name: 'read', arguments: JSON.stringify({ path: run.skillEntry }) }
                  : { name: 'skill', arguments: JSON.stringify({ name: 'isolation-skill' }) }
            } else if (run.step === 1) {
              expect(result(0)).toContain(`ISOLATION_SKILL_${side}`)
              tool = {
                name: 'bash',
                arguments: JSON.stringify({
                  command: 'node isolation-check.cjs',
                  ...(engine !== 'pi'
                    ? { description: 'Inspect isolated fixture environment and workspace' }
                    : {}),
                }),
              }
            } else {
              expect(run.step).toBe(2)
              const text = result(1)
              expect(text).toContain(`ISOLATION_WORKSPACE_${side}`)
              expect(text).toContain(`ISOLATION_ENV_${side}`)
              if (engine === 'dsh') {
                // Pinned dsh-subprocess scrubs credential-shaped variables before tools run.
                expect(text).toContain('"credentials":{}')
                expect(text).not.toContain(keys[side])
                expect(text).not.toContain(headers[side])
              } else {
                expect(text).toContain(keys[side])
                expect(text).toContain(headers[side])
              }
              expect(text).toContain('AMBIENT_ABSENT')
              for (const path of Object.values(run.stateEnvironment)) expect(text).toContain(path)
              delta = {
                role: 'assistant',
                content: `ISOLATION_REPLY_${side}_${run.phase} ${keys[side]}`,
              }
            }
            if (tool) {
              expect(
                input.tools.some(
                  (entry: { function?: { name: string } }) => entry.function?.name === tool!.name,
                ),
              ).toBe(true)
              delta = {
                role: 'assistant',
                tool_calls: [{ index: 0, id: toolId(run.step), type: 'function', function: tool }],
              }
              finish = 'tool_calls'
            }
            if (run.phase === 'initial' && run.step === 0) {
              held.add(side)
              await gate
            }
            run.step++
          }
          if (!input.stream) {
            response.writeHead(200, { 'Content-Type': 'application/json' }).end(
              JSON.stringify({
                id: 'isolation',
                object: 'chat.completion',
                created: 1,
                model: input.model,
                choices: [{ index: 0, message: delta, finish_reason: finish }],
                usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 },
              }),
            )
            return
          }
          response.writeHead(200, { 'Content-Type': 'text/event-stream' })
          for (const [value, reason] of [
            [delta, null],
            [{}, finish],
          ])
            response.write(
              `data: ${JSON.stringify({ id: 'isolation', object: 'chat.completion.chunk', created: 1, model: input.model, choices: [{ index: 0, delta: value, finish_reason: reason }] })}\n\n`,
            )
          response.end('data: [DONE]\n\n')
        } catch (error) {
          errors.push(error)
          if (!response.headersSent) response.writeHead(400)
          response.end('Fixture rejected request')
        }
      })
      try {
        await mkdir(home)
        for (const side of ['A', 'B'] as const) {
          const cwd = join(root, `project-${side}`)
          await mkdir(join(cwd, '.git'), { recursive: true })
          await writeFile(join(cwd, 'workspace.txt'), `ISOLATION_WORKSPACE_${side}`)
        }
        await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
        const address = server.address()
        if (!address || typeof address === 'string') throw new Error('Missing server address')
        let state = (
          engine === 'opencode' ? openCodeWorkspace : engine === 'pi' ? piWorkspace : dshWorkspace
        )(executable, join(root, 'project-A'))
        const cryptoKey = randomBytes(32)
        const cipher: SecretCipher = {
          available: async () => true,
          encrypt: async (value) => {
            const iv = randomBytes(12),
              stream = createCipheriv('aes-256-gcm', cryptoKey, iv)
            return Buffer.concat([
              iv,
              stream.update(value, 'utf8'),
              stream.final(),
              stream.getAuthTag(),
            ])
          },
          decrypt: async (value) => {
            const stream = createDecipheriv('aes-256-gcm', cryptoKey, value.subarray(0, 12))
            stream.setAuthTag(value.subarray(-16))
            return {
              value: Buffer.concat([
                stream.update(value.subarray(12, -16)),
                stream.final(),
              ]).toString('utf8'),
              reencrypt: false,
            }
          },
        }
        const skills = new SkillDirectoryStore(join(root, 'skills'))
        const runs = new RunInputStore(join(root, 'runs'), skills, cipher)
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
            OPENAI_API_KEY: ambient,
            ISOLATION_AMBIENT_KEY: ambient,
            AGENT_MATRIX_SECRET_999: ambient,
          },
          resolveSecret: async (reference) => {
            if (reference.kind !== 'environment') throw new Error('Unexpected reference')
            for (const side of ['A', 'B'] as const) {
              if (reference.name === `ISOLATION_KEY_${side}`) return keys[side]
              if (reference.name === `ISOLATION_HEADER_${side}`) return headers[side]
            }
            throw new Error('Unselected reference')
          },
        })
        await factory.probe({ installationId: state.installations[0]!.id })
        for (const side of ['A', 'B'] as const) {
          const version = side === 'A' ? 1 : 2
          state.revision++
          state.connections[0]!.protocol =
            route === 'dsh-native' ? 'deepseek-official' : 'openai-chat-completions'
          state.connections[0]!.baseUrl = `http://127.0.0.1:${address.port}/${side}/v1`
          state.connections[0]!.auth = {
            kind: 'bearer',
            secret: { kind: 'environment', name: `ISOLATION_KEY_${side}` },
          }
          state.connections[0]!.headers = {}
          state.connections[0]!.secretHeaders =
            route === 'dsh-native'
              ? {}
              : { 'X-Private': { kind: 'environment', name: `ISOLATION_HEADER_${side}` } }
          state.models[0]!.modelId = `isolation-${side}`
          state.agents[0]!.execution = {
            cwd: join(root, `project-${side}`),
            approval: 'unrestricted',
          }
          state.agents[0]!.promptBindings = [
            { assetId: 'role', mode: 'replace', selection: { follow: 'latest' } },
          ]
          state.prompts[0]!.currentVersion = version
          if (side === 'A') state.prompts[0]!.versions = []
          state.prompts[0]!.versions.push({
            version,
            content: `Follow the fixture instructions. ISOLATION_PROMPT_${side}`,
          })
          state.skills[0]!.name = 'isolation-skill'
          state.skills[0]!.currentVersion = version
          if (side === 'A') state.skills[0]!.versions = []
          state.skills[0]!.versions.push({
            version,
            kind: 'markdown',
            content: `---\nname: isolation-skill\ndescription: Verify captured resource isolation.\n---\nISOLATION_SKILL_${side}\n`,
          })
          const identity = await factory.create(`session-${side}`, {
            kind: 'create',
            commandId: `create-${side}`,
            agentId: 'reviewer',
          })
          const manifest = await runs.read(identity.snapshotId)
          const paths = runs.paths(identity.snapshotId)
          const sources = await capturedSkillSources(manifest, paths, `${engine}-mappings.json`)
          const stateEnvironment = Object.fromEntries(
            Object.entries(manifest.launch.environment)
              .filter(([, value]) => value.kind === 'state-directory')
              .map(([name, value]) => [name, join(paths.state, 'path' in value ? value.path : '')]),
          )
          const script = `const fs = require('node:fs');\nconst names = ${JSON.stringify(Object.keys(stateEnvironment))};\nconsole.log('ISOLATION_ENV_${side}', JSON.stringify({ credentials: Object.fromEntries(Object.entries(process.env).filter(([name]) => name.startsWith('AGENT_MATRIX_SECRET_'))), state: Object.fromEntries(names.map(name => [name, process.env[name]])) }));\nconsole.log(process.env.ISOLATION_AMBIENT_KEY || process.env.OPENAI_API_KEY || process.env.AGENT_MATRIX_SECRET_999 || 'AMBIENT_ABSENT');\nconsole.log(fs.readFileSync('workspace.txt', 'utf8'));\nfs.writeFileSync('written.txt', 'ISOLATION_WRITE_${side}');\n`
          await writeFile(join(identity.cwd, 'isolation-check.cjs'), script)
          runsBySide.set(side, {
            side,
            snapshot: createSessionSnapshot({
              ...identity,
              id: `session-${side}`,
              createdAt: new Date().toISOString(),
            }),
            manifest: await readFile(join(paths.root, 'manifest.json')),
            skillEntry: sources[0]!.paths[0]!,
            stateEnvironment,
            outputs: [],
            phase: 'initial',
            step: 0,
            requests: 0,
          })
        }
        const a = runsBySide.get('A')!,
          b = runsBySide.get('B')!
        expect(a.snapshot.snapshotId).not.toBe(b.snapshot.snapshotId)
        const connect = async (run: Run) => {
          const runtime = await factory!.connect(run.snapshot, new AbortController().signal)
          if (run.snapshot.nativeSessionId)
            expect(runtime.nativeSessionId).toBe(run.snapshot.nativeSessionId)
          run.snapshot = {
            ...run.snapshot,
            status: 'resuming',
            nativeSessionId: runtime.nativeSessionId,
          }
          run.runtime = runtime
          attachments.push(runtime)
        }
        const send = async (run: Run, phase: string) => {
          run.phase = phase
          run.step = 0
          const result = await run
            .runtime!.send(`Run the isolation checks. Phase ${phase}.`, {
              output: async (event) => {
                run.outputs.push(event)
              },
              interaction: async () => ({ kind: 'cancelled' }),
            })
            .catch((error) => {
              if (errors.length) throw errors[0]
              throw error
            })
          expect(errors).toEqual([])
          expect(result.outcome).toBe('completed')
          expect(run.step).toBe(3)
          const output = JSON.stringify(run.outputs)
          const other = run.side === 'A' ? 'B' : 'A'
          for (const value of [...Object.values(keys), ...Object.values(headers), ambient])
            expect(output).not.toContain(value)
          for (const kind of ['PROMPT', 'SKILL', 'WORKSPACE', 'ENV', 'REPLY'])
            expect(output).not.toContain(`ISOLATION_${kind}_${other}`)
          expect(output).not.toContain(runsBySide.get(other)!.snapshot.snapshotId)
          expect(output).toContain(`ISOLATION_REPLY_${run.side}_${phase} [redacted]`)
          expect(await readFile(join(run.snapshot.cwd, 'written.txt'), 'utf8')).toBe(
            `ISOLATION_WRITE_${run.side}`,
          )
        }
        await connect(a)
        await connect(b)
        expect(a.runtime!.nativeSessionId).not.toBe(b.runtime!.nativeSessionId)
        const first = Promise.all([send(a, 'initial'), send(b, 'initial')])
        void first.catch(() => {})
        try {
          await vi.waitFor(
            () => {
              expect(errors).toEqual([])
              expect(held.size).toBe(2)
            },
            { timeout: 20_000 },
          )
        } finally {
          release()
        }
        await first
        await a.runtime!.dispose()
        await send(b, 'sibling_closed')
        state.prompts = []
        state.skills = []
        state.models[0]!.modelId = 'CURRENT_LIBRARY_MUST_NOT_APPLY'
        await connect(a)
        await b.runtime!.dispose()
        await connect(b)
        await Promise.all([send(a, 'resumed'), send(b, 'resumed')])
        for (const run of [a, b]) {
          const manifest = await runs.verifyForReuse(run.snapshot.snapshotId)
          expect(await readFile(join(runs.paths(manifest.id).root, 'manifest.json'))).toEqual(
            run.manifest,
          )
          const own = await runs.retainRedactions(manifest, [])
          expect(own).toContain(keys[run.side])
          expect(own).not.toContain(keys[run.side === 'A' ? 'B' : 'A'])
          const encryptedHistory = await readFile(
            join(runs.paths(manifest.id).root, 'redactions.enc'),
          )
          for (const secret of [...Object.values(keys), ...Object.values(headers), ambient]) {
            expect(run.manifest.includes(secret)).toBe(false)
            expect(encryptedHistory.includes(secret)).toBe(false)
          }
          for (const file of manifest.files) {
            const bytes = await readFile(join(runs.paths(manifest.id).inputs, file.path))
            for (const secret of [...Object.values(keys), ...Object.values(headers), ambient])
              expect(bytes.includes(secret)).toBe(false)
          }
        }
        await a.runtime!.dispose()
        await runs.remove(a.snapshot.snapshotId)
        await expect(
          readFile(join(runs.paths(a.snapshot.snapshotId).root, 'redactions.enc')),
        ).rejects.toMatchObject({ code: 'ENOENT' })
        await send(b, 'sibling_removed')
        expect(
          await readFile(join(runs.paths(b.snapshot.snapshotId).root, 'manifest.json')),
        ).toEqual(b.manifest)
        expect(errors).toEqual([])
        if (process.env.AGENT_MATRIX_ISOLATION_REPORT)
          await writeFile(
            `${process.env.AGENT_MATRIX_ISOLATION_REPORT}.${route}.json`,
            JSON.stringify(
              {
                checkedAt: new Date().toISOString(),
                passed: true,
                platform: process.platform,
                architecture: process.arch,
                route,
                executable: executable.startsWith(`${homedir()}/`)
                  ? `~${executable.slice(homedir().length)}`
                  : executable,
                version: state.installations[0]!.version,
                service: 'Local synthetic Chat Completions provider',
                protocol: route === 'dsh-native' ? 'deepseek-official' : 'openai-chat-completions',
                models: ['isolation-A', 'isolation-B'],
                simultaneousProviderGate: true,
                snapshotsFromSameProfile: 2,
                credentialsAndEndpointsIsolated: true,
                nativeToolEnvironmentInspected: true,
                nativeToolCredentialPolicy: engine === 'dsh' ? 'scrubbed' : 'selected-only',
                unselectedAmbientKeysAbsent: true,
                nativeSkillVersionsVerified: true,
                workspaceReadsAndWritesIsolated: true,
                siblingContinuesAfterCloseAndRemoval: true,
                exactNativeResumeAfterLibraryRemoval: true,
                nativeContextIsolated: true,
                normalizedOutputRedacted: true,
                normalizedOutputsIsolated: true,
                inputsContainNoFixtureCredentials: true,
                encryptedHistoriesContainNoPlaintextCredentials: true,
                manifestsUnchanged: true,
                redactionHistoriesIsolated: true,
                cipher:
                  'Test AES-GCM implementation of SecretCipher; OS storage covered separately',
                primaryRequests,
                externalProviderCalls: false,
              },
              null,
              2,
            ) + '\n',
          )
      } finally {
        release()
        await factory?.shutdown()
        await closeNativeFixture(
          attachments.map((runtime) => ({ close: () => runtime.dispose() })),
          server,
          root,
        )
      }
    },
  )
}
