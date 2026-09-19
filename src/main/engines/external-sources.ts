import { createHash } from 'node:crypto'
import { constants, type BigIntStats } from 'node:fs'
import { lstat, open, opendir, realpath, stat } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import { appError } from '../../shared/errors'
import { verifyInstructionSources } from './instruction-sources'
import type {
  ExternalFile,
  ExternalDirectory,
  GeneratedInputs,
} from '../../shared/engines/run-inputs'

const identity = (value: BigIntStats) =>
  [value.dev, value.ino, value.size, value.mode, value.mtimeNs, value.ctimeNs].join(':')

/** Observe file identity/content without copying potentially secret-bearing native configuration. */
export async function observeExternalFile(path: string): Promise<ExternalFile> {
  if (!isAbsolute(path)) throw appError('error.runPath')
  try {
    const resolvedPath = await realpath(path)
    // Executables can be hundreds of MB. Hash bounded chunks rather than retaining their bytes.
    const file = await open(
      resolvedPath,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    )
    try {
      const before = await file.stat({ bigint: true })
      if (!before.isFile() || before.size > 512 * 1024 * 1024) throw appError('error.runIntegrity')
      const digest = createHash('sha256')
      const chunk = Buffer.alloc(128 * 1024)
      let offset = 0
      while (offset <= Number(before.size)) {
        const { bytesRead } = await file.read(
          chunk,
          0,
          Math.min(chunk.length, Number(before.size) + 1 - offset),
          offset,
        )
        if (!bytesRead) break
        digest.update(chunk.subarray(0, bytesRead))
        offset += bytesRead
      }
      if (
        offset !== Number(before.size) ||
        identity(before) !== identity(await file.stat({ bigint: true })) ||
        (await realpath(path)) !== resolvedPath
      )
        throw appError('error.runSourceChanged')
      return { path, exists: true, resolvedPath, sha256: digest.digest('hex'), bytes: offset }
    } finally {
      await file.close()
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { path, exists: false }
    throw error
  }
}

/** Match pinned native resource discovery without parsing Markdown, expanding macros, or executing it. */
export async function observeResourceDirectory(
  path: string,
  kind: ExternalDirectory['kind'],
): Promise<ExternalDirectory> {
  if (!isAbsolute(path)) throw appError('error.runPath')
  const recursive = kind !== 'opencode-mode'
  const root = await realpath(path).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return null
    throw error
  })
  if (!root) return { path, kind, observation: { exists: false } }
  const files: ExternalFile[] = []
  let entries = 0,
    bytes = 0
  const ancestors = new Set<string>()
  const list = async (directory: string) => {
    const result = []
    for await (const entry of await opendir(directory)) {
      if (result.length >= 16_384) throw appError('error.runLimit')
      result.push(entry)
    }
    return result.sort((left, right) =>
      left.name < right.name ? -1 : left.name > right.name ? 1 : 0,
    )
  }
  const walk = async (directory: string, depth: number): Promise<void> => {
    if (depth > 64) throw appError('error.runLimit')
    const resolved = await realpath(directory)
    if (ancestors.has(resolved)) throw appError('error.runIntegrity')
    const before = await stat(resolved, { bigint: true })
    if (!before.isDirectory()) throw appError('error.runIntegrity')
    ancestors.add(resolved)
    try {
      const children = await list(resolved)
      entries += children.length
      if (entries > 16_384) throw appError('error.runLimit')
      for (const child of children) {
        // Flat Mode discovery never follows a non-matching entry, even if it is a symlink.
        if (!recursive && !child.name.endsWith('.md')) continue
        const target = join(directory, child.name)
        let type = await lstat(target)
        if (type.isSymbolicLink()) {
          const followed = await stat(target).catch((error: NodeJS.ErrnoException) => {
            if (error.code === 'ENOENT') return null
            throw error
          })
          if (!followed) {
            if (child.name.endsWith('.md')) files.push({ path: target, exists: false })
            if (files.length > 1000) throw appError('error.runLimit')
            continue
          }
          type = followed
        }
        if (type.isDirectory()) {
          if (recursive) await walk(target, depth + 1)
          continue
        }
        if (!child.name.endsWith('.md')) continue
        if (!type.isFile()) throw appError('error.runIntegrity')
        if (type.size > 20_000_000 || files.length >= 1000) throw appError('error.runLimit')
        const observed = await observeExternalFile(target)
        if (!observed.exists) throw appError('error.runSourceChanged')
        bytes += observed.bytes
        if (observed.bytes > 20_000_000 || bytes > 256 * 1024 * 1024)
          throw appError('error.runLimit')
        files.push(observed)
      }
      const after = await stat(resolved, { bigint: true })
      const names = (values: typeof children) =>
        values.map((entry) => [
          entry.name,
          entry.isDirectory(),
          entry.isSymbolicLink(),
          entry.isFile(),
        ])
      if (
        before.dev !== after.dev ||
        before.ino !== after.ino ||
        (await realpath(directory)) !== resolved ||
        !isDeepStrictEqual(names(children), names(await list(resolved)))
      )
        throw appError('error.runSourceChanged')
    } finally {
      ancestors.delete(resolved)
    }
  }
  await walk(path, 0)
  if ((await realpath(path)) !== root) throw appError('error.runSourceChanged')
  files.sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0))
  return { path, kind, observation: { exists: true, resolvedPath: root, files } }
}

/** Re-enumeration detects newly discovered resources as well as changed captured files. */
export async function verifyExternalSources(
  sources: GeneratedInputs['externalSources'],
): Promise<void> {
  for (const source of sources.files)
    if (!isDeepStrictEqual(await observeExternalFile(source.path), source))
      throw appError('error.runSourceChanged')
  for (const directory of sources.directories ?? [])
    if (
      !isDeepStrictEqual(await observeResourceDirectory(directory.path, directory.kind), directory)
    )
      throw appError('error.runSourceChanged')
  if (sources.instructionSources) await verifyInstructionSources(sources.instructionSources)
}
