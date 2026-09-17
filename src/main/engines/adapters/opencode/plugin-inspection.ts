import { fileIdentity as identity, inspectFile } from '../../installed-plugin-files'
import { realpath, stat } from 'node:fs/promises'
import { dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { appError, getErrorKey } from '../../../../shared/errors'
import type { PluginInspection } from '../../../../shared/engines/plugin-inspection'

export const pluginInspectionLimits = { metadataBytes: 256 * 1024, entryBytes: 20_000_000 }
const indexNames = ['index.ts', 'index.tsx', 'index.js', 'index.mjs', 'index.cjs']
const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)

function metadataText(value: unknown, limit: number): string | null {
  if (value === undefined) return null
  if (
    typeof value !== 'string' ||
    !value.trim() ||
    value.length > limit ||
    [...value].some((char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127)
  )
    throw appError('error.pluginMetadata')
  return value.trim()
}

async function pathStat(path: string) {
  try {
    return await stat(path, { bigint: true })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
}

function contained(root: string, path: string) {
  const suffix = relative(root, path)
  return suffix !== '..' && !suffix.startsWith(`..${sep}`) && !isAbsolute(suffix)
}

/** Inspect the v1.18.16 local server entry rules; never infer an exported ID from a package name. */
export async function inspectOpenCodePlugin(
  path: string,
): Promise<
  Pick<PluginInspection, 'selectedPath' | 'resolvedPath' | 'entryKind' | 'entry' | 'package'>
> {
  try {
    if (!isAbsolute(path)) throw appError('error.pluginPath')
    const selectedPath = resolve(path)
    const selected = await pathStat(selectedPath)
    if (!selected) throw appError('error.pluginMissing')
    if (!selected.isFile() && !selected.isDirectory()) throw appError('error.pluginFile')
    const resolvedPath = await realpath(selectedPath)
    // Use the selected path's directory, as the native loader does, before resolving symlinks.
    const directory = selected.isDirectory() ? selectedPath : dirname(selectedPath)
    const packagePath = join(directory, 'package.json')
    const packageExists = await pathStat(packagePath)
    const inspectedPackage = packageExists
      ? await inspectFile(packagePath, pluginInspectionLimits.metadataBytes, true)
      : null
    let metadata: Record<string, unknown> | null = null
    if (inspectedPackage) {
      try {
        const decoded: unknown = JSON.parse(
          new TextDecoder('utf-8', { fatal: true }).decode(inspectedPackage.content!),
        )
        if (!record(decoded)) throw appError('error.pluginMetadata')
        metadata = decoded
      } catch {
        throw appError('error.pluginMetadata')
      }
    }
    const pkg =
      metadata && inspectedPackage
        ? {
            file: inspectedPackage.observation,
            name: metadataText(metadata.name, 200),
            version: metadataText(metadata.version, 100),
            engineRange: record(metadata.engines)
              ? metadataText(metadata.engines.opencode, 200)
              : null,
          }
        : null
    let entryPath = selectedPath
    let entryKind: PluginInspection['entryKind'] = 'file'
    const exports = metadata?.exports
    const server = record(exports) ? exports['./server'] : undefined
    const serverEntry =
      typeof server === 'string'
        ? server
        : record(server)
          ? [server.import, server.default].find((item) => typeof item === 'string')
          : undefined
    const main = typeof metadata?.main === 'string' ? metadata.main.trim() : undefined
    const configured = serverEntry || main
    if (configured) {
      if (configured.includes('\0')) throw appError('error.pluginEntry')
      entryPath = configured.startsWith('file://')
        ? fileURLToPath(configured)
        : resolve(directory, configured)
      // Physical containment additionally rejects a package entry symlink escaping its package.
      if (
        !contained(directory, entryPath) ||
        !contained(await realpath(directory), await realpath(entryPath))
      )
        throw appError('error.pluginOutside')
      entryKind = serverEntry ? 'server-export' : 'main'
    } else if (selected.isDirectory()) {
      // A package directory with neither a main entry nor exports needs native directory import
      // semantics. Do not guess that it behaves like the explicit index fallback below.
      if (metadata && !record(exports)) throw appError('error.pluginEntry')
      let index: string | undefined
      for (const name of indexNames) {
        const candidate = join(directory, name)
        if (await pathStat(candidate)) {
          index = candidate
          break
        }
      }
      if (!index) throw appError('error.pluginEntry')
      entryPath = index
      if (!contained(resolvedPath, await realpath(entryPath))) throw appError('error.pluginOutside')
      entryKind = 'index'
    }
    if (!['.js', '.mjs', '.cjs', '.ts', '.tsx'].includes(extname(entryPath)))
      throw appError('error.pluginEntry')
    const entry = await inspectFile(entryPath, pluginInspectionLimits.entryBytes, false)
    if (!entry.observation.bytes) throw appError('error.pluginEntry')
    if (
      entryKind !== 'file' &&
      !contained(await realpath(directory), entry.observation.resolvedPath)
    )
      throw appError('error.pluginOutside')
    // A metadata edit, path replacement, or new package file changes the resolution just inspected.
    if (
      identity(selected) !== identity(await stat(selectedPath, { bigint: true })) ||
      resolvedPath !== (await realpath(selectedPath)) ||
      (inspectedPackage
        ? inspectedPackage.stamp !== identity(await stat(packagePath, { bigint: true })) ||
          inspectedPackage.observation.resolvedPath !== (await realpath(packagePath))
        : (await pathStat(packagePath)) !== null)
    )
      throw appError('error.pluginChanged')
    return { selectedPath, resolvedPath, entryKind, entry: entry.observation, package: pkg }
  } catch (error) {
    if (getErrorKey(error)) throw error
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw appError('error.pluginMissing')
    throw appError('error.pluginRead')
  }
}
