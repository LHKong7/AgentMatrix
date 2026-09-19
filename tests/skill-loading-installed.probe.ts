import { createServer } from 'node:http'
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { isAbsolute, join } from 'node:path'
import { expect, it, vi } from 'vitest'
import { SkillDirectoryStore } from '../src/main/assets/skill-directory-store'
import { RunInputStore } from '../src/main/engines/run-input-store'
import { DesktopSessionFactory } from '../src/main/sessions/desktop-factory'
import { capturedSkillSources } from '../src/main/engines/skill-readback'
import { createSessionSnapshot } from '../src/shared/sessions/state'
import type { RuntimeSession } from '../src/main/engines/runtime'
import { openCodeWorkspace } from './helpers/opencode-fixture'
import { piWorkspace } from './helpers/pi-fixture'
import { dshWorkspace } from './helpers/dsh-fixture'
import { closeNativeFixture } from './helpers/close-native-fixture'

for (const route of ['opencode', 'pi', 'dsh-pi-ai', 'dsh-native'] as const) {
  const engine = route === 'opencode' || route === 'pi' ? route : 'dsh'
  const executable = process.env[`AGENT_MATRIX_TEST_${engine.toUpperCase()}`]
  it.runIf(Boolean(executable))(
    `verifies captured Skill loading, selection and collisions through ${route}`,
    async () => {
      if (!executable || !isAbsolute(executable)) throw new Error('Absolute executable required')
      const root = await realpath(
        await mkdtemp(join(tmpdir(), `agentmatrix-skill-loading-${route}-`)),
      )
      const cwd = join(root, 'project'),
        home = join(root, 'home'),
        source = join(root, 'source')
      const attachments: RuntimeSession[] = []
      const errors: unknown[] = []
      const requests: { phase: string; step: number }[] = []
      let phase = 'initial',
        step = 0,
        skillEntry = ''
      const description = 'LAZY_SELECTED_DESCRIPTION'
      const bodyMarker = 'LAZY_SELECTED_BODY'
      const referenceMarker = 'LAZY_SELECTED_REFERENCE'
      const name = 'fixture-lazy-skill'
      const key = 'synthetic-skill-loading-key'
      let factory: DesktopSessionFactory | undefined
      const server = createServer(async (request, response) => {
        try {
          let raw = ''
          for await (const chunk of request) {
            raw += String(chunk)
            if (raw.length > 4_194_304) throw new Error('Fixture request limit')
          }
          const input = JSON.parse(raw)
          expect(request.url).toBe('/v1/chat/completions')
          expect(request.headers.authorization).toBe(`Bearer ${key}`)
          expect(input.model).toBe('fixture-model')
          const primary = input.tools?.some(
            (tool: { function?: { name: string } }) => tool.function?.name === 'read',
          )
          let delta: object = { role: 'assistant', content: 'Skill fixture title' }
          let finish = 'stop'
          if (primary) {
            requests.push({ phase, step })
            expect(raw).not.toContain('LAZY_UNBOUND')
            expect(raw).not.toContain('LAZY_DISABLED')
            const result = (id: number) => {
              const message = input.messages.find(
                (message: { role: string; tool_call_id?: string }) =>
                  message.role === 'tool' && message.tool_call_id === `${phase}-${id}`,
              )
              expect(message).toBeTruthy()
              return JSON.stringify(message.content)
            }
            if (phase === 'unbound' || phase === 'disabled') {
              expect(raw).not.toContain(name)
              expect(raw).not.toContain(description)
              expect(raw).not.toContain(bodyMarker)
              expect(raw).not.toContain(referenceMarker)
              delta = { role: 'assistant', content: `EMPTY_${phase}` }
            } else {
              expect(raw).toContain(description)
              if (phase === 'resumed') expect(raw).toContain('LOADED_initial')
              if (phase === 'initial' && step === 0) {
                expect(raw).not.toContain(bodyMarker)
                expect(raw).not.toContain(referenceMarker)
              }
              let tool: { name: string; arguments: string } | undefined
              if (step === 0) {
                tool =
                  engine === 'pi'
                    ? { name: 'read', arguments: JSON.stringify({ path: skillEntry }) }
                    : { name: 'skill', arguments: JSON.stringify({ name }) }
              } else if (step === 1) {
                expect(result(0)).toContain(bodyMarker)
                expect(result(0)).not.toContain(referenceMarker)
                if (phase === 'initial') expect(raw).not.toContain(referenceMarker)
                tool = {
                  name: 'read',
                  arguments: JSON.stringify(
                    engine === 'opencode'
                      ? { filePath: join(skillEntry, '..', 'references', 'guide.md') }
                      : engine === 'dsh'
                        ? { file_path: join(skillEntry, '..', 'references', 'guide.md') }
                        : { path: join(skillEntry, '..', 'references', 'guide.md') },
                  ),
                }
              } else {
                expect(step).toBe(2)
                expect(result(1)).toContain(referenceMarker)
                delta = { role: 'assistant', content: `LOADED_${phase}` }
              }
              if (tool) {
                expect(
                  input.tools.some(
                    (item: { function?: { name: string } }) => item.function?.name === tool!.name,
                  ),
                ).toBe(true)
                delta = {
                  role: 'assistant',
                  tool_calls: [
                    { index: 0, id: `${phase}-${step}`, type: 'function', function: tool },
                  ],
                }
                finish = 'tool_calls'
              }
            }
            step++
          }
          if (!input.stream) {
            response.writeHead(200, { 'Content-Type': 'application/json' }).end(
              JSON.stringify({
                id: 'skill-fixture',
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
              `data: ${JSON.stringify({ id: 'skill-fixture', object: 'chat.completion.chunk', created: 1, model: input.model, choices: [{ index: 0, delta: value, finish_reason: reason }] })}\n\n`,
            )
          response.end('data: [DONE]\n\n')
        } catch (error) {
          errors.push(error)
          if (!response.headersSent) response.writeHead(400)
          response.end('Fixture rejected request')
        }
      })
      try {
        for (const path of [join(cwd, '.git'), home, join(source, 'references')])
          await mkdir(path, { recursive: true })
        await writeFile(
          join(source, 'SKILL.md'),
          `---\nname: ${name}\ndescription: ${description}\n---\n${bodyMarker}\nRead references/guide.md only when needed.\n`,
        )
        await writeFile(join(source, 'references/guide.md'), referenceMarker)
        await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
        const address = server.address()
        if (!address || typeof address === 'string') throw new Error('Missing server address')
        const skills = new SkillDirectoryStore(join(root, 'skills'))
        const captured = await skills.capture(source)
        const runs = new RunInputStore(join(root, 'runs'), skills)
        let state = (
          engine === 'opencode' ? openCodeWorkspace : engine === 'pi' ? piWorkspace : dshWorkspace
        )(executable, cwd)
        state.agents[0]!.execution.approval = 'unrestricted'
        state.connections[0]!.baseUrl = `http://127.0.0.1:${address.port}/v1`
        if (route === 'dsh-native') {
          state.connections[0]!.protocol = 'deepseek-official'
          state.connections[0]!.headers = {}
        }
        state.skills[0]!.versions = [captured.snapshot]
        for (const [id, enabled] of [
          ['unbound', true],
          ['disabled', false],
        ] as const)
          state.skills.push({
            id,
            name: `LAZY_${id.toUpperCase()}`,
            description: `LAZY_${id.toUpperCase()}`,
            enabled,
            sourcePath: '',
            currentVersion: 1,
            versions: [{ version: 1, kind: 'markdown', content: `LAZY_${id.toUpperCase()}` }],
          })
        const resolveSecret = vi.fn(async () => key)
        factory = new DesktopSessionFactory({
          workspace: {
            load: async () => structuredClone(state),
            save: async (value) => {
              state = structuredClone(value)
              return structuredClone(value)
            },
          },
          runs,
          skills,
          dataDirectory: root,
          environment: { ...process.env, HOME: home, XDG_CONFIG_HOME: join(home, '.config') },
          resolveSecret,
        })
        await factory.probe({ installationId: state.installations[0]!.id })
        const capture = async (id: string) =>
          createSessionSnapshot({
            ...(await factory!.create(id, {
              kind: 'create',
              commandId: `create-${id}`,
              agentId: 'reviewer',
            })),
            id,
            createdAt: new Date().toISOString(),
          })
        const first = await capture('selected')
        const manifest = await runs.read(first.snapshotId)
        const paths = runs.paths(first.snapshotId)
        skillEntry = (await capturedSkillSources(manifest, paths, `${engine}-mappings.json`))[0]!
          .paths[0]!
        const originalManifest = await readFile(join(paths.root, 'manifest.json'))
        expect(manifest.skills).toHaveLength(1)
        await rm(source, { recursive: true })
        const connect = async (snapshot: typeof first) => {
          const runtime = await factory!.connect(snapshot, new AbortController().signal)
          attachments.push(runtime)
          return runtime
        }
        const send = async (runtime: RuntimeSession, nextPhase: string) => {
          phase = nextPhase
          step = 0
          const output: unknown[] = []
          const result = await runtime
            .send('Run the Skill loading fixture.', {
              output: async (event) => {
                output.push(event)
              },
              interaction: async () => ({ kind: 'cancelled' }),
            })
            .catch((error) => {
              throw errors[0] ?? error
            })
          expect(errors).toEqual([])
          expect(result.outcome).toBe('completed')
          expect(step).toBe(['unbound', 'disabled'].includes(phase) ? 1 : 3)
          expect(JSON.stringify(output)).toContain(
            ['unbound', 'disabled'].includes(phase) ? `EMPTY_${phase}` : `LOADED_${phase}`,
          )
        }
        const active = await connect(first)
        await send(active, 'initial')
        await active.dispose()
        const callsBefore = requests.length,
          resolutionsBefore = resolveSecret.mock.calls.length
        const selected = state.skills[0]!
        state.skills.push({ ...structuredClone(selected), id: 'duplicate' })
        state.agents[0]!.skillBindings.push({
          assetId: 'duplicate',
          selection: { follow: 'latest' },
        })
        await expect(capture('duplicate')).rejects.toThrow('skill.duplicate')
        state.skills.pop()
        state.agents[0]!.skillBindings.pop()
        selected.enabled = false
        const disabled = await capture('disabled-bound')
        expect((await runs.read(disabled.snapshotId)).skills).toEqual([])
        expect(requests.length).toBe(callsBefore)
        expect(resolveSecret).toHaveBeenCalledTimes(resolutionsBefore)
        const disabledRuntime = await connect(disabled)
        await send(disabledRuntime, 'disabled')
        await disabledRuntime.dispose()
        selected.enabled = true
        state.agents[0]!.skillBindings = []
        const unbound = await capture('unbound')
        expect((await runs.read(unbound.snapshotId)).skills).toEqual([])
        const empty = await connect(unbound)
        await send(empty, 'unbound')
        await empty.dispose()
        state.skills = []
        const restored = await connect({
          ...first,
          status: 'resuming',
          nativeSessionId: active.nativeSessionId,
        })
        expect(restored.nativeSessionId).toBe(active.nativeSessionId)
        await send(restored, 'resumed')
        expect(await readFile(join(paths.root, 'manifest.json'))).toEqual(originalManifest)
        await runs.verifyForReuse(first.snapshotId)
        expect(requests).toHaveLength(8)
        if (process.env.AGENT_MATRIX_SKILL_LOADING_REPORT)
          await writeFile(
            `${process.env.AGENT_MATRIX_SKILL_LOADING_REPORT}.${route}.json`,
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
                protocol: state.connections[0]!.protocol,
                model: 'fixture-model',
                selectedMetadataVisibleBeforeInvocation: true,
                selectedBodyAbsentBeforeInvocation: true,
                referenceAbsentUntilExplicitRead: true,
                currentToolResultsCorrelated: true,
                unboundAndDisabledLibraryAssetsAbsent: true,
                duplicateSelectedNamesRejectedBeforeSecretResolution: true,
                boundDisabledAssetOmittedFromNewSession: true,
                newUnboundSessionHasNoSelectedSkill: true,
                capturedDirectorySurvivesSourceDeletion: true,
                exactNativeResumeAfterLibraryRemoval: true,
                originalNativeContextRetained: true,
                manifestUnchanged: true,
                primaryRequests: requests.length,
                nativeTurns: 4,
                externalProviderCalls: false,
                credentialStorageScope:
                  'No OS cipher in this fixture; credential encryption has separate Electron evidence.',
              },
              null,
              2,
            ) + '\n',
          )
      } finally {
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
