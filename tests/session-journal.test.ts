import { afterEach, describe, expect, it } from 'vitest'
import { createHash } from 'node:crypto'
import {
  appendFile,
  link,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SessionJournal } from '../src/main/sessions/journal'
import { createSessionSnapshot } from '../src/shared/sessions/state'
import type { SessionEventData } from '../src/shared/sessions/schema'

const directories: string[] = []
const date = '2026-09-18T00:00:00Z'
async function fixture(maxBytes?: number) {
  const directory = await mkdtemp(join(tmpdir(), 'agentmatrix-session-'))
  directories.push(directory)
  const journal = new SessionJournal(directory, () => date, maxBytes)
  const initial = createSessionSnapshot({
    id: 's',
    agentId: 'agent',
    installationId: 'installation',
    engineVersion: '1',
    mode: 'acp',
    cwd: '/project',
    snapshotId: 'snapshot',
    snapshotDigest: 'c'.repeat(64),
    createdAt: date,
  })
  await journal.create(initial)
  return { directory, journal, initial, path: join(directory, 's.jsonl') }
}
async function start(journal: SessionJournal) {
  await journal.append('s', 0, { runId: 'run', turnId: null, data: { kind: 'run.starting' } })
  await journal.append('s', 1, {
    runId: 'run',
    turnId: null,
    data: { kind: 'run.ready', nativeSessionId: 'native/session' },
  })
  await journal.append('s', 2, {
    runId: 'run',
    turnId: 'turn',
    data: { kind: 'turn.started', messageId: 'user', text: 'Inspect files' },
  })
}
function delta(text: string) {
  return {
    runId: 'run',
    turnId: 'turn',
    data: {
      kind: 'message.delta',
      messageId: 'assistant',
      channel: 'assistant',
      text,
    } as SessionEventData,
  }
}
afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  )
})

