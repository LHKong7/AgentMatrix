import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { WorkspaceStore } from '../src/main/workspace-store'

let directory: string
let store: WorkspaceStore
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'agent-matrix-store-'))
  store = new WorkspaceStore(join(directory, 'workspace.json'))
})
afterEach(async () => {
  await rm(directory, { recursive: true, force: true })
})

describe('desktop persistence', () => {
  it('creates a workspace, persists changes and reads them from a new instance', async () => {
    const state = await store.load()
    state.agents[0]!.name = 'Research assistant'
    const saved = await store.save(state)
    expect(saved.revision).toBe(1)
    expect(await new WorkspaceStore(store.filePath).load()).toEqual(saved)
    expect(await readdir(directory)).toEqual(['workspace.json'])
  })
  it('rejects invalid writes without changing the existing file', async () => {
    const state = await store.load()
    const before = await readFile(store.filePath, 'utf8')
    state.agents[0]!.pluginIds = ['missing']
    await expect(store.save(state)).rejects.toThrow()
    expect(await readFile(store.filePath, 'utf8')).toBe(before)
  })
  it('serializes concurrent saves and rejects stale revisions', async () => {
    const state = await store.load()
    const results = await Promise.allSettled([store.save(state), store.save(state)])
    expect(results.map((result) => result.status)).toEqual(['fulfilled', 'rejected'])
    const latest = await store.load()
    await expect(store.save(latest)).resolves.toMatchObject({ revision: 2 })
  })
  it.each(['not json', '{"schemaVersion": 2}', '{"schemaVersion":1}'])(
    'preserves unreadable or unsupported data: %s',
    async (contents) => {
      await writeFile(store.filePath, contents)
      await expect(store.load()).rejects.toThrow('error.unreadable')
      expect(await readFile(store.filePath, 'utf8')).toBe(contents)
    },
  )
})
