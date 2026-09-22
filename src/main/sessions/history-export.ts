import { randomUUID } from 'node:crypto'
import { lstat, open, realpath, rename, rm } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, relative, sep } from 'node:path'
import type { z } from 'zod'
import { appError } from '../../shared/errors'
import { sessionExportQuerySchema, type SessionExportResult } from '../../shared/sessions/schema'
import type { SessionJournal } from './journal'

/** The target comes from the main-process save dialog, never from renderer IPC. */
export async function exportSessionHistory(
  journal: Pick<SessionJournal, 'writeHistory'>,
  input: z.infer<typeof sessionExportQuerySchema>,
  target: string,
  protectedDirectory: string,
): Promise<SessionExportResult> {
  const query = sessionExportQuerySchema.parse(input)
  if (!isAbsolute(target) || target.includes('\0')) throw appError('error.historyExport')
  const parent = await realpath(dirname(target))
  const protectedRoot = await realpath(protectedDirectory)
  const inside = relative(protectedRoot, parent)
  if (inside === '' || (!isAbsolute(inside) && inside !== '..' && !inside.startsWith(`..${sep}`)))
    throw appError('error.historyExportProtected')
  const destination = join(parent, basename(target))
  const inspect = async () => {
    const info = await lstat(destination).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return null
      throw error
    })
    if (info && (!info.isFile() || info.nlink !== 1)) throw appError('error.historyExport')
    return info ? [info.dev, info.ino, info.size, info.mtimeMs, info.ctimeMs].join(':') : null
  }
  const before = await inspect()
  const temporary = join(parent, `.agentmatrix-history-${randomUUID()}.tmp`)
  try {
    const handle = await open(temporary, 'wx', 0o600)
    let result
    try {
      let chunks: string[] = []
      let bytes = 0
      const flush = async () => {
        if (chunks.length) await handle.writeFile(chunks.join(''), 'utf8')
        chunks = []
        bytes = 0
      }
      result = await journal.writeHistory(query, async (record) => {
        const line = JSON.stringify(record) + '\n'
        chunks.push(line)
        bytes += Buffer.byteLength(line)
        if (bytes >= 64 * 1024) await flush()
      })
      await flush()
      await handle.sync()
    } finally {
      await handle.close()
    }
    if ((await inspect()) !== before) throw appError('error.historyExportChanged')
    await rename(temporary, destination)
    return { path: destination, ...result }
  } finally {
    await rm(temporary, { force: true })
  }
}
