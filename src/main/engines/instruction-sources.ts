import { opendir, lstat, readlink, realpath } from 'node:fs/promises'
import type { Dirent } from 'node:fs'
import { relative } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import { Glob, type GlobOptions } from 'glob'
import { braceExpand } from 'minimatch'
import type {
  ExternalFile,
  InstructionSearch,
  InstructionSources,
} from '../../shared/engines/run-inputs'
import { appError } from '../../shared/errors'
import { inspectFile } from './installed-plugin-files'

/** Pinned native glob semantics, with fail-closed traversal, output and time limits. */
async function matches(search: InstructionSearch, deadline: number): Promise<string[]> {
  if (Date.now() >= deadline) throw appError('error.runLimit')
  const controller = new AbortController()
  const timer = setTimeout(
    () => controller.abort(appError('error.runLimit')),
    Math.min(5000, deadline - Date.now()),
  )
  let entries = 0
  let failure: unknown
  const checked = async <T>(operation: () => Promise<T>): Promise<T> => {
    try {
      return await operation()
    } catch (error) {
      if (!['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code ?? '')) {
        failure = error
        controller.abort(error)
      }
      throw error
    }
  }
  const list = (path: string) =>
    checked(async () => {
      if (relative(search.cwd, path).split('/').length > 64) throw appError('error.runLimit')
      const result: Dirent[] = []
      for await (const entry of await opendir(path)) {
        if (++entries > 16_384 || controller.signal.aborted) throw appError('error.runLimit')
        result.push(entry)
      }
      return result
    })
  const fs: GlobOptions['fs'] = {
    readdir: (path, _options, callback) => {
      void list(path).then(
        (entries) => callback(null, entries),
        (error) => callback(error),
      )
    },
    promises: {
      readdir: list,
      lstat: (path) => checked(() => lstat(path)),
      readlink: (path) => checked(() => readlink(path)),
      realpath: (path) => checked(() => realpath(path)),
    },
  }
  try {
    const result: string[] = []
    if (braceExpand(search.pattern, { braceExpandMax: 1001 }).length > 1000)
      throw appError('error.runLimit')
    // Same package/version/options as native OpenCode. Never reuse traversal caches across checks.
    const glob = new Glob(search.pattern, {
      cwd: search.cwd,
      dot: search.dot,
      absolute: true,
      nodir: true,
      follow: false,
      braceExpandMax: 1000,
      signal: controller.signal,
      fs,
    })
    for await (const path of glob) {
      if (result.length >= 1000) throw appError('error.runLimit')
      result.push(path)
    }
    if (failure || controller.signal.aborted) throw appError('error.runIntegrity')
    return [...new Set(result)].sort()
  } catch {
    throw appError('error.runIntegrity')
  } finally {
    clearTimeout(timer)
  }
}

export async function observeInstructionSearches(
  searches: InstructionSearch[],
  deadline = Date.now() + 30_000,
): Promise<ExternalFile[]> {
  const enumerate = async () => {
    const found = new Set<string>()
    for (const search of searches) {
      for (const path of await matches(search, deadline)) found.add(path)
      if (found.size > 1000) throw appError('error.runLimit')
    }
    return [...found].sort()
  }
  const paths = await enumerate()
  const files: ExternalFile[] = []
  let bytes = 0
  for (const path of paths) {
    if (Date.now() >= deadline) throw appError('error.runLimit')
    try {
      const file = await inspectFile(path, 20_000_000, false)
      if ((bytes += file.observation.bytes) > 256 * 1024 * 1024) throw appError('error.runLimit')
      files.push({ ...file.observation, exists: true })
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw appError('error.runIntegrity')
      // Glob includes dangling links. Retain their absence so later target creation changes evidence.
      files.push({ path, exists: false })
    }
  }
  if (!isDeepStrictEqual(paths, await enumerate())) throw appError('error.runSourceChanged')
  return files
}

export async function verifyInstructionSources(sources: InstructionSources): Promise<void> {
  const deadline = Date.now() + 30_000
  for (const entry of sources.patterns)
    if (!isDeepStrictEqual(await observeInstructionSearches(entry.searches, deadline), entry.files))
      throw appError('error.runSourceChanged')
}
