import { createHash } from 'node:crypto'
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { EngineWorkspaceStore } from '../src/main/engine-workspace-store'
import { createWorkspace } from '../src/shared/workspace'
import { fingerprintFor } from '../src/shared/engines/evidence'

let root: string
let store: EngineWorkspaceStore
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'agentmatrix-v2-store-'))
  store = new EngineWorkspaceStore(join(root, 'workspace.json'))
})
afterEach(() => rm(root, { recursive: true, force: true }))

describe('schema v2 storage and migration', () => {
  it('preserves invalid UTF-8 instead of migrating replacement characters', async () => {
    const contents = Buffer.from(JSON.stringify(createWorkspace()))
    const offset = contents.indexOf(Buffer.from('General assistant'))
    expect(offset).toBeGreaterThan(0)
    contents[offset] = 0xff
    await writeFile(store.filePath, contents)
    await expect(store.load()).rejects.toThrow('error.unreadable')
    expect(await readFile(store.filePath)).toEqual(contents)
    expect(await readdir(root)).toEqual(['workspace.json'])
  })
  it('backs up original v1 bytes before publication and does not repeat migration', async () => {
    const original = JSON.stringify(createWorkspace('zh-CN'), null, 4) + '\n'
    await writeFile(store.filePath, original)
    const state = await store.load()
    expect(state.schemaVersion).toBe(2)
    const backups = (await readdir(root)).filter((file) => file.endsWith('.bak'))
    expect(backups).toHaveLength(1)
    expect(await readFile(join(root, backups[0]!), 'utf8')).toBe(original)
    expect(await new EngineWorkspaceStore(store.filePath).load()).toEqual(state)
    expect((await readdir(root)).sort()).toEqual(['workspace.json', ...backups].sort())
    expect(state.agents[0]!.engineInstallationId).toBeNull()
  })
  it('recovers a migration with an already-created backup without overwriting it', async () => {
    const original = JSON.stringify(createWorkspace())
    const backup = `${store.filePath}.v1.${createHash('sha256').update(original).digest('hex')}.bak`
    await writeFile(store.filePath, original)
    await writeFile(backup, original)
    expect((await store.load()).schemaVersion).toBe(2)
    expect(await readFile(backup, 'utf8')).toBe(original)
  })
  it('refuses a conflicting backup and leaves both original and conflicting file intact', async () => {
    const original = JSON.stringify(createWorkspace())
    const backup = `${store.filePath}.v1.${createHash('sha256').update(original).digest('hex')}.bak`
    await writeFile(store.filePath, original)
    await writeFile(backup, 'conflicting bytes')
    await expect(store.load()).rejects.toThrow('error.migrationBackup')
    expect(await readFile(store.filePath, 'utf8')).toBe(original)
    expect(await readFile(backup, 'utf8')).toBe('conflicting bytes')
  })
  it.each(['broken', '{"schemaVersion":3}', '{"schemaVersion":2}'])(
    'preserves unreadable/future documents: %s',
    async (contents) => {
      await writeFile(store.filePath, contents)
      await expect(store.load()).rejects.toThrow('error.unreadable')
      expect(await readFile(store.filePath, 'utf8')).toBe(contents)
      expect(await readdir(root)).toEqual(['workspace.json'])
    },
  )
  it('rejects stale writes and changes to prior asset revisions while allowing new revisions', async () => {
    const state = await store.load()
    const attempts = await Promise.allSettled([store.save(state), store.save(state)])
    expect(attempts.map((result) => result.status)).toEqual(['fulfilled', 'rejected'])
    const current = await store.load()
    const before = await readFile(store.filePath, 'utf8')
    const modified = structuredClone(current)
    modified.prompts[0]!.versions[0]!.content = 'Rewritten history'
    await expect(store.save(modified)).rejects.toThrow('error.assetHistory')
    expect(await readFile(store.filePath, 'utf8')).toBe(before)
    current.prompts[0]!.versions.push({ version: 2, content: 'New revision' })
    current.prompts[0]!.currentVersion = 2
    const saved = await store.save(current)
    expect(saved.prompts[0]!.versions).toHaveLength(2)
    expect(saved.revision).toBe(2)
    expect((await readdir(root)).some((file) => file.endsWith('.tmp'))).toBe(false)
  })

  it('files an observation without an edit, and drops one the workspace has moved past', async () => {
    const initial = await store.load()
    const state = structuredClone(initial)
    state.installations.push({
      id: 'oc',
      name: 'OpenCode',
      kind: 'opencode',
      executable: '/opt/bin/opencode',
      prefixArgs: [],
      platform: 'darwin',
      version: '1.18.16',
      modes: ['acp'],
      probedAt: '2026-09-22T00:00:00.000Z',
    })
    const saved = await store.save(state)
    const subject = { kind: 'installation', id: 'oc' } as const
    const fingerprint = fingerprintFor(saved, subject)!
    await store.observe({
      subject,
      kind: 'discovered',
      result: 'pass',
      fingerprint,
      adapterVersion: 'opencode-acp@1+1.18.16',
    })
    const observed = await store.load()
    expect(observed.evidence.map((record) => [record.subject.id, record.kind])).toEqual([
      ['oc', 'discovered'],
    ])
    // Nobody edited anything, so an editor holding the saved revision can still save.
    expect(observed.revision).toBe(saved.revision)
    // A save prepared before the observation keeps it; the subject is still there.
    const later = await store.save({ ...saved, revision: observed.revision })
    expect(later.evidence).toHaveLength(1)
    // The same observation no longer applies once the engine it was about changes.
    const moved = structuredClone(later)
    moved.installations[0]!.executable = '/opt/bin/opencode-next'
    const afterChange = await store.save(moved)
    await store.observe({
      subject,
      kind: 'connection-tested',
      result: 'pass',
      fingerprint,
      adapterVersion: 'opencode-acp@1+1.18.16',
    })
    expect((await store.load()).evidence.map((record) => record.kind)).toEqual(['discovered'])
    // Removing the subject takes its records with it, even from a save that still lists them.
    const removed = { ...afterChange, installations: [], evidence: [] }
    expect((await store.save(removed)).evidence).toEqual([])
  })
})
