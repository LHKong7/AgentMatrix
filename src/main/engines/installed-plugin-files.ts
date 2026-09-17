import { createHash } from 'node:crypto'
import { constants, type BigIntStats } from 'node:fs'
import { open, realpath, stat } from 'node:fs/promises'
import { appError } from '../../shared/errors'

export const fileIdentity = (value: BigIntStats) =>
  [value.dev, value.ino, value.mode, value.size, value.mtimeNs, value.ctimeNs].join(':')

/** Bounded, nonblocking regular-file reads. No import, subprocess, package manager, or network. */
export async function inspectFile(path: string, limit: number, keepBytes: boolean) {
  const resolvedPath = await realpath(path)
  const handle = await open(
    resolvedPath,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  )
  try {
    const before = await handle.stat({ bigint: true })
    if (!before.isFile()) throw appError('error.pluginFile')
    if (before.size > limit) throw appError('error.pluginLimit')
    const hash = createHash('sha256')
    const chunk = Buffer.alloc(64 * 1024)
    const chunks: Buffer[] = []
    let bytes = 0
    while (bytes <= Number(before.size)) {
      const read = await handle.read(
        chunk,
        0,
        Math.min(chunk.length, Number(before.size) + 1 - bytes),
        bytes,
      )
      if (!read.bytesRead) break
      bytes += read.bytesRead
      hash.update(chunk.subarray(0, read.bytesRead))
      if (keepBytes) chunks.push(Buffer.from(chunk.subarray(0, read.bytesRead)))
    }
    if (
      bytes !== Number(before.size) ||
      fileIdentity(before) !== fileIdentity(await handle.stat({ bigint: true })) ||
      resolvedPath !== (await realpath(path)) ||
      fileIdentity(before) !== fileIdentity(await stat(path, { bigint: true }))
    )
      throw appError('error.pluginChanged')
    return {
      observation: { path, resolvedPath, sha256: hash.digest('hex'), bytes },
      stamp: fileIdentity(before),
      content: keepBytes ? Buffer.concat(chunks) : null,
    }
  } finally {
    await handle.close()
  }
}
