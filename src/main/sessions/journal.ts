import { createHash, randomUUID } from 'node:crypto'
import { constants, type Stats } from 'node:fs'
import { link, mkdir, open, readdir, rename, unlink, type FileHandle } from 'node:fs/promises'
import { join } from 'node:path'
import { z } from 'zod'
import { entityId } from '../../shared/engines/schema'
import { appError } from '../../shared/errors'
import { applySessionEvent } from '../../shared/sessions/state'
import {
  sessionCursorSchema,
  sessionEventQuerySchema,
  sessionEventSchema,
  sessionSnapshotSchema,
  type CommandReceipt,
  type SessionEvent,
  type SessionEventPage,
  type SessionSnapshot,
  sessionHistoryQuerySchema,
  sessionExportQuerySchema,
  type HistoryEvent,
  type SessionHistoryPage,
  type SessionHistoryRecord,
  sessionRemovalSchema,
  type SessionRemoval,
} from '../../shared/sessions/schema'

const recordSchema = z.discriminatedUnion('kind', [
  z
    .object({ kind: z.literal('session'), version: z.literal(1), snapshot: sessionSnapshotSchema })
    .strict(),
  z.object({ kind: z.literal('event'), event: sessionEventSchema }).strict(),
])
const appendSchema = sessionEventSchema.omit({ sessionId: true, cursor: true, timestamp: true })
const removalSchema = sessionRemovalSchema
  .extend({
    version: z.literal(1),
    snapshotId: entityId,
  })
  .strict()
const maxRecordBytes = 1024 * 1024
const decoder = new TextDecoder('utf-8', { fatal: true })
const historyPageBytes = 1024 * 1024
const historyEvent = ({
  sessionId,
  cursor,
  timestamp,
  runId,
  turnId,
  data,
}: SessionEvent): HistoryEvent => ({ sessionId, cursor, timestamp, runId, turnId, data })
const runningStates = new Set([
  'starting',
  'resuming',
  'ready',
  'running',
  'waiting',
  'cancelling',
  'closing',
])
const fingerprint = (info: Stats) =>
  `${info.dev}:${info.ino}:${info.size}:${info.mtimeMs}:${info.ctimeMs}`
const isCode = (error: unknown, code: string) =>
  error instanceof Error && 'code' in error && error.code === code

interface LoadedSession {
  snapshot: SessionSnapshot
  fingerprint: string
  bytes: number
  receipts: Map<string, CommandReceipt & { cursor: number }>
}

/** One instance per application process; all operations are serialized, including replay and repair. */
export class SessionJournal {
  private queue: Promise<unknown> = Promise.resolve()
  private sessions = new Map<string, LoadedSession>()
  private readonly maxBytes: number

  constructor(
    readonly directory: string,
    private readonly now: () => string = () => new Date().toISOString(),
    maxBytes = 256 * 1024 * 1024,
  ) {
    this.maxBytes = z.number().int().min(8192).max(Number.MAX_SAFE_INTEGER).parse(maxBytes)
  }

  create(input: SessionSnapshot): Promise<SessionSnapshot> {
    const snapshot = sessionSnapshotSchema.parse(input)
    return this.serial(async () => {
      if (await this.removal(snapshot.id)) throw appError('error.sessionDeleted')
      if (
        snapshot.status !== 'created' ||
        snapshot.cursor !== 0 ||
        snapshot.runId ||
        snapshot.nativeSessionId
      )
        throw appError('error.sessionState')
      await mkdir(this.directory, { recursive: true, mode: 0o700 })
      const bytes = this.encode({ kind: 'session', version: 1, snapshot })
      if (bytes.length > this.maxBytes) throw appError('error.sessionJournalFull')
      const path = this.path(snapshot.id)
      try {
        await this.publishExclusive(path, bytes)
      } catch (error) {
        if (isCode(error, 'EEXIST')) throw appError('error.sessionExists')
        throw appError('error.sessionStorage')
      }
      const info = await this.fileInfo(path)
      this.sessions.set(snapshot.id, {
        snapshot,
        fingerprint: fingerprint(info),
        bytes: info.size,
        receipts: new Map(
          snapshot.creationReceipt
            ? [[snapshot.creationReceipt.id, { ...snapshot.creationReceipt, cursor: 0 }]]
            : [],
        ),
      })
      return structuredClone(snapshot)
    })
  }

  get(sessionId: string): Promise<SessionSnapshot> {
    return this.serial(async () => structuredClone((await this.load(sessionId)).snapshot))
  }

