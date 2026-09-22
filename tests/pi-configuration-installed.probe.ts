import { createServer } from 'node:http'
import { mkdir, mkdtemp, readFile, realpath, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { isAbsolute, join } from 'node:path'
import { expect, it, vi } from 'vitest'
import { SkillDirectoryStore } from '../src/main/assets/skill-directory-store'
import { RunInputStore } from '../src/main/engines/run-input-store'
import { planPi, piContract } from '../src/main/engines/adapters/pi/configuration'
import { preparePiLaunch, verifyPiHome } from '../src/main/engines/adapters/pi/launch'
import { verifyPiReadback } from '../src/main/engines/adapters/pi/readback'
import { inspectPiSources } from '../src/main/engines/adapters/pi/sources'
import { attachPiProcess, type PiAttachment } from '../src/main/engines/pi/attachment'
import type { PiRecord } from '../src/main/engines/pi/protocol'
import { closeNativeFixture } from './helpers/close-native-fixture'
import { piWorkspace } from './helpers/pi-fixture'

const executable = process.env.AGENT_MATRIX_TEST_PI
it.runIf(Boolean(executable))(
  'loads saved Pi profiles, captured prompts and directory Skills through the configuration adapter',
  async () => {
    if (!executable || !isAbsolute(executable))
      throw new Error('An absolute Pi executable is required')
    const root = await realpath(await mkdtemp(join(tmpdir(), 'agentmatrix-pi-mapping-')))
    const home = join(root, 'home'),
      cwd = join(root, 'project'),
      source = join(root, 'source')
    for (const path of [
      home,
      join(cwd, '.pi/extensions'),
      join(cwd, '.pi/skills/unselected'),
      join(source, 'references'),
      join(home, '.pi/agent'),
    ])
      await mkdir(path, { recursive: true })
    await writeFile(join(root, 'AGENTS.md'), 'PI_ANCESTOR_MARKER')
    await writeFile(join(cwd, '.pi/SYSTEM.md'), 'PI_NATIVE_SYSTEM_MARKER')
    await writeFile(join(cwd, '.pi/APPEND_SYSTEM.md'), 'PI_NATIVE_APPEND_MARKER')
    await writeFile(
      join(cwd, '.pi/skills/unselected/SKILL.md'),
      '---\nname: unselected\ndescription: Must remain unloaded\n---\nUNSELECTED_SKILL',
    )
    const extensionEffect = join(cwd, 'extension-ran.txt')
    await writeFile(
      join(cwd, '.pi/extensions/unselected.ts'),
      `import { writeFileSync } from 'node:fs'; export default function () { writeFileSync(${JSON.stringify(extensionEffect)}, 'UNSELECTED_EXTENSION'); }`,
    )
    const trustPath = join(home, '.pi/agent/trust.json')
    const trust = JSON.stringify({ version: 1, decisions: { '/unrelated': true } })
    await writeFile(trustPath, trust)
    await writeFile(
      join(source, 'SKILL.md'),
      '---\nname: fixture-skill\ndescription: PI_SKILL_DESCRIPTION\n---\nRead references/guide.md. PI_SKILL_BODY',
    )
    await writeFile(join(source, 'references/guide.md'), 'PI_SKILL_REFERENCE')
    const skills = new SkillDirectoryStore(join(root, 'captures'))
    const captured = await skills.capture(source)
    const workspace = piWorkspace(executable, cwd)
    workspace.skills.push({
      id: 'directory',
      name: 'Directory Skill',
      description: '',
      enabled: true,
      sourcePath: source,
      currentVersion: 1,
      versions: [captured.snapshot],
    })
    workspace.agents[0]!.skillBindings.push({
      assetId: 'directory',
      selection: { follow: 'latest' },
    })
    workspace.models[0]!.parameters = { temperature: 0, topP: 0.7 }
    const literal = '!must-stay-literal $HOME ${UNKNOWN} $$'
    workspace.connections[0]!.headers = { 'X-Literal': literal }
    workspace.connections[0]!.secretHeaders = {
      'X-Secret': { kind: 'environment', name: 'PROBE_KEY' },
    }
    const key = 'synthetic-pi-"$HOME!"-key'
    const store = new RunInputStore(join(root, 'runs'), skills)
    const attachments: PiAttachment[] = []
    const requests: {
      authorization?: string
      extra?: string
      literal?: string
      input: { messages: unknown[]; tools?: unknown[]; temperature?: number; top_p?: number }
    }[] = []
    let step = 0,
      activeSnapshot = 'first',
      noTools = false,
      serverError: unknown = null
    const server = createServer(async (request, response) => {
      try {
        let body = ''
        for await (const chunk of request) {
          body += String(chunk)
          if (body.length > 4_194_304) throw new Error('Fixture request limit')
        }
        const input = JSON.parse(body)
        if (
          request.url !== '/v1/chat/completions' ||
          !input.stream ||
          input.model !== 'fixture-model'
        )
          throw new Error('Unexpected native request')
        requests.push({
          authorization: request.headers.authorization,
          extra: request.headers['x-secret'] as string | undefined,
          literal: request.headers['x-literal'] as string | undefined,
          input,
        })
        response.writeHead(200, { 'Content-Type': 'text/event-stream' })
        const send = (delta: object, finish_reason: string | null = null) =>
          response.write(
            `data: ${JSON.stringify({ id: 'pi-config', object: 'chat.completion.chunk', created: 1, model: input.model, choices: [{ index: 0, delta, finish_reason }] })}\n\n`,
          )
        send({ role: 'assistant' })
        if (!noTools && step < 2) {
          const path = join(
            store.paths(activeSnapshot).inputs,
            'skills/fixture-skill',
            step++ === 0 ? 'SKILL.md' : 'references/guide.md',
          )
          send({
            tool_calls: [
              {
                index: 0,
                id: `read-${step}`,
                type: 'function',
                function: { name: 'read', arguments: JSON.stringify({ path }) },
              },
            ],
          })
          send({}, 'tool_calls')
        } else {
          send({ content: 'PI_MAPPED_TURN_MARKER' })
          send({}, 'stop')
        }
        response.end('data: [DONE]\n\n')
      } catch (error) {
        serverError = error
        response.writeHead(500)
        response.end()
      }
    })
    const capture = async (id: string) => {
      const sources = await inspectPiSources(cwd)
      return store.create(id, workspace, 'reviewer', (configuration, paths) =>
        planPi(configuration, paths, {
          sources,
          readSkillEntry: async (skill) => {
            if (skill.revision.kind !== 'directory') throw new Error('Expected directory')
            return readFile(join(await skills.verify(skill.revision), 'SKILL.md'), 'utf8')
          },
        }),
      )
    }
    const run = async (id: string) => {
      activeSnapshot = id
      step = 0
      const { manifest, launch } = await preparePiLaunch(
        store,
        id,
        async () => key,
        { ...process.env, HOME: home },
        new AbortController().signal,
      )
      const events: PiRecord[] = []
      const attachment = await attachPiProcess(launch, {
        event: async (event) => {
          events.push(event)
        },
        dialog: async () => ({ cancelled: true }),
      })
      attachments.push(attachment)
      await verifyPiReadback(attachment.client, manifest, store.paths(id))
      await attachment.client.request({
        type: 'prompt',
        message: 'Use fixture-skill, including its reference file.',
      })
      await vi.waitFor(
        () => expect(events.some((event) => event.type === 'agent_settled')).toBe(true),
        { timeout: 20_000 },
      )
      expect(JSON.stringify(events)).toContain('PI_MAPPED_TURN_MARKER')
      await attachment.close()
      await verifyPiHome(store, id)
      expect(await store.read(id)).toEqual(manifest)
      return events
    }
    try {
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
      const address = server.address()
      if (!address || typeof address === 'string') throw new Error('Missing fixture address')
      workspace.connections[0]!.baseUrl = `http://127.0.0.1:${address.port}/v1`
      const first = await capture('first')
      const mappings = JSON.parse(
        await readFile(join(store.paths('first').inputs, 'pi-mappings.json'), 'utf8'),
      )
      const selected = mappings.skills[0]
      const substitute = join(root, 'substitute', 'SKILL.md')
      await mkdir(join(root, 'substitute'))
      await writeFile(
        substitute,
        `---\nname: ${selected.name}\ndescription: Substituted native source\n---\nPRIVATE_SUBSTITUTE_BODY`,
      )
      const beforeMismatch = requests.length
      const prepared = await preparePiLaunch(
        store,
        'first',
        async () => key,
        { ...process.env, HOME: home },
        new AbortController().signal,
      )
      const substituted = await attachPiProcess(
        {
          ...prepared.launch,
          args: prepared.launch.args.map((arg) =>
            arg === join(store.paths('first').inputs, selected.path, 'SKILL.md') ? substitute : arg,
          ),
        },
        { event: async () => {}, dialog: async () => ({ cancelled: true }) },
      )
      attachments.push(substituted)
      const nativeCommands = await substituted.client.request({ type: 'get_commands' })
      expect(JSON.stringify(nativeCommands)).toContain(`skill:${selected.name}`)
      expect(JSON.stringify(nativeCommands)).toContain(substitute)
      await expect(
        verifyPiReadback(substituted.client, first, store.paths('first')),
      ).rejects.toMatchObject({
        diagnostic: { check: 'pi-skills', reason: 'mismatch', fields: ['skills'] },
      })
      await substituted.close()
      expect(requests.length).toBe(beforeMismatch)
      await run('first')
      const firstRequest = JSON.stringify(requests[0]!.input.messages)
      expect(firstRequest).toContain('ROLE_MARKER')
      expect(firstRequest).toContain('APPEND_MARKER')
      expect(firstRequest).toContain('PI_ANCESTOR_MARKER')
      expect(firstRequest).toContain('PI_SKILL_DESCRIPTION')
      expect(firstRequest).not.toContain('PI_NATIVE_APPEND_MARKER')
      expect(firstRequest).not.toContain('PI_NATIVE_SYSTEM_MARKER')
      expect(JSON.stringify(requests.at(-1)!.input.messages)).toContain('PI_SKILL_BODY')
      expect(JSON.stringify(requests.at(-1)!.input.messages)).toContain('PI_SKILL_REFERENCE')
      expect(requests[0]!.input.temperature).toBe(0)
      expect(requests[0]!.input.top_p).toBe(0.7)
      const old = await readFile(join(store.paths('first').inputs, 'prompts/role.md'), 'utf8')
      workspace.prompts[0]!.versions.push({ version: 2, content: 'PI_NEW_ROLE_MARKER' })
      workspace.prompts[0]!.currentVersion = 2
      workspace.agents[0]!.engineOptions = {
        kind: 'pi',
        projectTrust: 'trust-once',
        contextFiles: 'inherit',
      }
      await capture('second')
      await run('second')
      const secondRequest = JSON.stringify(requests.at(-1)!.input.messages)
      expect(secondRequest).toContain('PI_NEW_ROLE_MARKER')
      expect(secondRequest).toContain('PI_NATIVE_APPEND_MARKER')
      expect(await readFile(join(store.paths('first').inputs, 'prompts/role.md'), 'utf8')).toBe(old)
      await run('first')
      expect(JSON.stringify(requests.at(-1)!.input.messages)).not.toContain('PI_NEW_ROLE_MARKER')
      workspace.agents[0]!.execution.approval = 'deny'
      workspace.agents[0]!.engineOptions = {
        kind: 'pi',
        projectTrust: 'trust-once',
        contextFiles: 'ignore',
      }
      workspace.agents[0]!.promptBindings = workspace.agents[0]!.promptBindings.filter(
        (binding) => binding.mode !== 'replace',
      )
      await capture('no-tools')
      noTools = true
      await run('no-tools')
      const finalRequest = requests.at(-1)!.input
      expect(finalRequest.tools ?? []).toHaveLength(0)
      expect(JSON.stringify(finalRequest.messages)).not.toContain('PI_ANCESTOR_MARKER')
      expect(JSON.stringify(finalRequest.messages)).toContain('PI_NATIVE_SYSTEM_MARKER')
      expect(JSON.stringify(finalRequest.messages)).toContain('PI_NATIVE_APPEND_MARKER')
      expect(await readFile(extensionEffect, 'utf8').catch(() => null)).toBeNull()
      expect(await readFile(trustPath, 'utf8')).toBe(trust)
      expect(
        requests.every(
          (request) =>
            request.authorization === `Bearer ${key}` &&
            request.extra === key &&
            request.literal === literal,
        ),
      ).toBe(true)
      expect(serverError).toBeNull()
      expect(JSON.stringify(first)).not.toContain(key)
      if (process.env.AGENT_MATRIX_PI_CONFIGURATION_REPORT)
        await writeFile(
          process.env.AGENT_MATRIX_PI_CONFIGURATION_REPORT,
          JSON.stringify(
            {
              checkedAt: new Date().toISOString(),
              platform: process.platform,
              architecture: process.arch,
              engineVersion: piContract.engineVersion,
              externalProviderCalls: false,
              savedProfileAdapter: true,
              nativeModelAndSkillReadback: true,
              nativeSkillSourcePaths: true,
              sameNameForeignSkillRejected: true,
              sourceMismatchMakesNoModelCall: true,
              customEndpointAndSecretHeaders: true,
              literalHeaderEscaping: true,
              replacementAndAppend: true,
              nativeAppendPreserved: true,
              directorySkillAndReferenceToolResults: true,
              isolatedInputRevisions: true,
              denyTools: true,
              independentProjectTrustAndContext: true,
              unselectedExtensionsAndSkillsDisabled: true,
              unrelatedTrustUnchanged: true,
              nativeControlsVerifiedAfterExit: true,
              providerCalls: requests.length,
            },
            null,
            2,
          ) + '\n',
        )
    } finally {
      await closeNativeFixture(attachments, server, root)
    }
  },
)
