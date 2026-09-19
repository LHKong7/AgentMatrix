import { mkdtemp, readFile, readdir, rename, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { SessionJournal } from '../src/main/sessions/journal'
import { SessionCoordinator, type SessionRuntimeFactory } from '../src/main/sessions/coordinator'
import { createSessionSnapshot } from '../src/shared/sessions/state'

const roots: string[] = []
const date = '2026-09-19T00:00:00Z'
const identity = {
  agentId: 'profile',
  installationId: 'installed',
  engineVersion: '1',
  mode: 'acp' as const,
  cwd: '/project',
  snapshotId: 'capture',
  snapshotDigest: 'a'.repeat(64),
}
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'agentmatrix-retention-'))
  roots.push(root)
  return { root, journal: new SessionJournal(root) }
}
async function create(journal: SessionJournal, id = 's') {
  const initial = createSessionSnapshot({ ...identity, id, createdAt: date })
  await journal.create(initial)
  return initial
}
async function close(journal: SessionJournal, id = 's') {
  await journal.append(id, 0, { runId: null, turnId: null, data: { kind: 'session.closing' } })
  await journal.append(id, 1, { runId: null, turnId: null, data: { kind: 'session.closed' } })
  return { sessionId: id, expectedCursor: 2 }
}
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('explicit session retention', () => {
  it('requires a closed session and its exact durable cursor before committing deletion', async () => {
    const { root, journal } = await fixture()
    await create(journal)
    const release = vi.fn(async () => {})
    await expect(journal.remove({ sessionId: 's', expectedCursor: 0 }, release)).rejects.toThrow(
      'sessionState',
    )
    await close(journal)
    await expect(journal.remove({ sessionId: 's', expectedCursor: 1 }, release)).rejects.toThrow(
      'sessionCursor',
    )
    expect(await readdir(root)).toEqual(['s.jsonl'])
    expect(release).not.toHaveBeenCalled()
  })

  it('retains shared captures until their last conversation is removed', async () => {
    const { journal } = await fixture()
    await create(journal)
    await create(journal, 'other')
    const release = vi.fn(async () => {})
    await journal.remove(await close(journal), release)
    expect(release).not.toHaveBeenCalled()
    expect((await journal.list()).map((item) => item.id)).toEqual(['other'])
    await journal.remove(await close(journal, 'other'), release)
    expect(release).toHaveBeenCalledExactlyOnceWith('capture')
    expect(await journal.list()).toEqual([])
  })

  it('keeps a durable pending receipt, retries after restart, and cannot resurrect a deleted create', async () => {
    const { root, journal } = await fixture()
    const initial = await create(journal)
    const input = await close(journal)
    await expect(
      journal.remove(input, async () => {
        throw new Error('disk unavailable')
      }),
    ).rejects.toThrow('sessionCleanup')
    expect(await journal.pendingRemovals()).toEqual([input])
    expect(await journal.list()).toEqual([])
    await expect(journal.get('s')).rejects.toThrow('sessionDeleted')
    await expect(journal.readEvents({ sessionId: 's', afterCursor: 0 })).rejects.toThrow(
      'sessionDeleted',
    )
    await expect(
      journal.append('s', 2, { runId: null, turnId: null, data: { kind: 'session.closed' } }),
    ).rejects.toThrow('sessionDeleted')
    await expect(journal.create(initial)).rejects.toThrow('sessionDeleted')
    expect(await readFile(join(root, 's.jsonl'), 'utf8')).toContain('session.closed')
    const restarted = new SessionJournal(root)
    const release = vi.fn(async () => {})
    await expect(restarted.remove({ ...input, expectedCursor: 1 }, release)).rejects.toThrow(
      'sessionCursor',
    )
    await restarted.remove(input, release)
    await restarted.remove(input, release)
    expect(release).toHaveBeenCalledExactlyOnceWith('capture')
    expect(await restarted.pendingRemovals()).toEqual([])
    expect(await readdir(root)).toEqual(['.deleted-s.json'])
    const receipt = JSON.parse(await readFile(join(root, '.deleted-s.json'), 'utf8'))
    expect(receipt).toEqual({ ...input, version: 1, snapshotId: 'capture' })
    await expect(restarted.create(initial)).rejects.toThrow('sessionDeleted')
  })

  it('recovers cleanup that stopped after journal unlink but before marking completion', async () => {
    const { root, journal } = await fixture()
    await create(journal)
    const input = await close(journal)
    await journal.remove(input, async () => {})
    await rename(join(root, '.deleted-s.json'), join(root, '.deleting-s.json'))
    const restarted = new SessionJournal(root)
    const release = vi.fn(async () => {})
    expect(await restarted.pendingRemovals()).toEqual([input])
    await restarted.remove(input, release)
    expect(release).toHaveBeenCalledWith('capture')
    expect(await restarted.pendingRemovals()).toEqual([])
  })

  it('fails closed when another journal cannot be read, including during a pending retry', async () => {
    const { root, journal } = await fixture()
    await create(journal)
    const input = await close(journal)
    await writeFile(join(root, 'unreadable.jsonl'), 'not a journal\n')
    const release = vi.fn(async () => {})
    await expect(journal.remove(input, release)).rejects.toThrow('sessionStorage')
    expect(await journal.pendingRemovals()).toEqual([])
    await rm(join(root, 'unreadable.jsonl'))
    await expect(
      journal.remove(input, async () => {
        throw new Error('failure')
      }),
    ).rejects.toThrow()
    await writeFile(join(root, 'unreadable.jsonl'), 'not a journal\n')
    await expect(new SessionJournal(root).remove(input, release)).rejects.toThrow('sessionStorage')
    expect(release).not.toHaveBeenCalled()
    expect(await journal.pendingRemovals()).toEqual([input])
  })

  it('removes exact torn-frame backups while preserving exports and unrelated files', async () => {
    const { root, journal } = await fixture()
    await create(journal)
    const input = await close(journal)
    await writeFile(join(root, `s.jsonl.${'a'.repeat(64)}.partial`), 'sensitive tail')
    await writeFile(join(root, 'exported-history.json'), 'exported copy')
    await writeFile(join(root, 'other.jsonl.partial'), 'unrelated')
    await journal.remove(input, async () => {})
    expect(await readdir(root)).toEqual([
      '.deleted-s.json',
      'exported-history.json',
      'other.jsonl.partial',
    ])
  })

  it('rejects unsafe input, symlinked receipts and receipts with mismatched identities', async () => {
    const { root, journal } = await fixture()
    await create(journal)
    const input = await close(journal)
    const release = vi.fn(async () => {})
    expect(() => journal.remove({ ...input, sessionId: '../outside' }, release)).toThrow()
    expect(() => journal.remove({ ...input, path: '/outside' } as typeof input, release)).toThrow()
    const outside = join(root, 'outside')
    await writeFile(outside, JSON.stringify({ ...input, snapshotId: 'capture', version: 1 }))
    await symlink(outside, join(root, '.deleting-s.json'))
    await expect(journal.remove(input, release)).rejects.toThrow('sessionStorage')
    await rm(join(root, '.deleting-s.json'))
    await writeFile(
      join(root, '.deleting-s.json'),
      JSON.stringify({ ...input, sessionId: 'other', snapshotId: 'capture', version: 1 }),
    )
    await expect(journal.pendingRemovals()).rejects.toThrow('sessionStorage')
    expect(release).not.toHaveBeenCalled()
    expect(await readFile(outside, 'utf8')).toContain('capture')
  })

  it('serializes new capture publication with deletion reference checks', async () => {
    const { journal } = await fixture()
    await create(journal)
    const input = await close(journal)
    let finish!: () => void
    const captured = new Promise<void>((resolve) => {
      finish = resolve
    })
    const factory: SessionRuntimeFactory = {
      create: vi.fn(async () => {
        await captured
        return identity
      }),
      connect: vi.fn(),
      removeSnapshot: vi.fn(async () => {}),
    }
    const coordinator = new SessionCoordinator(journal, factory)
    const creation = coordinator.command({ kind: 'create', commandId: 'new', agentId: 'profile' })
    await vi.waitFor(() => expect(factory.create).toHaveBeenCalled())
    const deletion = coordinator.remove(input)
    expect(factory.removeSnapshot).not.toHaveBeenCalled()
    finish()
    const other = await creation
    await deletion
    expect(factory.removeSnapshot).not.toHaveBeenCalled()
    await coordinator.command({
      kind: 'close',
      commandId: 'close',
      sessionId: other.id,
      runId: null,
    })
    const closed = await coordinator.get({ sessionId: other.id })
    await coordinator.remove({ sessionId: other.id, expectedCursor: closed.cursor })
    expect(factory.removeSnapshot).toHaveBeenCalledExactlyOnceWith('capture')
    await expect(
      coordinator.command({ kind: 'create', commandId: 'new', agentId: 'profile' }),
    ).rejects.toThrow('sessionDeleted')
    expect(factory.create).toHaveBeenCalledTimes(1)
    await coordinator.shutdown()
  })
})
