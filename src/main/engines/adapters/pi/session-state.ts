import { constants } from 'node:fs'
import { lstat, open, realpath } from 'node:fs/promises'
import { join, relative } from 'node:path'
import { z } from 'zod'
import type { RunInputManifest, RunPaths } from '../../../../shared/engines/run-inputs'
import { RuntimeFailure } from '../../runtime'

const referenceSchema = z
  .object({
    version: z.literal(1),
    snapshotDigest: z.string(),
    nativeSessionId: z.uuid(),
    file: z.string().regex(/^[A-Za-z0-9_.-]+\.jsonl$/),
  })
  .strict()
type Reference = z.infer<typeof referenceSchema>
type SessionInputs = Pick<RunInputManifest, 'digest' | 'cwd'>
async function sessionDirectory(paths: RunPaths): Promise<string> {
  const directory = join(paths.state, 'sessions')
  if (!(await lstat(directory)).isDirectory()) throw new Error('Invalid native session directory')
  return realpath(directory)
}
async function boundedRead(path: string, headerOnly = false): Promise<string> {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  try {
    const stat = await file.stat()
    if (!stat.isFile() || stat.size === 0 || (!headerOnly && stat.size > 65_536))
      throw new Error('Invalid native session file')
    const buffer = Buffer.alloc(Math.min(stat.size, 65_537))
    let offset = 0
    while (offset < buffer.length) {
      const { bytesRead } = await file.read(buffer, offset, buffer.length - offset, offset)
      if (!bytesRead) break
      offset += bytesRead
      if (headerOnly && buffer.subarray(0, offset).includes(10)) break
    }
    const newline = buffer.subarray(0, offset).indexOf(10)
    if (headerOnly && newline < 0) throw new Error('Missing native session header')
    const after = await file.stat()
    if (
      (!headerOnly && offset !== stat.size) ||
      after.size !== stat.size ||
      after.mtimeMs !== stat.mtimeMs ||
      after.ctimeMs !== stat.ctimeMs
    )
      throw new Error('Native session changed while reading')
    return new TextDecoder('utf-8', { fatal: true }).decode(
      buffer.subarray(0, headerOnly ? newline : offset),
    )
  } finally {
    await file.close()
  }
}
export async function rememberPiSession(
  paths: RunPaths,
  manifest: SessionInputs,
  nativeSessionId: string,
  sessionFile: string,
): Promise<void> {
  try {
    const directory = await sessionDirectory(paths)
    const value = referenceSchema.parse({
      version: 1,
      snapshotDigest: manifest.digest,
      nativeSessionId,
      file: relative(directory, sessionFile),
    })
    if (join(directory, value.file) !== sessionFile) throw new Error('Invalid native session path')
    const file = await open(join(paths.state, 'pi-session.json'), 'wx', 0o600)
    try {
      await file.writeFile(JSON.stringify(value) + '\n')
      await file.sync()
    } finally {
      await file.close()
    }
  } catch {
    throw new RuntimeFailure('configuration', 'pi.session-identity')
  }
}
export async function restorePiSession(
  paths: RunPaths,
  manifest: SessionInputs,
  nativeSessionId: string,
  options: { allowUnwritten?: boolean } = {},
): Promise<{ reference: Reference; sessionPath: string; persisted: boolean }> {
  try {
    const reference = referenceSchema.parse(
      JSON.parse(await boundedRead(join(paths.state, 'pi-session.json'))),
    )
    if (
      reference.nativeSessionId !== nativeSessionId ||
      reference.snapshotDigest !== manifest.digest
    )
      throw new Error('Session reference changed')
    const directory = await sessionDirectory(paths)
    const sessionPath = join(directory, reference.file)
    // Pi defers creating a transcript until a model reply. Only a live, never-persisted
    // conversation may accept that absence; restoration continues to require the header.
    if (options.allowUnwritten) {
      const file = await lstat(sessionPath).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== 'ENOENT') throw error
        return null
      })
      if (!file) return { reference, sessionPath, persisted: false }
    }
    const header = z
      .object({ type: z.literal('session'), id: z.uuid(), cwd: z.string() })
      .parse(JSON.parse(await boundedRead(sessionPath, true)))
    if (header.id !== nativeSessionId || header.cwd !== manifest.cwd)
      throw new Error('Native session header changed')
    return { reference, sessionPath, persisted: true }
  } catch {
    throw new RuntimeFailure('configuration', 'pi.session-identity')
  }
}