describe('durable session journal', () => {
  it('indexes durable command receipts across restart and rejects duplicate receipts in valid event sequences', async () => {
    const { journal, directory, path } = await fixture()
    const receipt = { id: 'start-command', digest: 'b'.repeat(64) }
    await journal.append('s', 0, {
      runId: 'run',
      turnId: null,
      receipt,
      data: { kind: 'run.starting' },
    })
    await expect(
      journal.append('s', 1, {
        runId: 'run',
        turnId: null,
        receipt,
        data: { kind: 'run.ready', nativeSessionId: 'native' },
      }),
    ).rejects.toThrow('sessionCommandConflict')
    await journal.append('s', 1, {
      runId: 'run',
      turnId: null,
      data: { kind: 'run.ready', nativeSessionId: 'native' },
    })
    const restarted = new SessionJournal(directory, () => date)
    expect(await restarted.receipt('s', receipt.id)).toEqual({ ...receipt, cursor: 1 })
    const snapshot = await restarted.get('s')
    const forged = {
      kind: 'event',
      event: {
        sessionId: 's',
        cursor: snapshot.cursor + 1,
        timestamp: date,
        runId: 'next-run',
        turnId: null,
        receipt,
        data: { kind: 'run.resuming' },
      },
    }
    await appendFile(path, JSON.stringify(forged) + '\n')
    const original = await readFile(path)
    await expect(new SessionJournal(directory).get('s')).rejects.toThrow('sessionStorage')
    expect(await readFile(path)).toEqual(original)
  })

  it('stores strict LF frames, preserves split UTF-8 and Unicode separators, and pages the full history', async () => {
    const { journal, path } = await fixture()
    await start(journal)
    const text = `${'汉🙂'.repeat(20_000)}\u2028line\u2029paragraph`
    await journal.append('s', 3, delta(text))
    expect((await journal.get('s')).cursor).toBe(4)
    const first = await journal.readEvents({ sessionId: 's', afterCursor: 0, limit: 2 })
    expect(first).toMatchObject({ nextCursor: 2, latestCursor: 4, hasMore: true })
    const second = await journal.readEvents({ sessionId: 's', afterCursor: first.nextCursor })
    expect(second).toMatchObject({ nextCursor: 4, hasMore: false })
    expect(second.events[1]?.data).toMatchObject({ text })
    expect((await readFile(path, 'utf8')).split('\n')).toHaveLength(6)
    expect((await stat(path)).mode & 0o777).toBe(0o600)
  })

  it('marks lost attachments interrupted once after restart and clears stale approval controls', async () => {
    const { journal, directory, initial } = await fixture()
    await start(journal)
    await journal.append('s', 3, {
      runId: 'run',
      turnId: 'turn',
      data: {
        kind: 'interaction.requested',
        request: {
          kind: 'confirm',
          id: 'approval',
          title: 'Continue?',
          message: '',
          deadlineAt: null,
        },
      },
    })
    const reopened = new SessionJournal(directory, () => date)
    const recovered = await reopened.get('s')
    expect(recovered).toMatchObject({
      cursor: 5,
      status: 'interrupted',
      nativeSessionId: 'native/session',
      activeTurn: null,
      pendingRequests: [],
      lastTurn: { outcome: 'interrupted' },
      snapshotDigest: initial.snapshotDigest,
    })
    expect(
      (await reopened.readEvents({ sessionId: 's', afterCursor: 4 })).events[0]?.data,
    ).toMatchObject({ kind: 'run.interrupted' })
    expect((await new SessionJournal(directory).get('s')).cursor).toBe(5)
  })

  it('preserves a torn final frame before repair and does not repeat recovery on another restart', async () => {
    const { journal, directory, path } = await fixture()
    await start(journal)
    const tail = Buffer.concat([Buffer.from('{"kind":"event","text":"'), Buffer.from([0xe4, 0xb8])])
    await appendFile(path, tail)
    const restarted = new SessionJournal(directory, () => date)
    expect((await restarted.get('s')).status).toBe('interrupted')
    const backups = (await readdir(directory)).filter((name) => name.endsWith('.partial'))
    expect(backups).toHaveLength(1)
    expect(await readFile(join(directory, backups[0]!))).toEqual(tail)
    const repaired = await readFile(path)
    expect(repaired.at(-1)).toBe(0x0a)
    expect((await new SessionJournal(directory).get('s')).cursor).toBe(4)
    expect(await readFile(path)).toEqual(repaired)
  })

  it('rejects complete malformed frames and future formats without altering the original history', async () => {
    const { directory, path } = await fixture()
    const original = await readFile(path)
    const broken = Buffer.concat([original, Buffer.from('{not-json}\n')])
    await writeFile(path, broken)
    await expect(new SessionJournal(directory).get('s')).rejects.toThrow('sessionStorage')
    expect(await readFile(path)).toEqual(broken)
    const header = JSON.parse(original.toString().trim())
    header.version = 2
    const future = Buffer.from(`${JSON.stringify(header)}\n`)
    await writeFile(path, future)
    await expect(new SessionJournal(directory).get('s')).rejects.toThrow('sessionStorage')
    expect(await readFile(path)).toEqual(future)
  })

  it('preserves a torn journal if its recovery backup conflicts instead of truncating first', async () => {
    const { directory, path } = await fixture()
    const tail = Buffer.from('{"unfinished":')
    await appendFile(path, tail)
    const digest = createHash('sha256').update(tail).digest('hex')
    const backup = `${path}.${digest}.partial`
    await writeFile(backup, 'conflicting recovery bytes')
    const original = await readFile(path)
    await expect(new SessionJournal(directory).get('s')).rejects.toThrow('sessionStorage')
    expect(await readFile(path)).toEqual(original)
    expect(await readFile(backup, 'utf8')).toBe('conflicting recovery bytes')
  })

  it('rejects invalid UTF-8 in a complete frame rather than replacing the damaged text', async () => {
    const { directory, path } = await fixture()
    const original = await readFile(path)
    const damaged = Buffer.concat([
      original,
      Buffer.from('{"kind":"event","text":"'),
      Buffer.from([0xff]),
      Buffer.from('"}\n'),
    ])
    await writeFile(path, damaged)
    await expect(new SessionJournal(directory).get('s')).rejects.toThrow('sessionStorage')
    expect(await readFile(path)).toEqual(damaged)
  })

  it('rejects duplicate or out-of-order persisted cursors instead of deduplicating corrupt storage', async () => {
    const { journal, directory, path } = await fixture()
    await start(journal)
    const original = await readFile(path, 'utf8')
    const event = JSON.parse(original.trim().split('\n').at(-1)!)
    const damaged = `${original}${JSON.stringify(event)}\n`
    await writeFile(path, damaged)
    await expect(new SessionJournal(directory).get('s')).rejects.toThrow('sessionStorage')
    expect(await readFile(path, 'utf8')).toBe(damaged)
  })

  it('serializes concurrent submissions, rejects a stale writer, and captures inputs before waiting', async () => {
    const { journal, path } = await fixture()
    const input = { runId: 'run', turnId: null, data: { kind: 'run.starting' } as SessionEventData }
    const first = journal.append('s', 0, input)
    const second = journal.append('s', 0, { ...input, runId: 'other' })
    input.runId = 'mutated'
    const results = await Promise.allSettled([first, second])
    expect(results.map((result) => result.status)).toEqual(['fulfilled', 'rejected'])
    expect(await journal.get('s')).toMatchObject({ status: 'starting', runId: 'run', cursor: 1 })
    expect((await readFile(path, 'utf8')).trim().split('\n')).toHaveLength(2)
  })

  it('keeps closed sessions terminal and permits full history after a restart', async () => {
    const { journal, directory } = await fixture()
    await start(journal)
    await journal.append('s', 3, { runId: 'run', turnId: null, data: { kind: 'session.closing' } })
    await journal.append('s', 4, { runId: 'run', turnId: null, data: { kind: 'session.closed' } })
    const reopened = new SessionJournal(directory)
    expect(await reopened.list()).toMatchObject([{ status: 'closed', cursor: 5 }])
    expect((await reopened.readEvents({ sessionId: 's', afterCursor: 0 })).events).toHaveLength(5)
  })

  it('preserves an existing session on duplicate creation and rejects traversal IDs', async () => {
    const { journal, initial, path } = await fixture()
    const before = await readFile(path)
    await expect(journal.create(initial)).rejects.toThrow('sessionExists')
    expect(await readFile(path)).toEqual(before)
    await expect(journal.get('../s')).rejects.toThrow()
    await expect(journal.get('missing')).rejects.toThrow('sessionMissing')
    expect((await journal.get('s')).status).toBe('created')
  })

  it('detects external edits during a live process without silently repairing or accepting them', async () => {
    const { journal, path } = await fixture()
    await appendFile(path, 'external edit')
    const edited = await readFile(path)
    await expect(journal.get('s')).rejects.toThrow('sessionStorage')
    await expect(
      journal.append('s', 0, { runId: 'r', turnId: null, data: { kind: 'run.starting' } }),
    ).rejects.toThrow('sessionStorage')
    expect(await readFile(path)).toEqual(edited)
  })

  it('rejects symlinked and hard-linked journal files', async () => {
    const { directory, path } = await fixture()
    await symlink(path, join(directory, 'symlink.jsonl'))
    await expect(new SessionJournal(directory).get('symlink')).rejects.toThrow('sessionStorage')
    await link(path, join(directory, 'hardlink.jsonl'))
    await expect(new SessionJournal(directory).get('s')).rejects.toThrow('sessionStorage')
  })

  it('reserves room for interruption recovery when event storage reaches its bound', async () => {
    const { journal, directory, path } = await fixture(8192)
    await start(journal)
    let cursor = 3
    for (;;) {
      try {
        await journal.append('s', cursor, delta('x'.repeat(1000)))
        cursor++
      } catch (error) {
        expect(String(error)).toContain('sessionJournalFull')
        break
      }
    }
    const before = await readFile(path)
    await expect(journal.append('s', cursor, delta('x'.repeat(1000)))).rejects.toThrow(
      'sessionJournalFull',
    )
    expect(await readFile(path)).toEqual(before)
    expect(await new SessionJournal(directory, () => date, 8192).get('s')).toMatchObject({
      status: 'interrupted',
      cursor: cursor + 1,
    })
    expect((await stat(path)).size).toBeLessThanOrEqual(8192)
  })
})
