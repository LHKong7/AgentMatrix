import { createHash, randomUUID } from 'node:crypto'
import * as fs from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SkillDirectoryStore } from '../src/main/assets/skill-directory-store'
import { observeExternalFile, RunInputStore } from '../src/main/engines/run-input-store'
import { observeResourceDirectory } from '../src/main/engines/external-sources'
import { observeInstructionSearches } from '../src/main/engines/instruction-sources'
import { migrateWorkspaceDocument } from '../src/shared/engines/migration'
import type { ResolvedAgentConfiguration } from '../src/shared/engines/resolution'
import type { GeneratedInputs, RunPaths } from '../src/shared/engines/run-inputs'
import { createWorkspace } from '../src/shared/workspace'

vi.mock('node:fs/promises', async (original) => ({
  ...(await original<typeof import('node:fs/promises')>()),
}))

let root: string
let workspace: ReturnType<typeof migrateWorkspaceDocument>['workspace']
let skills: SkillDirectoryStore
let store: RunInputStore
const hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex')
const prompt = 'A captured role 中文'
const skillText = '---\nname: review\ndescription: Review changes\n---\nInspect the diff.'

beforeEach(async () => {
  root = await fs.realpath(await fs.mkdtemp(join(tmpdir(), 'agentmatrix-run-')))
  const cwd = join(root, 'project')
  const executable = join(root, 'fake-engine')
  await fs.mkdir(cwd)
  await fs.writeFile(executable, '#!/bin/sh\nexit 17\n', { mode: 0o700 })
  skills = new SkillDirectoryStore(join(root, 'skills'))
  store = new RunInputStore(join(root, 'runs'), skills)
  workspace = migrateWorkspaceDocument(createWorkspace()).workspace
  workspace.revision = 9
  workspace.skills = [
    {
      id: 'review',
      name: 'Review',
      description: '',
      enabled: true,
      sourcePath: '',
      currentVersion: 1,
      versions: [{ version: 1, kind: 'markdown', content: skillText }],
    },
  ]
  workspace.installations = [
    {
      id: 'oc',
      kind: 'opencode',
      name: 'OpenCode',
      executable,
      prefixArgs: [],
      platform: process.platform as 'darwin' | 'linux' | 'win32',
      version: '1.18.16',
      modes: ['acp'],
      probedAt: '2026-09-18T00:00:00Z',
    },
  ]
  const agent = workspace.agents[0]!
  workspace.agents = [agent]
  agent.engineInstallationId = 'oc'
  agent.execution.cwd = cwd
  agent.promptBindings = [
    { assetId: workspace.prompts[0]!.id, mode: 'append', selection: { follow: 'latest' } },
  ]
  agent.skillBindings = [{ assetId: workspace.skills[0]!.id, selection: { follow: 'latest' } }]
  agent.bundleIds = []
  agent.nativePluginIds = []
  agent.mcpServerIds = []
  workspace.prompts[0]!.versions = [{ version: 1, content: prompt }]
  workspace.prompts[0]!.currentVersion = 1
  workspace.skills[0]!.versions = [{ version: 1, kind: 'markdown', content: skillText }]
  workspace.skills[0]!.currentVersion = 1
  workspace.models[0]!.modelId = 'test-model'
  workspace.connections[0]!.protocol = 'openai-chat-completions'
  workspace.connections[0]!.baseUrl = 'http://localhost:8080/v1'
  workspace.connections[0]!.auth = {
    kind: 'bearer',
    secret: { kind: 'environment', name: 'RUN_TEST_KEY' },
  }
})
afterEach(async () => {
  vi.restoreAllMocks()
  await fs.rm(root, { recursive: true, force: true })
})

describe('released run inputs', () => {
  it('removes owned inputs and state idempotently without following state symlinks', async () => {
    await store.create('released', workspace, workspace.agents[0]!.id, generate)
    await fs.writeFile(join(root, 'project', 'keep.txt'), 'project content')
    await fs.symlink(join(root, 'project'), join(store.paths('released').state, 'project-link'))
    await store.remove('released')
    await store.remove('released')
    await expect(fs.stat(store.paths('released').root)).rejects.toThrow('ENOENT')
    expect(await fs.readFile(join(root, 'project', 'keep.txt'), 'utf8')).toBe('project content')
  })

  it('refuses a symlinked run root and never accepts renderer paths', async () => {
    await fs.mkdir(store.root)
    await fs.symlink(join(root, 'project'), store.paths('linked').root)
    await expect(store.remove('linked')).rejects.toThrow('runIntegrity')
    expect(() => store.remove('../project')).toThrow()
    expect((await fs.stat(join(root, 'project'))).isDirectory()).toBe(true)
  })
})

