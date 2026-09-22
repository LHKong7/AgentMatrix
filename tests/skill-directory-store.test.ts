import { createHash } from 'node:crypto'
import * as fs from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SkillDirectoryStore, skillImportLimits } from '../src/main/assets/skill-directory-store'
import { EngineWorkspaceStore } from '../src/main/engine-workspace-store'
import { createLibraryEntry } from '../src/shared/engines/editing'
import { importSkillRevision } from '../src/shared/engines/skill-import'
import type { SkillAsset } from '../src/shared/engines/workspace'

vi.mock('node:fs/promises', async (original) => {
  const actual = await original<typeof import('node:fs/promises')>()
  return { ...actual, open: vi.fn(actual.open) }
})
const actualFs = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')
let root: string
let source: string
let store: SkillDirectoryStore
const instructions =
  '---\nname: example\ndescription: Keep this frontmatter\n---\n\n# Workflow 中文\n'
beforeEach(async () => {
  vi.mocked(fs.open).mockImplementation(actualFs.open)
  root = await fs.mkdtemp(join(tmpdir(), 'agentmatrix-skill-'))
  source = join(root, 'source')
  store = new SkillDirectoryStore(join(root, 'assets'))
  await fs.mkdir(join(source, 'scripts'), { recursive: true })
  await fs.writeFile(join(source, 'SKILL.md'), instructions)
  await fs.writeFile(join(source, 'scripts', 'run.sh'), '#!/bin/sh\nexit 9\n', { mode: 0o755 })
})
afterEach(async () => {
  vi.mocked(fs.open).mockImplementation(actualFs.open)
  await fs.rm(root, { recursive: true, force: true })
})