  receipt(
    sessionId: string,
    commandId: string,
  ): Promise<(CommandReceipt & { cursor: number }) | null> {
    const id = entityId.parse(commandId)
    return this.serial(async () =>
      structuredClone((await this.load(sessionId)).receipts.get(id) ?? null),
    )
  }

  list(): Promise<SessionSnapshot[]> {
    return this.serial(() => this.listRetained())
  }

  /** Hold reference stability until a catalog operation finishes; unreadable evidence blocks it. */
  withSnapshotReferences<T>(action: (ids: Set<string>) => Promise<T>): Promise<T> {
    return this.serial(async () => {
      const ids = new Set((await this.listRetained()).map((session) => session.snapshotId))
      for (const name of await this.names()) {
        const match = /^\.deleting-([a-zA-Z0-9_-]{1,100})\.json$/.exec(name)
        if (!match) continue
        const receipt = await this.removal(match[1]!)
        if (!receipt) throw appError('error.sessionStorage')
        ids.add(receipt.value.snapshotId)
      }
      return action(ids)
    })
  }

  pendingRemovals(): Promise<SessionRemoval[]> {
    return this.serial(async () => {
      const pending: SessionRemoval[] = []
      for (const name of await this.names()) {
        const match = /^\.deleting-([a-zA-Z0-9_-]{1,100})\.json$/.exec(name)
        if (!match) continue
        const record = await this.removal(match[1]!)
        if (!record) throw appError('error.sessionStorage')
        pending.push({
          sessionId: record.value.sessionId,
          expectedCursor: record.value.expectedCursor,
        })
      }
      return pending
    })
  }

  /** Durable intent precedes cleanup; the small completed receipt prevents create replay. */
  remove(input: SessionRemoval, release: (snapshotId: string) => Promise<void>): Promise<void> {
    const query = sessionRemovalSchema.parse(input)
    return this.serial(async () => {
      const record = await this.removal(query.sessionId)
      if (record && record.value.expectedCursor !== query.expectedCursor)
        throw appError('error.sessionCursor')
      if (record?.complete) return
      let value = record?.value
      if (!value) {
        const snapshot = (await this.load(query.sessionId)).snapshot
        if (snapshot.cursor !== query.expectedCursor) throw appError('error.sessionCursor')
        if (snapshot.status !== 'closed') throw appError('error.sessionState')
        value = { ...query, version: 1, snapshotId: snapshot.snapshotId }
      }
      // Refuse cleanup if any retained journal is unreadable; absence of evidence is not zero refs.
      const retained = await this.listRetained()
      if (!record) {
        await this.publishExclusive(
          this.removalPath(query.sessionId, false),
          Buffer.from(JSON.stringify(value)),
        )
      }
      this.sessions.delete(query.sessionId)
      try {
        if (
          !retained.some(
            (item) => item.id !== query.sessionId && item.snapshotId === value.snapshotId,
          )
        )
          await release(value.snapshotId)
        // Exact torn-frame backups are owned transcript bytes too.
        for (const name of await this.names()) {
          if (
            name === `${query.sessionId}.jsonl` ||
            (name.startsWith(`${query.sessionId}.jsonl.`) &&
              /^[a-f0-9]{64}\.partial$/.test(name.slice(query.sessionId.length + 7)))
          )
            await unlink(join(this.directory, name)).catch((error: unknown) => {
              if (!isCode(error, 'ENOENT')) throw error
            })
        }
        await rename(
          this.removalPath(query.sessionId, false),
          this.removalPath(query.sessionId, true),
        )
        const directory = await open(this.directory, constants.O_RDONLY)
        try {
          await directory.sync()
        } finally {
          await directory.close()
        }
      } catch {
        throw appError('error.sessionCleanup')
      }
    })
  }

  private async names(): Promise<string[]> {
    try {
      return (await readdir(this.directory)).sort()
    } catch (error) {
      if (isCode(error, 'ENOENT')) return []
      throw appError('error.sessionStorage')
    }
  }

  private async listRetained(): Promise<SessionSnapshot[]> {
    const snapshots: SessionSnapshot[] = []
    for (const name of await this.names()) {
      const match = /^([a-zA-Z0-9_-]{1,100})\.jsonl$/.exec(name)
      if (match && !(await this.removal(match[1]!)))
        snapshots.push(structuredClone((await this.load(match[1]!)).snapshot))
    }
    return snapshots.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
  }

  private removalPath(id: string, complete: boolean): string {
    return join(this.directory, `.${complete ? 'deleted' : 'deleting'}-${entityId.parse(id)}.json`)
  }

