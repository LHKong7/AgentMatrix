import {
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  realpath,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { SessionJournal } from '../src/main/sessions/journal'
import { exportSessionHistory } from '../src/main/sessions/history-export'
import { createSessionSnapshot } from '../src/shared/sessions/state'
import { transcriptRows } from '../src/shared/sessions/transcript'
import type { HistoryEvent, SessionHistoryRecord } from '../src/shared/sessions/schema'

const roots: string[] = []
async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'agentmatrix-history-')))
  roots.push(root)
  const data = join(root, 'data')
  const journal = new SessionJournal(join(data, 'sessions'))
  await journal.create(
    createSessionSnapshot({
      id: 's',
      agentId: 'a',
      installationId: 'i',
      engineVersion: '1',
      mode: 'acp',
      cwd: root,
      snapshotId: 'inputs',
      snapshotDigest: '0'.repeat(64),
      createdAt: new Date().toISOString(),
      creationReceipt: { id: 'create', digest: 'c'.repeat(64) },
    }),
  )
  let cursor = 0
  const append = async (data: HistoryEvent['data']) =>
    journal.append('s', cursor++, {
      runId: 'run',
      turnId: data.kind.startsWith('run.') ? null : 'turn',
      data,
      receipt: { id: `receipt-${cursor}`, digest: 'd'.repeat(64) },
    })
  const start = async () => {
    await append({ kind: 'run.starting' })
    await append({ kind: 'run.ready', nativeSessionId: 'native' })
    await append({ kind: 'turn.started', messageId: 'user', text: 'Already redacted [REDACTED]' })
  }
  const delta = (text: string) =>
    append({ kind: 'message.delta', messageId: 'assistant', channel: 'assistant', text })
  return { root, data, journal, start, append, delta }
}
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('bounded session history and export', () => {
  it('reads both directions without gaps and holds the selected boundary across new appends', async () => {
    const f = await fixture()
    await f.start()
    for (let n = 0; n < 240; n++) await f.delta(`fragment-${n} `)
    const throughCursor = (await f.journal.get('s')).cursor
    await f.delta('NEW_EVENT_OUTSIDE_VIEW')
    const collected: number[] = []
    let fromCursor = 1
    for (;;) {
      const page = await f.journal.readHistory({
        sessionId: 's',
        throughCursor,
        fromCursor,
        direction: 'forward',
        limit: 53,
      })
      expect(page.latestCursor).toBe(throughCursor + 1)
      expect(page.events.length).toBeLessThanOrEqual(53)
      expect(page.events.every((event) => !('receipt' in event))).toBe(true)
      collected.push(...page.events.map((event) => event.cursor))
      if (!page.hasLater) break
      fromCursor = page.events.at(-1)!.cursor + 1
    }
    expect(collected).toEqual(Array.from({ length: throughCursor }, (_, index) => index + 1))
    const backwards: number[] = []
    fromCursor = throughCursor
    for (;;) {
      const page = await f.journal.readHistory({
        sessionId: 's',
        throughCursor,
        fromCursor,
        direction: 'backward',
        limit: 47,
      })
      backwards.unshift(...page.events.map((event) => event.cursor))
      if (!page.hasEarlier) break
      fromCursor = page.events[0]!.cursor - 1
    }
    expect(backwards).toEqual(collected)
  })
  it('bounds pages by UTF-8 bytes and keeps message fragments accessible', async () => {
    const f = await fixture()
    await f.start()
    for (let n = 0; n < 12; n++) await f.delta(`${n}:` + '界'.repeat(60_000))
    const throughCursor = (await f.journal.get('s')).cursor
    for (const direction of ['forward', 'backward'] as const) {
      const page = await f.journal.readHistory({
        sessionId: 's',
        throughCursor,
        fromCursor: direction === 'forward' ? 1 : throughCursor,
        direction,
      })
      expect(page.events.length).toBeLessThan(12)
      expect(
        page.events.reduce((bytes, event) => bytes + Buffer.byteLength(JSON.stringify(event)), 0),
      ).toBeLessThanOrEqual(1024 * 1024)
      expect(direction === 'forward' ? page.hasLater : page.hasEarlier).toBe(true)
    }
  })
  it('allows empty history and rejects fabricated cursor ranges without changing the session', async () => {
    const f = await fixture()
    const empty = await f.journal.readHistory({
      sessionId: 's',
      throughCursor: 0,
      fromCursor: 0,
      direction: 'backward',
    })
    expect(empty).toMatchObject({ events: [], hasEarlier: false, hasLater: false })
    await f.start()
    const before = await f.journal.get('s')
    for (const [throughCursor, fromCursor] of [
      [4, 1],
      [3, 4],
      [3, 0],
      [-1, 0],
    ] as const)
      await expect(
        Promise.resolve().then(() =>
          f.journal.readHistory({
            sessionId: 's',
            throughCursor,
            fromCursor,
            direction: 'forward',
          }),
        ),
      ).rejects.toThrow()
    expect(await f.journal.get('s')).toEqual(before)
  })
  it('exports the complete selected prefix, strips command receipts, and preserves stored redaction', async () => {
    const f = await fixture()
    await f.start()
    await f.delta('Unicode 🌿\n<script>literal</script>')
    const boundary = (await f.journal.get('s')).cursor
    await f.delta('OUTSIDE_EXPORT')
    const before = await f.journal.get('s')
    const target = join(f.root, '历史.jsonl')
    await writeFile(target, 'previous export')
    expect(
      await exportSessionHistory(
        f.journal,
        { sessionId: 's', throughCursor: boundary },
        target,
        f.data,
      ),
    ).toEqual({ path: target, throughCursor: boundary, eventCount: boundary })
    const text = await readFile(target, 'utf8')
    const records = text
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line)) as SessionHistoryRecord[]
    expect(records).toHaveLength(boundary + 1)
    expect(records[0]).toMatchObject({
      kind: 'session-history',
      format: 'agentmatrix-session-history',
      version: 1,
      throughCursor: boundary,
    })
    expect(text).toContain('[REDACTED]')
    expect(text).not.toContain('OUTSIDE_EXPORT')
    expect(text).not.toContain('receipt')
    expect(text).not.toContain('snapshotDigest')
    expect(await f.journal.get('s')).toEqual(before)
  })
  it('preserves the destination and removes staged output on a read failure or destination change', async () => {
    const f = await fixture()
    await f.start()
    const target = join(f.root, 'history.jsonl')
    await writeFile(target, 'previous')
    const query = { sessionId: 's', throughCursor: 3 }
    const broken = {
      writeHistory: async (...args: Parameters<SessionJournal['writeHistory']>) => {
        await f.journal.writeHistory(...args)
        throw new Error('injected read failure')
      },
    }
    await expect(exportSessionHistory(broken, query, target, f.data)).rejects.toThrow()
    expect(await readFile(target, 'utf8')).toBe('previous')
    const changed = {
      writeHistory: async (...args: Parameters<SessionJournal['writeHistory']>) => {
        const result = await f.journal.writeHistory(...args)
        await writeFile(target, 'concurrent edit')
        return result
      },
    }
    await expect(exportSessionHistory(changed, query, target, f.data)).rejects.toThrow(
      'historyExportChanged',
    )
    expect(await readFile(target, 'utf8')).toBe('concurrent edit')
    expect((await readdir(f.root)).some((name) => name.endsWith('.tmp'))).toBe(false)
  })
  it('refuses app-owned destinations and non-regular files, including directory aliases', async () => {
    const f = await fixture()
    const query = { sessionId: 's', throughCursor: 0 }
    await expect(
      exportSessionHistory(f.journal, query, join(f.data, 'workspace.json'), f.data),
    ).rejects.toThrow('historyExportProtected')
    const target = join(f.root, 'directory')
    await mkdir(target)
    await expect(exportSessionHistory(f.journal, query, target, f.data)).rejects.toThrow(
      'historyExport',
    )
    if (process.platform !== 'win32') {
      const alias = join(f.root, 'alias')
      await symlink(f.data, alias)
      await expect(
        exportSessionHistory(f.journal, query, join(alias, 'secrets.json'), f.data),
      ).rejects.toThrow('historyExportProtected')
      const link = join(f.root, 'link')
      await writeFile(join(f.root, 'original'), 'keep')
      await symlink(join(f.root, 'original'), link)
      await expect(exportSessionHistory(f.journal, query, link, f.data)).rejects.toThrow(
        'historyExport',
      )
      expect(await readFile(link, 'utf8')).toBe('keep')
    }
  })
  it('keeps message channels and attachments distinct and exposes historical lifecycle events without controls', () => {
    const base = { sessionId: 's', timestamp: new Date().toISOString(), runId: 'r', turnId: 't' }
    const events: HistoryEvent[] = [
      {
        ...base,
        cursor: 1,
        data: { kind: 'message.delta', messageId: 'm', channel: 'assistant', text: 'A' },
      },
      {
        ...base,
        cursor: 2,
        data: { kind: 'message.delta', messageId: 'm', channel: 'reasoning', text: 'think' },
      },
      {
        ...base,
        cursor: 3,
        data: { kind: 'message.delta', messageId: 'm', channel: 'assistant', text: 'B' },
      },
      {
        ...base,
        cursor: 4,
        runId: 'other',
        data: { kind: 'message.delta', messageId: 'm', channel: 'assistant', text: 'C' },
      },
      {
        ...base,
        cursor: 5,
        data: { kind: 'interaction.resolved', requestId: 'request', disposition: 'answered' },
      },
    ]
    expect(transcriptRows(events).map((row) => row.data)).toEqual([
      { kind: 'message.delta', messageId: 'm', channel: 'assistant', text: 'AB' },
      events[1]!.data,
      events[3]!.data,
    ])
    expect(transcriptRows(events, true).at(-1)?.data.kind).toBe('interaction.resolved')
    expect(events[0]!.data).toHaveProperty('text', 'A')
  })
})
