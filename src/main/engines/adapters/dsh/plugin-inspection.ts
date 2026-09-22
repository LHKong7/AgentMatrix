import { realpath, stat } from 'node:fs/promises'
import { dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { z } from 'zod'
import { isDeepStrictEqual } from 'node:util'
import { appError, getErrorKey } from '../../../../shared/errors'
import { externalFileSchema } from '../../../../shared/engines/run-inputs'
import { inspectFile, fileIdentity } from '../../installed-plugin-files'
import { observeExternalFile } from '../../run-input-store'

export const dshPluginInspectionSchema = z
  .object({
    selectedPath: z.string(),
    resolvedPath: z.string(),
    entry: externalFileSchema.options[1],
    metadata: z.array(externalFileSchema).max(64),
    packageVersion: z.string().nullable(),
    peerDependencies: z.record(z.string(), z.string()),
  })
  .strict()
export type DshPluginInspection = z.infer<typeof dshPluginInspectionSchema>
const packageSchema = z.object({
  version: z.string().trim().min(1).max(100).optional(),
  main: z.string().min(1).max(2000).optional(),
  exports: z.unknown().optional(),
  peerDependencies: z.record(z.string(), z.string().max(200)).optional(),
})
const contains = (root: string, path: string) => {
  const suffix = relative(root, path)
  return suffix !== '..' && !suffix.startsWith(`..${sep}`) && !isAbsolute(suffix)
}
function exportTarget(value: unknown, depth = 0): string | undefined {
  if (depth > 10) throw appError('error.dshPluginEntry')
  if (typeof value === 'string') return value
  if (value === null) throw appError('error.dshPluginEntry')
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw appError('error.dshPluginEntry')
  for (const [key, child] of Object.entries(value))
    if (['node', 'import', 'default', 'node-addons'].includes(key)) {
      const target = exportTarget(child, depth + 1)
      if (target !== undefined) return target
    }
  return undefined
}

/** Resolve explicit installed modules without evaluating their exports or configuration schemas. */
export async function inspectDshPlugin(path: string): Promise<DshPluginInspection> {
  try {
    if (!isAbsolute(path)) throw appError('error.pluginPath')
    const selectedPath = resolve(path),
      resolvedPath = await realpath(selectedPath)
    const before = await stat(selectedPath, { bigint: true })
    if (!before.isDirectory() && !before.isFile()) throw appError('error.pluginFile')
    let directory = before.isDirectory() ? resolvedPath : dirname(resolvedPath)
    const metadata: DshPluginInspection['metadata'] = []
    let pkg: z.infer<typeof packageSchema> = {}
    for (let depth = 0; ; depth++) {
      const packagePath = join(directory, 'package.json')
      const present = await stat(packagePath).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== 'ENOENT') throw error
        return null
      })
      if (present) {
        const file = await inspectFile(packagePath, 256 * 1024, true)
        try {
          pkg = packageSchema.parse(
            JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(file.content!)),
          )
        } catch {
          throw appError('error.pluginMetadata')
        }
        metadata.push({ ...file.observation, exists: true })
        break
      }
      metadata.push({ path: packagePath, exists: false })
      const parent = dirname(directory)
      if (before.isDirectory() || parent === directory) break
      if (depth >= 30) throw appError('error.pluginLimit')
      directory = parent
    }
    let entryPath = resolvedPath
    if (before.isDirectory()) {
      const bundle = await observeExternalFile(join(resolvedPath, 'cordis.patch.yml'))
      metadata.push(bundle)
      if (bundle.exists) throw appError('error.dshPluginBundle')
      let target = pkg.main ?? 'index.js'
      if (pkg.exports !== undefined) {
        const exports = pkg.exports
        if (exports && typeof exports === 'object' && !Array.isArray(exports)) {
          const keys = Object.keys(exports)
          if (keys.some((key) => key.startsWith('.')) && keys.some((key) => !key.startsWith('.')))
            throw appError('error.dshPluginEntry')
        }
        const root =
          exports &&
          typeof exports === 'object' &&
          !Array.isArray(exports) &&
          Object.keys(exports).some((key) => key.startsWith('.'))
            ? (exports as Record<string, unknown>)['.']
            : exports
        target = exportTarget(root) ?? ''
        if (!target.startsWith('./')) throw appError('error.dshPluginEntry')
      }
      if (!target || target.includes('\0')) throw appError('error.dshPluginEntry')
      entryPath = resolve(resolvedPath, target)
      if (!contains(resolvedPath, entryPath) || !contains(resolvedPath, await realpath(entryPath)))
        throw appError('error.pluginOutside')
    }
    if (!['.js', '.mjs', '.cjs'].includes(extname(entryPath)))
      throw appError('error.dshPluginEntry')
    const entry = await inspectFile(entryPath, 20_000_000, false)
    if (!entry.observation.bytes) throw appError('error.dshPluginEntry')
    // A package entry may live below another package scope; capture those package boundaries too.
    let entryDirectory = dirname(entry.observation.resolvedPath)
    for (let depth = 0; before.isDirectory() && entryDirectory !== resolvedPath; depth++) {
      if (depth >= 30 || !contains(resolvedPath, entryDirectory))
        throw appError('error.pluginOutside')
      metadata.push(await observeExternalFile(join(entryDirectory, 'package.json')))
      entryDirectory = dirname(entryDirectory)
    }
    if (
      fileIdentity(before) !== fileIdentity(await stat(selectedPath, { bigint: true })) ||
      resolvedPath !== (await realpath(selectedPath))
    )
      throw appError('error.pluginChanged')
    for (const file of metadata) {
      const current = await observeExternalFile(file.path)
      if (!isDeepStrictEqual(file, current)) throw appError('error.pluginChanged')
    }
    return {
      selectedPath,
      resolvedPath,
      entry: { ...entry.observation, exists: true },
      metadata,
      packageVersion: pkg.version ?? null,
      peerDependencies: pkg.peerDependencies ?? {},
    }
  } catch (error) {
    if (getErrorKey(error)) throw error
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw appError('error.pluginMissing')
    throw appError('error.pluginRead')
  }
}