  private async removal(
    id: string,
  ): Promise<{ value: z.infer<typeof removalSchema>; complete: boolean } | null> {
    for (const complete of [false, true]) {
      let handle: FileHandle
      try {
        handle = await this.openRegular(this.removalPath(id, complete), constants.O_RDONLY)
      } catch (error) {
        if (error instanceof Error && error.message === appError('error.sessionMissing').message)
          continue
        throw error
      }
      try {
        const before = await handle.stat()
        if (before.size > 4096) throw appError('error.sessionStorage')
        const bytes = Buffer.alloc(4097)
        const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0)
        if (bytesRead !== before.size || fingerprint(before) !== fingerprint(await handle.stat()))
          throw appError('error.sessionStorage')
        const value = removalSchema.parse(JSON.parse(decoder.decode(bytes.subarray(0, bytesRead))))
        if (value.sessionId !== id) throw appError('error.sessionStorage')
        return { value, complete }
      } catch {
        throw appError('error.sessionStorage')
      } finally {
        await handle.close()
      }
    }
    return null
  }

  append(
    sessionId: string,
    expectedCursor: number,
    input: z.input<typeof appendSchema>,
  ): Promise<SessionEvent> {
    // Copy before queuing so caller edits cannot change the operation while it waits.
    const data = appendSchema.parse(input)
    const cursor = sessionCursorSchema.parse(expectedCursor)
    return this.serial(async () => {
      const session = await this.load(sessionId)
      if (session.snapshot.cursor !== cursor) throw appError('error.sessionCursor')
      return this.appendLoaded(session, data)
    })
  }

  readEvents(input: z.input<typeof sessionEventQuerySchema>): Promise<SessionEventPage> {
    const query = sessionEventQuerySchema.parse(input)
    return this.serial(async () => {
      const session = await this.load(query.sessionId)
      if (query.afterCursor > session.snapshot.cursor) throw appError('error.sessionCursor')
      const events: SessionEvent[] = []
      const scan = await this.scan(this.path(query.sessionId), (record) => {
        if (
          record.kind === 'event' &&
          record.event.cursor > query.afterCursor &&
          events.length < query.limit
        )
          events.push(record.event)
      })
      if (scan.tail.length || fingerprint(scan.info) !== session.fingerprint)
        throw appError('error.sessionStorage')
      const nextCursor = events.at(-1)?.cursor ?? query.afterCursor
      return {
        events,
        nextCursor,
        latestCursor: session.snapshot.cursor,
        hasMore: nextCursor < session.snapshot.cursor,
      }
    })
  }

  readHistory(input: z.input<typeof sessionHistoryQuerySchema>): Promise<SessionHistoryPage> {
    const query = sessionHistoryQuerySchema.parse(input)
    return this.serial(async () => {
      const session = await this.load(query.sessionId)
      if (
        query.throughCursor > session.snapshot.cursor ||
        query.fromCursor > query.throughCursor ||
        (query.throughCursor > 0 && query.fromCursor === 0)
      )
        throw appError('error.sessionCursor')
      const events: HistoryEvent[] = []
      const sizes: number[] = []
      let bytes = 0,
        full = false
      const scan = await this.scan(this.path(query.sessionId), (record) => {
        if (record.kind !== 'event') return
        const event = record.event
        if (
          event.cursor > query.throughCursor ||
          (query.direction === 'forward'
            ? event.cursor < query.fromCursor || full
            : event.cursor > query.fromCursor)
        )
          return
        const value = historyEvent(event)
        const size = Buffer.byteLength(JSON.stringify(value))
        if (
          query.direction === 'forward' &&
          (events.length >= query.limit || (events.length && bytes + size > historyPageBytes))
        ) {
          full = true
          return
        }
        events.push(value)
        sizes.push(size)
        bytes += size
        while (events.length > query.limit || (events.length > 1 && bytes > historyPageBytes)) {
          events.shift()
          bytes -= sizes.shift()!
        }
      })
      if (scan.tail.length || fingerprint(scan.info) !== session.fingerprint)
        throw appError('error.sessionStorage')
      return {
        events,
        throughCursor: query.throughCursor,
        latestCursor: session.snapshot.cursor,
        hasEarlier: (events[0]?.cursor ?? 0) > 1,
        hasLater: (events.at(-1)?.cursor ?? 0) < query.throughCursor,
      }
    })
  }

  /** One bounded-memory pass; serialized with appends to preserve the selected event prefix. */
  writeHistory(
    input: z.infer<typeof sessionExportQuerySchema>,
    write: (record: SessionHistoryRecord) => Promise<void>,
  ) {
    const query = sessionExportQuerySchema.parse(input)
    return this.serial(async () => {
      const loaded = await this.load(query.sessionId)
      if (query.throughCursor > loaded.snapshot.cursor) throw appError('error.sessionCursor')
      const { id, agentId, installationId, engineVersion, mode, cwd, createdAt } = loaded.snapshot
      await write({
        kind: 'session-history',
        format: 'agentmatrix-session-history',
        version: 1,
        throughCursor: query.throughCursor,
        exportedAt: this.now(),
        session: { id, agentId, installationId, engineVersion, mode, cwd, createdAt },
      })
      let eventCount = 0
      const scan = await this.scan(this.path(query.sessionId), async (record) => {
        if (record.kind === 'event' && record.event.cursor <= query.throughCursor) {
          if (record.event.cursor !== eventCount + 1) throw appError('error.sessionStorage')
          await write({ kind: 'event', event: historyEvent(record.event) })
          eventCount++
        }
      })
      if (
        scan.tail.length ||
        fingerprint(scan.info) !== loaded.fingerprint ||
        eventCount !== query.throughCursor
      )
        throw appError('error.sessionStorage')
      return { throughCursor: query.throughCursor, eventCount }
    })
  }

  private serial<T>(operation: () => Promise<T>): Promise<T> {
    const task = this.queue.then(operation)
    this.queue = task.catch(() => undefined)
    return task
  }

  private path(sessionId: string): string {
    return join(this.directory, `${entityId.parse(sessionId)}.jsonl`)
  }

  private encode(value: z.infer<typeof recordSchema>): Buffer {
    const encoded = Buffer.from(`${JSON.stringify(recordSchema.parse(value))}\n`, 'utf8')
    if (encoded.length > maxRecordBytes) throw appError('error.sessionOverflow')
    return encoded
  }

  private async load(sessionId: string): Promise<LoadedSession> {
    if (await this.removal(sessionId)) throw appError('error.sessionDeleted')
    const path = this.path(sessionId)
    const cached = this.sessions.get(sessionId)
    if (cached) {
      if (fingerprint(await this.fileInfo(path)) !== cached.fingerprint)
        throw appError('error.sessionStorage')
      return cached
    }
    let snapshot: SessionSnapshot | undefined
    const receipts = new Map<string, CommandReceipt & { cursor: number }>()
    const remember = (receipt: CommandReceipt | undefined, cursor: number) => {
      if (!receipt) return
      if (receipts.has(receipt.id)) throw appError('error.sessionStorage')
      receipts.set(receipt.id, { ...receipt, cursor })
    }
    const result = await this.scan(path, (record) => {
      if (record.kind === 'session') {
        if (
          snapshot ||
          record.snapshot.id !== sessionId ||
          record.snapshot.status !== 'created' ||
          record.snapshot.cursor !== 0 ||
          record.snapshot.nativeSessionId
        )
          throw appError('error.sessionStorage')
        snapshot = record.snapshot
        remember(snapshot.creationReceipt, 0)
      } else {
        if (!snapshot || record.event.cursor !== snapshot.cursor + 1)
          throw appError('error.sessionStorage')
        snapshot = applySessionEvent(snapshot, record.event)
        remember(record.event.receipt, record.event.cursor)
      }
    })
    if (!snapshot) throw appError('error.sessionStorage')
    let info = result.info
    if (result.tail.length) {
      // Keep the exact uncommitted bytes before truncating only the unfinished final frame.
      const digest = createHash('sha256').update(result.tail).digest('hex')
      const backup = `${path}.${digest}.partial`
      try {
        await this.publishExclusive(backup, result.tail)
      } catch (error) {
        if (!isCode(error, 'EEXIST')) throw appError('error.sessionStorage')
        const handle = await this.openRegular(backup, constants.O_RDONLY)
        try {
          if (!(await handle.readFile()).equals(result.tail)) throw appError('error.sessionStorage')
        } finally {
          await handle.close()
        }
      }
      const handle = await this.openRegular(path, constants.O_RDWR)
      try {
        if (fingerprint(await handle.stat()) !== fingerprint(info))
          throw appError('error.sessionStorage')
        await handle.truncate(result.completeBytes)
        await handle.sync()
        info = await handle.stat()
      } finally {
        await handle.close()
      }
    }
    const loaded = { snapshot, fingerprint: fingerprint(info), bytes: info.size, receipts }
    if (runningStates.has(snapshot.status)) {
      await this.appendLoaded(
        loaded,
        {
          runId: snapshot.runId,
          turnId: null,
          data: { kind: 'run.interrupted', failure: { code: 'interrupted', detail: '' } },
        },
        true,
      )
    }
    this.sessions.set(sessionId, loaded)
    return loaded
  }

  private async appendLoaded(
    session: LoadedSession,
    input: z.infer<typeof appendSchema>,
    recovering = false,
  ): Promise<SessionEvent> {
    if (input.receipt && session.receipts.has(input.receipt.id))
      throw appError('error.sessionCommandConflict')
    const event = sessionEventSchema.parse({
      ...input,
      sessionId: session.snapshot.id,
      cursor: session.snapshot.cursor + 1,
      timestamp: this.now(),
    })
    const next = applySessionEvent(session.snapshot, event)
    const bytes = this.encode({ kind: 'event', event })
    const terminal = [
      'run.interrupted',
      'run.failed',
      'session.closing',
      'session.closed',
      'turn.finished',
      'turn.cancelling',
    ].includes(input.data.kind)
    const reserve = recovering
      ? 0
      : terminal
        ? 1024
        : Math.min(64 * 1024, Math.floor(this.maxBytes / 4))
    if (session.bytes + bytes.length > this.maxBytes - reserve)
      throw appError('error.sessionJournalFull')
    const handle = await this.openRegular(
      this.path(session.snapshot.id),
      constants.O_WRONLY | constants.O_APPEND,
    )
    try {
      if (fingerprint(await handle.stat()) !== session.fingerprint)
        throw appError('error.sessionStorage')
      await handle.writeFile(bytes)
      await handle.sync()
      const info = await handle.stat()
      session.snapshot = next
      session.fingerprint = fingerprint(info)
      session.bytes = info.size
      if (event.receipt)
        session.receipts.set(event.receipt.id, { ...event.receipt, cursor: event.cursor })
      return event
    } catch {
      this.sessions.delete(session.snapshot.id)
      throw appError('error.sessionStorage')
    } finally {
      await handle.close()
    }
  }

  private async scan(
    path: string,
    visit: (record: z.infer<typeof recordSchema>) => void | Promise<void>,
  ): Promise<{ info: Stats; completeBytes: number; tail: Buffer }> {
    const handle = await this.openRegular(path, constants.O_RDONLY)
    try {
      const before = await handle.stat()
      if (before.size > this.maxBytes) throw appError('error.sessionJournalFull')
      let tail: Buffer = Buffer.alloc(0)
      let completeBytes = 0
      const buffer = Buffer.alloc(64 * 1024)
      for (;;) {
        const { bytesRead } = await handle.read(buffer)
        if (!bytesRead) break
        const combined = Buffer.concat([tail, buffer.subarray(0, bytesRead)])
        let start = 0
        for (;;) {
          const end = combined.indexOf(0x0a, start)
          if (end < 0) break
          if (end - start + 1 > maxRecordBytes) throw appError('error.sessionStorage')
          await visit(recordSchema.parse(JSON.parse(decoder.decode(combined.subarray(start, end)))))
          completeBytes += end - start + 1
          start = end + 1
        }
        tail = Buffer.from(combined.subarray(start))
        if (tail.length >= maxRecordBytes) throw appError('error.sessionStorage')
      }
      const info = await handle.stat()
      if (fingerprint(before) !== fingerprint(info)) throw appError('error.sessionStorage')
      return { info, completeBytes, tail }
    } catch {
      throw appError('error.sessionStorage')
    } finally {
      await handle.close()
    }
  }

  private async openRegular(path: string, flags: number): Promise<FileHandle> {
    try {
      const handle = await open(path, flags | (constants.O_NOFOLLOW ?? 0))
      try {
        const info = await handle.stat()
        if (!info.isFile() || info.nlink !== 1) throw appError('error.sessionStorage')
        return handle
      } catch (error) {
        await handle.close()
        throw error
      }
    } catch (error) {
      if (isCode(error, 'ENOENT')) throw appError('error.sessionMissing')
      throw appError('error.sessionStorage')
    }
  }

  private async fileInfo(path: string): Promise<Stats> {
    const handle = await this.openRegular(path, constants.O_RDONLY)
    try {
      return await handle.stat()
    } finally {
      await handle.close()
    }
  }

  private async publishExclusive(path: string, bytes: Buffer): Promise<void> {
    const temporary = join(this.directory, `.${randomUUID()}.tmp`)
    try {
      const handle = await open(temporary, 'wx', 0o600)
      try {
        await handle.writeFile(bytes)
        await handle.sync()
      } finally {
        await handle.close()
      }
      await link(temporary, path)
    } finally {
      await unlink(temporary).catch(() => undefined)
      const directory = await open(this.directory, constants.O_RDONLY)
      try {
        await directory.sync()
      } finally {
        await directory.close()
      }
    }
  }
}