async function generate(
  configuration: ResolvedAgentConfiguration,
  paths: RunPaths,
): Promise<GeneratedInputs> {
  return {
    adapter: { id: 'test-opencode', version: '1' },
    launch: {
      mode: 'acp',
      args: ['acp'],
      environment: {
        AGENT_CONFIG: { kind: 'input-file', path: 'config.json' },
        AGENT_RESOURCES: { kind: 'input-directory', path: 'prompts' },
        AGENT_STATE: { kind: 'state-directory', path: 'native/sessions' },
        PROVIDER_KEY: { kind: 'secret', reference: { kind: 'environment', name: 'RUN_TEST_KEY' } },
      },
    },
    promptPaths: Object.fromEntries(
      configuration.prompts.map((asset) => [asset.assetId, `prompts/${asset.assetId}.md`]),
    ),
    skillPaths: Object.fromEntries(
      configuration.skills.map((asset) => [asset.assetId, `skills/${asset.assetId}`]),
    ),
    files: [
      {
        path: 'config.json',
        content: JSON.stringify({ inputs: paths.inputs, model: configuration.model.modelId }),
      },
    ],
    externalSources: { coverage: 'partial', files: [] },
  }
}
const create = (id: string, builder = generate) =>
  store.create(id, workspace, workspace.agents[0]!.id, builder)

