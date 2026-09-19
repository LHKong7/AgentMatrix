import { createServer } from 'node:http'
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import { SkillDirectoryStore } from '../src/main/assets/skill-directory-store'
import { RunInputStore } from '../src/main/engines/run-input-store'
import { planOpenCode } from '../src/main/engines/adapters/opencode/configuration'
import { connectOpenCode } from '../src/main/engines/adapters/opencode/runtime'
import type { RuntimeSession } from '../src/main/engines/runtime'
import { openCodeWorkspace } from './helpers/opencode-fixture'
import { closeNativeFixture } from './helpers/close-native-fixture'
import * as sourceObserver from '../src/main/engines/adapters/opencode/skills'

it.runIf(Boolean(process.env.AGENT_MATRIX_TEST_OPENCODE))(
  'checks Skills in the ACP-selected OpenCode instance and rejects an ACP-only source override',
  async () => {
    const root = await realpath(
      await mkdtemp(join(tmpdir(), 'agentmatrix-opencode-instance-skills-')),
    )
    const cwd = join(root, 'project'),
      home = join(root, 'home'),
      configHome = join(root, 'config'),
      entry = join(root, 'fixture.mjs'),
      gate = join(root, 'override'),
      foreign = join(root, 'foreign')
    const runtimes: RuntimeSession[] = []
    const attachments = vi.spyOn(sourceObserver, 'prepareOpenCodeSkillAttachment')
    let calls = 0
    const server = createServer(async (request, response) => {
      const chunks: Buffer[] = []
      for await (const part of request) chunks.push(Buffer.from(part))
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8'))
      calls++
      if (!body.stream) {
        response.writeHead(200, { 'Content-Type': 'application/json' }).end(
          JSON.stringify({
            id: 'fixture',
            object: 'chat.completion',
            created: 1,
            model: body.model,
            choices: [
              {
                index: 0,
                message: { role: 'assistant', content: 'Fixture' },
                finish_reason: 'stop',
              },
            ],
          }),
        )
        return
      }
      response.writeHead(200, { 'Content-Type': 'text/event-stream' })
      for (const [delta, finish_reason] of [
        [{ role: 'assistant', content: 'OPENCODE_SOURCE_REPLY' }, null],
        [{}, 'stop'],
      ])
        response.write(
          `data: ${JSON.stringify({ id: 'fixture', object: 'chat.completion.chunk', created: 1, model: body.model, choices: [{ index: 0, delta, finish_reason }] })}\n\n`,
        )
      response.end('data: [DONE]\n\n')
    })
    try {
      for (const path of [join(cwd, '.git'), home, configHome, foreign])
        await mkdir(path, { recursive: true })
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
      const address = server.address()
      if (!address || typeof address === 'string') throw new Error('Missing address')
      const workspace = openCodeWorkspace(process.env.AGENT_MATRIX_TEST_OPENCODE!, cwd)
      workspace.connections[0]!.baseUrl = `http://127.0.0.1:${address.port}/v1`
      workspace.agents[0]!.execution.approval = 'unrestricted'
      await writeFile(
        entry,
        `import {existsSync} from 'node:fs';
export default async()=>({config(config){if(process.env.OPENCODE_SERVER_PASSWORD && existsSync(${JSON.stringify(gate)}))config.skills={paths:[${JSON.stringify(foreign)}]};}});`,
      )
      workspace.nativePlugins = [
        {
          id: 'fixture',
          nativeId: 'fixture',
          name: 'Fixture',
          version: 'fixture',
          source: 'local fixture',
          path: entry,
          engineInstallationId: 'oc',
        },
      ]
      workspace.agents[0]!.nativePluginIds = ['fixture']
      const store = new RunInputStore(
        join(root, 'runs'),
        new SkillDirectoryStore(join(root, 'skills')),
      )
      const manifest = await store.create(
        'capture',
        workspace,
        'reviewer',
        async (configuration, paths) => {
          const plan = await planOpenCode(configuration, paths, {
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
            plan.launch.environment[name] = { kind: 'literal', value }
          return plan
        },
      )
      const mapping = JSON.parse(
        await readFile(join(store.paths('capture').inputs, 'opencode-mappings.json'), 'utf8'),
      )
      for (const skill of mapping.skills) {
        await mkdir(join(foreign, skill.name))
        await writeFile(
          join(foreign, skill.name, 'SKILL.md'),
          `---\nname: ${skill.name}\ndescription: Same-name foreign Skill\n---\nPRIVATE_FOREIGN_BODY`,
        )
      }
      const connect = (previousNativeSessionId?: string) =>
        connectOpenCode({
          store,
          snapshotId: 'capture',
          environment: { ...process.env, HOME: home },
          resolveSecret: async () => 'synthetic-source-key',
          signal: new AbortController().signal,
          previousNativeSessionId,
        })
      const first = await connect()
      runtimes.push(first)
      const observation = await attachments.mock.results[0]!.value
      const nativeUrl = new URL(`http://127.0.0.1:${observation.args.at(-1)}/skill`)
      nativeUrl.searchParams.set('directory', cwd)
      const unauthenticated = await fetch(nativeUrl, { signal: AbortSignal.timeout(5000) })
      expect(unauthenticated.status).toBe(401)
      await unauthenticated.body?.cancel()
      const authorized = await fetch(nativeUrl, {
        headers: { Authorization: observation.secrets[2]! },
        signal: AbortSignal.timeout(5000),
      })
      expect(authorized.status).toBe(200)
      const nativeSkills = (await authorized.json()) as { name: string; location: string }[]
      for (const skill of mapping.skills)
        expect(nativeSkills.find((entry) => entry.name === skill.name)?.location).toBe(
          join(store.paths('capture').inputs, skill.path, 'SKILL.md'),
        )
      const captured = [
        JSON.stringify(manifest),
        ...(await Promise.all(
          manifest.files.map((file) =>
            readFile(join(store.paths('capture').inputs, file.path), 'utf8'),
          ),
        )),
      ].join('\n')
      for (const value of observation.secrets) expect(captured).not.toContain(value)
      expect(first.configurationChecks).toContain('opencode.instance-skills')
      expect(first.configurationChecks).not.toContain('opencode.skill-sources')
      const handlers = {
        output: async () => {},
        interaction: async () => ({ kind: 'cancelled' as const }),
      }
      expect((await first.send('Hello', handlers)).outcome).toBe('completed')
      await first.dispose()
      await expect(fetch(nativeUrl, { signal: AbortSignal.timeout(1000) })).rejects.toThrow()
      const resumed = await connect(first.nativeSessionId)
      runtimes.push(resumed)
      expect(resumed.nativeSessionId).toBe(first.nativeSessionId)
      expect(resumed.configurationChecks).toContain('opencode.instance-skills')
      await resumed.dispose()
      const before = calls
      await writeFile(gate, 'override ACP only')
      const rejected = {
        diagnostic: { check: 'opencode-instance-skills', reason: 'mismatch', fields: ['skills'] },
      }
      await expect(connect()).rejects.toMatchObject(rejected)
      await expect(connect(first.nativeSessionId)).rejects.toMatchObject(rejected)
      expect(calls).toBe(before)
      await store.verifyForReuse(manifest.id)
      await rm(gate)
      const restored = await connect(first.nativeSessionId)
      runtimes.push(restored)
      expect(restored.configurationChecks).toContain('opencode.instance-skills')
      await restored.dispose()
      if (process.env.AGENT_MATRIX_OPENCODE_SKILL_REPORT)
        await writeFile(
          process.env.AGENT_MATRIX_OPENCODE_SKILL_REPORT,
          JSON.stringify(
            {
              checkedAt: new Date().toISOString(),
              platform: process.platform,
              architecture: process.arch,
              engineVersion: '1.18.16',
              externalProviderCalls: false,
              ownedAuthenticatedAcpServer: true,
              unauthenticatedNativeReadRejected: true,
              authorizedNativePathsMatched: true,
              internalAuthenticationAbsentFromCapturedFiles: true,
              listenerClosedWithAcpProcess: true,
              boundedNativeSkillEndpoint: true,
              nativeSessionAndDirectoryCheckedBeforeAndAfterReadback: true,
              nativeResume: true,
              acpOnlySourceOverrideRejectedOnNewAndResumedSessions: true,
              rejectionMakesNoProviderCall: true,
              capturedInputsPreserved: true,
              restoredSourceAllowsNativeResume: true,
              providerCalls: calls,
            },
            null,
            2,
          ) + '\n',
        )
    } finally {
      attachments.mockRestore()
      await closeNativeFixture(
        runtimes.map((runtime) => ({ close: () => runtime.dispose() })),
        server,
        root,
      )
    }
  },
)
