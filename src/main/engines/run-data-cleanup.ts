import { createHash, randomUUID } from 'node:crypto'
import { constants, type BigIntStats } from 'node:fs'
import { link, lstat, mkdir, open, opendir, rename, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { z } from 'zod'
import { appError } from '../../shared/errors'
import type { RunInputManifest } from '../../shared/engines/run-inputs'
import {
  runDataIdentitySchema,
  runDataRemovalSchema,
  type RunDataIdentity,
  type RunDataQuery,
  type RunDataRemoval,
  type UnusedRunData,
  type UnusedRunDataPage,
} from '../../shared/sessions/run-data'

const receiptSchema = runDataRemovalSchema
  .extend({
    version: z.literal(1),
    directoryIdentity: z.string().regex(/^[0-9]+:[0-9]+$/),
  })
  .strict()
const key = (target: RunDataIdentity) => `${target.kind}:${target.id}`
const directoryIdentity = (info: BigIntStats) => `${info.dev}:${info.ino}`
const fingerprint = (info: BigIntStats) =>
  [info.dev, info.ino, info.mode, info.size, info.mtimeNs, info.ctimeNs].join(':')
const absent = (error: NodeJS.ErrnoException) => {
  if (error.code !== 'ENOENT') throw error
  return null
}

/** All calls run under the run store queue; callers also hold the session catalog/reference lock. */
export class RunDataCleanup {
  constructor(
    private readonly root: string,
    private readonly verifyCapture: (id: string) => Promise<RunInputManifest>,
  ) {}

  private path(target: RunDataIdentity) {
    return join(this.root, target.kind === 'stage' ? `.stage-${target.id}` : target.id)
  }
  private receiptPath(target: RunDataIdentity, complete: boolean) {
    return join(
      this.root,
      `.unused-${complete ? 'deleted' : 'deleting'}-${target.kind}-${target.id}.json`,
    )
  }
  private async rootExists() {
    const info = await lstat(this.root).catch(absent)
    if (!info) return false
    if (!info.isDirectory() || info.isSymbolicLink()) throw appError('error.runIntegrity')
    return true
  }
  private async syncRoot() {
    const directory = await open(this.root, constants.O_RDONLY | constants.O_NOFOLLOW)
    try {
      await directory.sync()
    } finally {
      await directory.close()
    }
  }
  private async receipt(target: RunDataIdentity) {
    for (const complete of [false, true]) {
      const handle = await open(
        this.receiptPath(target, complete),
        constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
      ).catch(absent)
      if (!handle) continue
      try {
        const before = await handle.stat({ bigint: true })
        if (!before.isFile() || before.size > 4096) throw appError('error.runIntegrity')
        const bytes = Buffer.alloc(4097)
        const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0)
        if (
          bytesRead !== Number(before.size) ||
          fingerprint(before) !== fingerprint(await handle.stat({ bigint: true }))
        )
          throw appError('error.runIntegrity')
        const value = receiptSchema.parse(
          JSON.parse(
            new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, bytesRead)),
          ),
        )
        if (key(value.target) !== key(target)) throw appError('error.runIntegrity')
        return { value, complete }
      } catch {
        throw appError('error.runIntegrity')
      } finally {
        await handle.close()
      }
    }
    return null
  }
  async assertAvailable(id: string) {
    if ((await this.rootExists()) && (await this.receipt({ kind: 'capture', id })))
      throw appError('error.runDeleted')
  }
  private async candidate(target: RunDataIdentity): Promise<UnusedRunData | null> {
    const receipt = await this.receipt(target)
    if (receipt?.complete) return null
    if (receipt) return { target, token: receipt.value.token, modifiedAt: null, pending: true }
    const info = await lstat(this.path(target), { bigint: true }).catch(absent)
    if (!info || !info.isDirectory() || info.isSymbolicLink()) return null
    let capture: UnusedRunData['capture']
    if (target.kind === 'capture') {
      try {
        const manifest = await this.verifyCapture(target.id)
        capture = {
          agent: manifest.agent.name,
          engine: manifest.installation.name,
          cwd: manifest.cwd,
        }
      } catch {
        return null
      }
    }
    return {
      target,
      token: createHash('sha256')
        .update(`${key(target)}:${fingerprint(info)}`)
        .digest('hex'),
      modifiedAt: new Date(Number(info.mtimeMs)).toISOString(),
      pending: false,
      ...(capture ? { capture } : {}),
    }
  }
  async list(referenced: ReadonlySet<string>, query: RunDataQuery): Promise<UnusedRunDataPage> {
    if (!(await this.rootExists())) return { items: [], next: null, skipped: 0 }
    const targets = new Map<string, RunDataIdentity>()
    let count = 0,
      skipped = 0
    for await (const entry of await opendir(this.root)) {
      if (++count > 100_000) throw appError('error.runLimit')
      const pending = /^\.unused-deleting-(capture|stage)-(.+)\.json$/.exec(entry.name)
      const stage = /^\.stage-(.+)$/.exec(entry.name)
      if (/^\.unused-deleted-/.test(entry.name)) continue
      const result = runDataIdentitySchema.safeParse(
        pending
          ? { kind: pending[1], id: pending[2] }
          : stage
            ? { kind: 'stage', id: stage[1] }
            : { kind: 'capture', id: entry.name },
      )
      if (!result.success) {
        skipped++
        continue
      }
      const target = result.data
      if (target.kind === 'capture' && referenced.has(target.id)) continue
      targets.set(key(target), target)
    }
    const items: UnusedRunData[] = []
    for (const [id, target] of [...targets].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
      if (query.after && id <= query.after) continue
      if (items.length === 100) return { items, next: key(items.at(-1)!.target), skipped }
      const item = await this.candidate(target)
      if (item) items.push(item)
      else skipped++
    }
    return { items, next: null, skipped }
  }
  async remove(query: RunDataRemoval, referenced: ReadonlySet<string>) {
    const { target, token } = runDataRemovalSchema.parse(query)
    if (target.kind === 'capture' && referenced.has(target.id))
      throw appError('error.runReferenced')
    if (!(await this.rootExists())) throw appError('error.runCleanupStale')
    let receipt = await this.receipt(target)
    if (receipt && receipt.value.token !== token) throw appError('error.runCleanupStale')
    if (receipt?.complete) return
    if (!receipt) {
      const current = await this.candidate(target)
      if (!current || current.token !== token) throw appError('error.runCleanupStale')
      const info = await lstat(this.path(target), { bigint: true })
      const value = receiptSchema.parse({
        ...query,
        version: 1,
        directoryIdentity: directoryIdentity(info),
      })
      // An interrupted receipt publication is itself an ordinary, reviewable staging directory.
      const stage = join(this.root, `.stage-${randomUUID()}`)
      await mkdir(stage, { mode: 0o700 })
      try {
        const temporary = join(stage, 'receipt.json')
        const file = await open(temporary, 'wx', 0o600)
        try {
          await file.writeFile(JSON.stringify(value))
          await file.sync()
        } finally {
          await file.close()
        }
        await link(temporary, this.receiptPath(target, false))
        await this.syncRoot()
      } finally {
        await rm(stage, { recursive: true, force: true })
      }
      receipt = { value, complete: false }
    }
    try {
      const info = await lstat(this.path(target), { bigint: true }).catch(absent)
      if (info) {
        if (
          !info.isDirectory() ||
          info.isSymbolicLink() ||
          directoryIdentity(info) !== receipt.value.directoryIdentity
        )
          throw appError('error.runIntegrity')
        // Recursive rm unlinks inner symlinks instead of visiting their targets.
        await rm(this.path(target), { recursive: true, force: true })
      }
      await rename(this.receiptPath(target, false), this.receiptPath(target, true))
      await this.syncRoot()
    } catch {
      throw appError('error.runCleanupPending')
    }
  }
}