describe('unreferenced run data recovery', () => {
  it('lists only verified unused captures and owned staging names, preserving other entries', async () => {
    await create('retained')
    await create('orphan')
    const stage = randomUUID()
    await fs.mkdir(join(store.root, `.stage-${stage}`))
    await fs.mkdir(join(store.root, 'unknown'))
    await fs.mkdir(join(store.root, '.stage-not-owned'))
    await fs.symlink(join(root, 'project'), join(store.root, 'linked'))
    const page = await store.unused(new Set(['retained']), {})
    expect(page.items.map((item) => item.target)).toEqual([
      { kind: 'capture', id: 'orphan' },
      { kind: 'stage', id: stage },
    ])
    expect(page.skipped).toBe(3)
    expect(page.next).toBeNull()
    expect(JSON.stringify(page)).not.toContain(prompt)
    expect(page.items[0]?.capture).toEqual({
      agent: workspace.agents[0]!.name,
      engine: workspace.installations[0]!.name,
      cwd: await fs.realpath(workspace.agents[0]!.execution.cwd),
    })
  })
  it('removes an unused capture durably and prevents a lost create request from regenerating it', async () => {
    await create('orphan')
    const item = (await store.unused(new Set(), {})).items[0]!
    const request = { target: item.target, token: item.token }
    await store.removeUnused(request, new Set())
    const restarted = new RunInputStore(store.root, skills)
    await restarted.removeUnused(request, new Set())
    await expect(restarted.read('orphan')).rejects.toThrow('runDeleted')
    const generator = vi.fn(generate)
    await expect(
      restarted.create('orphan', workspace, workspace.agents[0]!.id, generator),
    ).rejects.toThrow('runDeleted')
    expect(generator).not.toHaveBeenCalled()
    expect((await restarted.unused(new Set(), {})).items).toEqual([])
    expect(await fs.readdir(store.root)).toEqual(['.unused-deleted-capture-orphan.json'])
    const receipt = await fs.readFile(
      join(store.root, '.unused-deleted-capture-orphan.json'),
      'utf8',
    )
    expect(receipt).not.toContain(prompt)
    expect(receipt).not.toContain(root)
    await create('distinct-new-request')
  })
  it.each(['reference', 'directory', 'contents'] as const)(
    'rejects stale cleanup after a %s change',
    async (change) => {
      await create('orphan')
      const { target, token } = (await store.unused(new Set(), {})).items[0]!
      if (change === 'directory')
        await fs.writeFile(join(store.paths('orphan').root, 'new'), 'changed')
      if (change === 'contents')
        await fs.writeFile(join(store.paths('orphan').inputs, 'config.json'), 'changed')
      await expect(
        store.removeUnused({ target, token }, new Set(change === 'reference' ? ['orphan'] : [])),
      ).rejects.toThrow(change === 'reference' ? 'runReferenced' : 'runCleanupStale')
      expect((await fs.stat(store.paths('orphan').root)).isDirectory()).toBe(true)
      expect((await fs.readdir(store.root)).some((name) => name.startsWith('.unused-'))).toBe(false)
    },
  )
  it('unlinks a staging symlink without visiting the project and rejects a replaced root', async () => {
    await create('retained')
    const id = randomUUID(),
      path = join(store.root, `.stage-${id}`)
    await fs.mkdir(path)
    await fs.writeFile(join(root, 'project', 'keep'), 'untouched')
    await fs.symlink(join(root, 'project'), join(path, 'project'))
    const { target, token } = (await store.unused(new Set(['retained']), {})).items[0]!
    await store.removeUnused({ target, token }, new Set(['retained']))
    expect(await fs.readFile(join(root, 'project', 'keep'), 'utf8')).toBe('untouched')
    await fs.symlink(join(root, 'project'), path)
    const page = await store.unused(new Set(['retained']), {})
    expect(page.items).toEqual([])
    await store.removeUnused({ target, token }, new Set(['retained']))
    expect((await fs.lstat(path)).isSymbolicLink()).toBe(true)
  })
  it.each(['partial', 'missing', 'replacement'] as const)(
    'recovers an explicitly confirmed %s cleanup across restart',
    async (mode) => {
      await create('orphan')
      const { target, token } = (await store.unused(new Set(), {})).items[0]!
      const actual = fs.rm
      const failure = vi.spyOn(fs, 'rm').mockImplementation(async (path, options) => {
        if (path === store.paths('orphan').root) throw new Error('synthetic removal failure')
        return actual(path, options)
      })
      await expect(store.removeUnused({ target, token }, new Set())).rejects.toThrow(
        'runCleanupPending',
      )
      failure.mockRestore()
      const restarted = new RunInputStore(store.root, skills)
      expect((await restarted.unused(new Set(), {})).items).toEqual([
        { target, token, pending: true, modifiedAt: null },
      ])
      await expect(restarted.removeUnused({ target, token }, new Set(['orphan']))).rejects.toThrow(
        'runReferenced',
      )
      if (mode === 'missing') await fs.rm(store.paths('orphan').root, { recursive: true })
      if (mode === 'partial') await fs.rm(store.paths('orphan').inputs, { recursive: true })
      if (mode === 'replacement') {
        await fs.rename(store.paths('orphan').root, join(root, 'original'))
        await fs.mkdir(store.paths('orphan').root)
        await fs.writeFile(join(store.paths('orphan').root, 'keep'), 'replacement')
        await expect(restarted.removeUnused({ target, token }, new Set())).rejects.toThrow(
          'runCleanupPending',
        )
        expect(await fs.readFile(join(store.paths('orphan').root, 'keep'), 'utf8')).toBe(
          'replacement',
        )
        await fs.rm(store.paths('orphan').root, { recursive: true })
        await fs.rename(join(root, 'original'), store.paths('orphan').root)
      }
      await restarted.removeUnused({ target, token }, new Set())
      expect((await restarted.unused(new Set(), {})).items).toEqual([])
    },
  )
  it('never removes a linked run-store root or uses malformed cleanup receipts', async () => {
    await create('orphan')
    const { target, token } = (await store.unused(new Set(), {})).items[0]!
    const path = join(store.root, '.unused-deleting-capture-orphan.json')
    await fs.writeFile(path, '{broken')
    await expect(store.removeUnused({ target, token }, new Set())).rejects.toThrow('runIntegrity')
    await expect(store.unused(new Set(), {})).rejects.toThrow('runIntegrity')
    await fs.rm(path)
    await fs.rename(store.root, join(root, 'original-runs'))
    await fs.symlink(join(root, 'original-runs'), store.root)
    await expect(store.removeUnused({ target, token }, new Set())).rejects.toThrow('runIntegrity')
    expect((await fs.stat(join(root, 'original-runs', 'orphan'))).isDirectory()).toBe(true)
  })
  it('paginates unused entries without returning more than a bounded page', async () => {
    await fs.mkdir(store.root)
    const ids = Array.from({ length: 101 }, () => randomUUID()).sort()
    for (const id of ids) await fs.mkdir(join(store.root, `.stage-${id}`))
    const first = await store.unused(new Set(), {})
    expect(first.items).toHaveLength(100)
    const second = await store.unused(new Set(), { after: first.next! })
    expect(second.items.map((item) => item.target.id)).toEqual(ids.slice(100))
    expect(second.next).toBeNull()
    await expect(
      store.removeUnused(
        { target: { kind: 'capture', id: '../project' }, token: 'a'.repeat(64) },
        new Set(),
      ),
    ).rejects.toThrow()
  })
})

