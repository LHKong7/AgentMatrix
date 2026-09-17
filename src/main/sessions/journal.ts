import { createHash, randomUUID } from 'node:crypto'
import { constants, type Stats } from 'node:fs'
import { link, mkdir, open, readdir, unlink, type FileHandle } from 'node:fs/promises'
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
} from '../../shared/sessions/schema'

const recordSchema = z.discriminatedUnion('kind', [
  z
    .object({ kind: z.literal('session'), version: z.literal(1), snapshot: sessionSnapshotSchema })
    .strict(),
  z.object({ kind: z.literal('event'), event: sessionEventSchema }).strict(),
])
const appendSchema = sessionEventSchema.omit({ sessionId: true, cursor: true, timestamp: true })
const maxRecordBytes = 1024 * 1024
const decoder = new TextDecoder('utf-8', { fatal: true })
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
    return this.serial(async () => {
      let names: string[]
      try {
        names = await readdir(this.directory)
      } catch (error) {
        if (isCode(error, 'ENOENT')) return []
        throw appError('error.sessionStorage')
      }
      const snapshots: SessionSnapshot[] = []
      for (const name of names.sort()) {
        const match = /^([a-zA-Z0-9_-]{1,100})\.jsonl$/.exec(name)
        if (match) snapshots.push(structuredClone((await this.load(match[1]!)).snapshot))
      }
      return snapshots.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
    })
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
    visit: (record: z.infer<typeof recordSchema>) => void,
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
          visit(recordSchema.parse(JSON.parse(decoder.decode(combined.subarray(start, end)))))
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