describe('Skill directory capture', () => {
  it('preserves frontmatter, binary bytes, hidden files, and executable flags without running scripts', async () => {
    const binary = Buffer.from([0, 255, 1, 13, 10])
    await fs.writeFile(join(source, 'reference.bin'), binary)
    await fs.writeFile(join(source, '.metadata'), 'retained')
    const capture = await store.capture(source)
    expect(capture.sourcePath).toBe(await fs.realpath(source))
    expect(capture.snapshot.files.map((file) => file.path)).toEqual([
      '.metadata',
      'SKILL.md',
      'reference.bin',
      'scripts/run.sh',
    ])
    const captured = await store.verify(capture.snapshot)
    expect(await fs.readFile(join(captured, 'SKILL.md'), 'utf8')).toBe(instructions)
    expect(await fs.readFile(join(captured, 'reference.bin'))).toEqual(binary)
    expect(capture.snapshot.files.find((file) => file.path === 'scripts/run.sh')?.executable).toBe(
      true,
    )
    expect(capture.snapshot.digest).toBe(
      createHash('sha256').update(JSON.stringify(capture.snapshot.files)).digest('hex'),
    )
    if (process.platform !== 'win32')
      expect((await fs.stat(join(captured, 'SKILL.md'))).mode & 0o777).toBe(0o600)
  })
  it('deduplicates identical imports, retains old bytes after source edits/deletion, and serializes captures', async () => {
    const [first, repeated] = await Promise.all([store.capture(source), store.capture(source)])
    expect(first).toEqual(repeated)
    expect(await fs.readdir(store.root)).toEqual([first.snapshot.digest])
    await fs.writeFile(join(source, 'SKILL.md'), 'changed content')
    const changed = await store.capture(source)
    expect(changed.snapshot.digest).not.toBe(first.snapshot.digest)
    await fs.rm(source, { recursive: true })
    expect(await fs.readFile(join(await store.verify(first.snapshot), 'SKILL.md'), 'utf8')).toBe(
      instructions,
    )
    expect(await fs.readFile(join(await store.verify(changed.snapshot), 'SKILL.md'), 'utf8')).toBe(
      'changed content',
    )
  })
  it.each(['file', 'directory', 'root'] as const)(
    'rejects a %s symlink without publishing a capture',
    async (kind) => {
      const outside = join(root, 'outside')
      await fs.mkdir(outside)
      await fs.writeFile(join(outside, 'secret'), 'do not read')
      const link = kind === 'root' ? join(root, 'linked-root') : join(source, 'link')
      await fs.symlink(
        kind === 'file' ? join(outside, 'secret') : kind === 'root' ? source : outside,
        link,
        kind === 'file' ? 'file' : 'dir',
      )
      await expect(store.capture(kind === 'root' ? link : source)).rejects.toThrow(
        'error.skillUnsafePath',
      )
      expect(await fs.readdir(store.root).catch(() => [])).toEqual([])
    },
  )
  it.each(['CON.txt', 'bad:name', 'trailing.'])(
    'rejects a nonportable filename: %s',
    async (name) => {
      await fs.writeFile(join(source, name), 'value')
      await expect(store.capture(source)).rejects.toThrow('error.skillUnsafePath')
      expect(await fs.readdir(store.root)).toEqual([])
    },
  )
  it.each([null, '', '   ', Buffer.from([0xff])])(
    'requires a nonempty UTF-8 entry: %s',
    async (content) => {
      if (content === null) await fs.unlink(join(source, 'SKILL.md'))
      else await fs.writeFile(join(source, 'SKILL.md'), content)
      await expect(store.capture(source)).rejects.toThrow('error.skillEntry')
      expect(await fs.readdir(store.root)).toEqual([])
    },
  )
  it('rejects file-size, total-size, file-count, and directory-depth limits before publication', async () => {
    const huge = join(source, 'huge')
    const file = await fs.open(huge, 'w')
    await file.truncate(skillImportLimits.fileBytes + 1)
    await file.close()
    await expect(store.capture(source)).rejects.toThrow('error.skillLimit')
    await fs.unlink(huge)
    for (let index = 0; index < 6; index++) {
      const part = await fs.open(join(source, `part-${index}`), 'w')
      await part.truncate(skillImportLimits.fileBytes)
      await part.close()
    }
    await expect(store.capture(source)).rejects.toThrow('error.skillLimit')
    for (let index = 0; index < 6; index++) await fs.unlink(join(source, `part-${index}`))
    const many = join(source, 'many')
    await fs.mkdir(many)
    for (let index = 0; index < skillImportLimits.files; index++)
      await fs.writeFile(join(many, String(index)), '')
    await expect(store.capture(source)).rejects.toThrow('error.skillLimit')
    await fs.rm(many, { recursive: true })
    await fs.mkdir(join(source, ...Array<string>(skillImportLimits.depth + 1).fill('nested')), {
      recursive: true,
    })
    await expect(store.capture(source)).rejects.toThrow('error.skillLimit')
    expect(await fs.readdir(store.root)).toEqual([])
  })
  it('rejects recursively importing its own store', async () => {
    const nested = new SkillDirectoryStore(join(source, 'captures'))
    await expect(nested.capture(source)).rejects.toThrow('error.skillUnsafePath')
    await expect(store.capture('relative/path')).rejects.toThrow('error.skillUnsafePath')
  })
  it('detects a source edit during copying and cleans partial output', async () => {
    vi.mocked(fs.open).mockImplementation(async (...args) => {
      if (String(args[0]).endsWith('/SKILL.md') && typeof args[1] === 'number')
        await fs.writeFile(join(source, 'scripts/run.sh'), 'changed while importing')
      return actualFs.open(...args)
    })
    await expect(store.capture(source)).rejects.toThrow('error.skillChanged')
    expect(await fs.readdir(store.root)).toEqual([])
  })
  it('does not publish a partial capture after a write failure and permits a retry', async () => {
    vi.mocked(fs.open).mockImplementation(async (...args) => {
      if (String(args[0]).includes('.capture-') && String(args[0]).endsWith('run.sh'))
        throw new Error('disk full')
      return actualFs.open(...args)
    })
    await expect(store.capture(source)).rejects.toThrow('disk full')
    expect(await fs.readdir(store.root)).toEqual([])
    vi.mocked(fs.open).mockImplementation(actualFs.open)
    expect((await store.capture(source)).snapshot.files).toHaveLength(2)
  })
  it.each(['bytes', 'missing', 'manifest', 'extra', 'empty'])(
    'preserves corrupted captures rather than overwriting them: %s',
    async (damage) => {
      const first = await store.capture(source)
      const directory = join(store.root, first.snapshot.digest)
      if (damage === 'bytes') await fs.writeFile(join(directory, 'files/SKILL.md'), 'tampered')
      if (damage === 'missing') await fs.unlink(join(directory, 'files/SKILL.md'))
      if (damage === 'manifest') await fs.writeFile(join(directory, 'manifest.json'), '{}')
      if (damage === 'extra') await fs.writeFile(join(directory, 'files/extra'), 'unlisted')
      if (damage === 'empty') {
        await fs.rm(directory, { recursive: true })
        await fs.mkdir(directory)
      }
      await expect(store.verify(first.snapshot)).rejects.toThrow('error.skillCaptureInvalid')
      await expect(store.capture(source)).rejects.toThrow('error.skillCaptureInvalid')
      expect(await fs.readdir(store.root)).toEqual([first.snapshot.digest])
      if (damage === 'bytes')
        expect(await fs.readFile(join(directory, 'files/SKILL.md'), 'utf8')).toBe('tampered')
      if (damage === 'empty') expect(await fs.readdir(directory)).toEqual([])
    },
  )
  it('verifies new directory revisions before workspace publication and retains history', async () => {
    const workspaces = new EngineWorkspaceStore(join(root, 'workspace.json'), 'en', (snapshot) =>
      store.verify(snapshot),
    )
    const current = await workspaces.load()
    const base = {
      ...createLibraryEntry('skills', 'skill', 'darwin'),
      name: 'Imported Skill',
    } as SkillAsset
    const capture = await store.capture(source)
    const first = importSkillRevision(base, capture, true)
    const saved = await workspaces.save({ ...current, skills: [first] })
    expect(first.versions).toHaveLength(1)
    expect(importSkillRevision(first, capture, false)).toEqual(first)
    await fs.writeFile(join(source, 'SKILL.md'), 'next content')
    const changed = importSkillRevision(first, await store.capture(source), false)
    expect(changed.currentVersion).toBe(2)
    expect(changed.versions[0]).toEqual(first.versions[0])
    const next = await workspaces.save({ ...saved, skills: [changed] })
    const invalid = structuredClone(changed)
    const fake = { ...capture.snapshot, version: 3, digest: 'a'.repeat(64) }
    invalid.versions.push(fake)
    invalid.currentVersion = 3
    await expect(workspaces.save({ ...next, skills: [invalid] })).rejects.toThrow(
      'error.skillCaptureInvalid',
    )
    expect(await workspaces.load()).toEqual(next)
    await expect(
      new EngineWorkspaceStore(join(root, 'no-validator.json')).save({
        ...(await workspaces.load()),
        revision: 0,
      }),
    ).rejects.toThrow('error.skillCaptureInvalid')
  })
})