describe('immutable run inputs', () => {
  it('captures revisions immediately and isolates later runs and mutable native state', async () => {
    const firstPending = create('first')
    workspace.prompts[0]!.versions.push({ version: 2, content: 'Later role' })
    workspace.prompts[0]!.currentVersion = 2
    workspace.skills[0]!.versions.push({ version: 2, kind: 'markdown', content: 'Later Skill' })
    workspace.skills[0]!.currentVersion = 2
    workspace.models[0]!.modelId = 'next-model'
    const [first, second] = await Promise.all([firstPending, create('second')])
    expect(first.workspaceRevision).toBe(9)
    expect(first.prompts[0]!.version).toBe(1)
    expect(second.prompts[0]!.version).toBe(2)
    expect(first.model.modelId).toBe('test-model')
    expect(second.model.modelId).toBe('next-model')
    expect(
      await fs.readFile(join(store.paths('first').inputs, first.prompts[0]!.path), 'utf8'),
    ).toBe(prompt)
    expect(
      await fs.readFile(
        join(store.paths('first').inputs, first.skills[0]!.path, 'SKILL.md'),
        'utf8',
      ),
    ).toBe(skillText)
    expect(
      await fs.readFile(
        join(store.paths('second').inputs, second.skills[0]!.path, 'SKILL.md'),
        'utf8',
      ),
    ).toBe('Later Skill')
    await fs.writeFile(
      join(store.paths('first').state, 'native/sessions', 'transcript'),
      'Native state can grow',
    )
    expect(await store.verifyForReuse('first')).toEqual(first)
    expect(first.digest).not.toBe(second.digest)
    expect(await fs.readdir(join(store.paths('second').state, 'native/sessions'))).toEqual([])
    if (process.platform !== 'win32')
      expect((await fs.stat(join(store.paths('first').root, 'manifest.json'))).mode & 0o777).toBe(
        0o600,
      )
  })

  it('copies captured Skill files and executable flags without retaining a dependency on their library or source', async () => {
    const source = join(root, 'source')
    await fs.mkdir(join(source, 'scripts'), { recursive: true })
    await fs.writeFile(join(source, 'SKILL.md'), skillText)
    const script = '#!/bin/sh\nexit 29\n'
    await fs.writeFile(join(source, 'scripts/check.sh'), script, { mode: 0o700 })
    await fs.writeFile(join(source, 'data.bin'), Buffer.from([255, 0, 13, 10]))
    const capture = await skills.capture(source)
    workspace.skills[0]!.versions = [capture.snapshot]
    const manifest = await create('copied')
    const skill = manifest.skills[0]!
    expect(skill.directoryDigest).toBe(capture.snapshot.digest)
    await fs.rm(source, { recursive: true })
    await fs.rm(skills.root, { recursive: true })
    workspace.skills = []
    workspace.prompts = []
    expect(await store.read('copied')).toEqual(manifest)
    expect(
      await fs.readFile(join(store.paths('copied').inputs, skill.path, 'scripts/check.sh'), 'utf8'),
    ).toBe(script)
    expect(manifest.files.find((file) => file.path.endsWith('scripts/check.sh'))?.executable).toBe(
      true,
    )
    expect(await fs.readFile(join(store.paths('copied').inputs, skill.path, 'data.bin'))).toEqual(
      Buffer.from([255, 0, 13, 10]),
    )
  })

  it('stores credential references without reading environment values or exposing mutable configuration to the adapter', async () => {
    const before = process.env.RUN_TEST_KEY
    const secret = 'synthetic-key-never-for-persistence'
    process.env.RUN_TEST_KEY = secret
    try {
      const manifest = await create('references', async (configuration, paths) => {
        const result = await generate(configuration, paths)
        configuration.model.modelId = 'adapter-mutated-copy'
        configuration.prompts[0]!.content = 'adapter-mutated-copy'
        return result
      })
      expect(manifest.connection.auth).toEqual(workspace.connections[0]!.auth)
      expect(manifest.model.modelId).toBe('test-model')
      expect(
        await fs.readFile(
          join(store.paths('references').inputs, manifest.prompts[0]!.path),
          'utf8',
        ),
      ).toBe(prompt)
      expect(JSON.stringify(manifest)).not.toContain(secret)
      for (const file of manifest.files)
        expect(
          (await fs.readFile(join(store.paths('references').inputs, file.path))).includes(
            Buffer.from(secret),
          ),
        ).toBe(false)
      expect(
        await fs.readFile(join(store.paths('references').root, 'manifest.json'), 'utf8'),
      ).not.toContain(secret)
    } finally {
      if (before === undefined) delete process.env.RUN_TEST_KEY
      else process.env.RUN_TEST_KEY = before
    }
  })

  it.each([
    'bytes',
    'missing',
    'extra',
    'manifest',
    'mode',
    'file-link',
    'directory-link',
    'root-link',
  ])('rejects and preserves a damaged snapshot: %s', async (damage) => {
    if (process.platform === 'win32' && damage === 'mode') return
    const manifest = await create('damaged')
    const paths = store.paths('damaged')
    const target = join(paths.inputs, manifest.prompts[0]!.path)
    if (damage === 'bytes') await fs.writeFile(target, 'changed bytes')
    if (damage === 'missing') await fs.unlink(target)
    if (damage === 'extra') await fs.writeFile(join(paths.inputs, 'unlisted'), 'extra file')
    if (damage === 'manifest') {
      const changed = structuredClone(manifest)
      changed.model.modelId = 'tampered-model'
      await fs.writeFile(join(paths.root, 'manifest.json'), JSON.stringify(changed))
    }
    if (damage === 'mode') await fs.chmod(target, 0o700)
    if (damage === 'file-link') {
      await fs.rename(target, join(root, 'outside-file'))
      await fs.symlink(join(root, 'outside-file'), target)
    }
    if (damage === 'directory-link') {
      await fs.rename(join(paths.inputs, 'prompts'), join(root, 'outside-prompts'))
      await fs.symlink(join(root, 'outside-prompts'), join(paths.inputs, 'prompts'))
    }
    if (damage === 'root-link') {
      await fs.rename(paths.root, join(root, 'outside-run'))
      await fs.symlink(join(root, 'outside-run'), paths.root)
    }
    await expect(store.read('damaged')).rejects.toThrow('error.runIntegrity')
    await expect(create('damaged')).rejects.toThrow('error.runExists')
    expect((await fs.lstat(paths.root)).isDirectory() || damage === 'root-link').toBe(true)
    if (damage === 'bytes') expect(await fs.readFile(target, 'utf8')).toBe('changed bytes')
  })

  it('keeps empty existing destinations and serializes duplicate creation without replacing the winner', async () => {
    await fs.mkdir(store.paths('empty').root, { recursive: true })
    await expect(create('empty')).rejects.toThrow('error.runExists')
    expect(await fs.readdir(store.paths('empty').root)).toEqual([])
    const first = create('same')
    const duplicate = expect(create('same')).rejects.toThrow('error.runExists')
    const manifest = await first
    await duplicate
    expect(await store.read('same')).toEqual(manifest)
    await expect(
      create('appeared', async (configuration, paths) => {
        await fs.mkdir(paths.root)
        return generate(configuration, paths)
      }),
    ).rejects.toThrow('error.runExists')
    expect(await fs.readdir(store.paths('appeared').root)).toEqual([])
    expect((await fs.readdir(store.root)).filter((path) => path.startsWith('.stage-'))).toEqual([])
  })

  it.each(['../escape', '/absolute', 'CON.txt', 'trailing.', 'bad:name', 'a/'.repeat(65) + 'file'])(
    'rejects unsafe generated paths and cleans staged files: %s',
    async (path) => {
      await expect(
        create('unsafe', async (configuration, paths) => ({
          ...(await generate(configuration, paths)),
          files: [{ path, content: 'bad path' }],
        })),
      ).rejects.toThrow()
      expect(await fs.readdir(store.root)).toEqual([])
    },
  )
  it.each([
    ['duplicate', 'duplicate'],
    ['File', 'file'],
    ['e\u0301', 'é'],
    ['parent', 'parent/child'],
    ['Name/one', 'name/two'],
    ['parent/child', 'parent'],
  ])(
    'rejects duplicate, ambiguous, or overlapping generated targets: %s, %s',
    async (first, second) => {
      await expect(
        create('collision', async (configuration, paths) => {
          const generated = await generate(configuration, paths)
          generated.files.push({ path: first, content: 'one' }, { path: second, content: 'two' })
          return generated
        }),
      ).rejects.toThrow('error.runPath')
      expect(await fs.readdir(store.root)).toEqual([])
    },
  )

  it.each([
    'missing-prompt',
    'extra-skill',
    'missing-input',
    'missing-directory',
    'unsupported-mode',
  ])('rejects an incomplete adapter plan: %s', async (problem) => {
    await expect(
      create('incomplete', async (configuration, paths) => {
        const generated = await generate(configuration, paths)
        if (problem === 'missing-prompt') generated.promptPaths = {}
        if (problem === 'extra-skill') generated.skillPaths.extra = 'skills/extra'
        if (problem === 'missing-input')
          generated.launch.environment.AGENT_CONFIG = { kind: 'input-file', path: 'missing.json' }
        if (problem === 'missing-directory')
          generated.launch.environment.AGENT_RESOURCES = {
            kind: 'input-directory',
            path: 'missing-directory',
          }
        if (problem === 'unsupported-mode') generated.launch.mode = 'pi-rpc'
        return generated
      }),
    ).rejects.toThrow('error.runConfiguration')
    expect(await fs.readdir(store.root)).toEqual([])
  })

  it('enforces byte limits before publication, then allows a valid retry', async () => {
    await expect(
      create('large', async (configuration, paths) => {
        const generated = await generate(configuration, paths)
        generated.files.push({ path: 'oversized', content: '中'.repeat(7_000_000) })
        return generated
      }),
    ).rejects.toThrow('error.runLimit')
    expect(await fs.readdir(store.root)).toEqual([])
    expect((await create('large')).id).toBe('large')
  })

  it('records native source hashes and absent files without copying their content, and rechecks both before reuse', async () => {
    const native = join(root, 'native-config.json')
    const absent = join(root, 'project-config.json')
    const contents = '{"apiKey":"synthetic-external-secret"}'
    await fs.writeFile(native, contents)
    const manifest = await create('observed', async (configuration, paths) => ({
      ...(await generate(configuration, paths)),
      externalSources: {
        coverage: 'partial',
        files: await Promise.all([observeExternalFile(native), observeExternalFile(absent)]),
      },
    }))
    expect(manifest.externalSources.files).toEqual([
      {
        path: native,
        exists: true,
        resolvedPath: native,
        sha256: hash(contents),
        bytes: Buffer.byteLength(contents),
      },
      { path: absent, exists: false },
    ])
    expect(JSON.stringify(manifest)).not.toContain('synthetic-external-secret')
    expect(await store.verifyForReuse('observed')).toEqual(manifest)
    await fs.writeFile(absent, 'newly discovered configuration')
    await expect(store.verifyForReuse('observed')).rejects.toThrow('error.runSourceChanged')
    await fs.unlink(absent)
    await fs.writeFile(native, 'changed configuration')
    await expect(store.verifyForReuse('observed')).rejects.toThrow('error.runSourceChanged')
    await fs.unlink(native)
    await expect(store.verifyForReuse('observed')).rejects.toThrow('error.runSourceChanged')
    expect(await store.read('observed')).toEqual(manifest)
  })

  it.each(['add', 'delete', 'change', 'create-root'])(
    'keeps the captured inventory immutable and rejects directory drift: %s',
    async (change) => {
      const directory = join(root, 'agents')
      if (change !== 'create-root') {
        await fs.mkdir(directory)
        await fs.writeFile(join(directory, 'original.md'), 'PRIVATE_NATIVE_PROMPT')
      }
      const manifest = await create('directory', async (configuration, paths) => ({
        ...(await generate(configuration, paths)),
        externalSources: {
          coverage: 'partial',
          files: [],
          directories: [await observeResourceDirectory(directory, 'opencode-agent')],
        },
      }))
      expect(await store.verifyForReuse('directory')).toEqual(manifest)
      expect(JSON.stringify(manifest)).not.toContain('PRIVATE_NATIVE_PROMPT')
      if (change === 'add') await fs.writeFile(join(directory, 'new.md'), 'new')
      if (change === 'delete') await fs.unlink(join(directory, 'original.md'))
      if (change === 'change') await fs.writeFile(join(directory, 'original.md'), 'updated')
      if (change === 'create-root') await fs.mkdir(directory)
      await expect(store.verifyForReuse('directory')).rejects.toThrow('error.runSourceChanged')
      expect(await store.read('directory')).toEqual(manifest)
    },
  )

  it('rejects a new resource discovered between planning and snapshot publication', async () => {
    const directory = join(root, 'agents')
    await fs.mkdir(directory)
    await expect(
      create('raced-directory', async (configuration, paths) => {
        const generated = await generate(configuration, paths)
        generated.externalSources.directories = [
          await observeResourceDirectory(directory, 'opencode-agent'),
        ]
        await fs.writeFile(join(directory, 'new.md'), 'arrived during capture')
        return generated
      }),
    ).rejects.toThrow('error.runSourceChanged')
    expect(await fs.readdir(store.root)).toEqual([])
  })

  it('rejects a new instruction match before snapshot publication', async () => {
    await fs.mkdir(join(root, 'rules'))
    await expect(
      create('raced-instructions', async (configuration, paths) => {
        const generated = await generate(configuration, paths)
        const searches = [{ cwd: root, pattern: 'rules/*.md', dot: true }]
        generated.externalSources.instructionSources = {
          version: 1,
          patterns: [
            {
              source: join(root, 'native.json'),
              index: 0,
              searches,
              files: await observeInstructionSearches(searches),
            },
          ],
          unobserved: [],
        }
        await fs.writeFile(join(root, 'rules/new.md'), 'arrived during capture')
        return generated
      }),
    ).rejects.toThrow('error.runSourceChanged')
    expect(await fs.readdir(store.root)).toEqual([])
  })

  it('reads earlier manifest-v1 snapshots without adding source fields or changing their digest', async () => {
    const manifest = await create('legacy')
    expect(Object.hasOwn(manifest.externalSources, 'directories')).toBe(false)
    expect(Object.hasOwn(manifest.externalSources, 'instructionSources')).toBe(false)
    expect(await store.verifyForReuse('legacy')).toEqual(manifest)
  })

  it.each(['binary', 'native'])('rejects a %s change while preparing inputs', async (changed) => {
    const native = join(root, 'native.json')
    await fs.writeFile(native, 'before')
    await expect(
      create('raced', async (configuration, paths) => {
        const generated = await generate(configuration, paths)
        generated.externalSources.files = [await observeExternalFile(native)]
        await fs.writeFile(
          changed === 'binary' ? configuration.installation.executable : native,
          'changed',
        )
        return generated
      }),
    ).rejects.toThrow('error.runSourceChanged')
    expect(await fs.readdir(store.root)).toEqual([])
  })

  it('rejects changed executables and redirected working directories without changing the stored snapshot', async () => {
    const project = workspace.agents[0]!.execution.cwd
    const alias = join(root, 'project-link')
    await fs.symlink(project, alias)
    workspace.agents[0]!.execution.cwd = alias
    const manifest = await create('stable')
    expect(manifest.cwd).toBe(project)
    const executable = workspace.installations[0]!.executable
    const original = await fs.readFile(executable)
    await fs.writeFile(executable, 'new engine release')
    await expect(store.verifyForReuse('stable')).rejects.toThrow('error.runSourceChanged')
    await fs.writeFile(executable, original)
    await fs.mkdir(join(root, 'different-project'))
    await fs.unlink(alias)
    await fs.symlink(join(root, 'different-project'), alias)
    await expect(store.verifyForReuse('stable')).rejects.toThrow('error.runSourceChanged')
    expect(await store.read('stable')).toEqual(manifest)
  })

  it.each(['state', 'native'])('rejects redirected mutable state directories: %s', async (part) => {
    await create('state')
    const state = store.paths('state').state
    const replaced = part === 'state' ? state : join(state, 'native')
    await fs.rename(replaced, join(root, 'external-state'))
    await fs.symlink(join(root, 'external-state'), replaced)
    await expect(store.verifyForReuse('state')).rejects.toThrow('error.runIntegrity')
    expect((await store.read('state')).id).toBe('state')
  })
})
