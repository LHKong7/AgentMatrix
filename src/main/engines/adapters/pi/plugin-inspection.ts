import { realpath, stat } from 'node:fs/promises'
import { dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { z } from 'zod'
import { appError, getErrorKey } from '../../../../shared/errors'
import { externalFileSchema } from '../../../../shared/engines/run-inputs'
import { observeExternalFile } from '../../run-input-store'
import { fileIdentity, inspectFile } from '../../installed-plugin-files'

export const piPluginInspectionSchema = z
  .object({
    selectedPath: z.string(),
    resolvedPath: z.string(),
    entries: z.array(externalFileSchema.options[1]).min(1).max(100),
    packageFile: externalFileSchema,
    packageVersion: z.string().nullable(),
    engineRanges: z.array(z.string()).max(2),
  })
  .strict()
export type PiPluginInspection = z.infer<typeof piPluginInspectionSchema>
const metadataSchema = z.object({
  version: z.string().trim().min(1).max(100).optional(),
  peerDependencies: z.record(z.string(), z.string().trim().min(1).max(200)).optional(),
  pi: z
    .object({
      extensions: z.array(z.string().min(1).max(4000)).max(100).optional(),
      skills: z.array(z.string()).optional(),
      prompts: z.array(z.string()).optional(),
      themes: z.array(z.string()).optional(),
    })
    .optional(),
})
const contains = (root: string, path: string) => {
  const suffix = relative(root, path)
  return suffix !== '..' && !suffix.startsWith(`..${sep}`) && !isAbsolute(suffix)
}

/** Resolve installed files only; no factory evaluation, package installation, or dependency import. */
export async function inspectPiPlugin(path: string): Promise<PiPluginInspection> {
  try {
    if (!isAbsolute(path)) throw appError('error.pluginPath')
    const selectedPath = resolve(path),
      resolvedPath = await realpath(selectedPath)
    const before = await stat(selectedPath, { bigint: true })
    if (!before.isDirectory() && !before.isFile()) throw appError('error.pluginFile')
    const directory = before.isDirectory() ? selectedPath : dirname(selectedPath)
    const packagePath = join(directory, 'package.json')
    const packageExists = await stat(packagePath).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== 'ENOENT') throw error
      return null
    })
    const packageRead = packageExists ? await inspectFile(packagePath, 256 * 1024, true) : null
    let metadata: z.infer<typeof metadataSchema> = {}
    if (packageRead) {
      try {
        metadata = metadataSchema.parse(
          JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(packageRead.content!)),
        )
      } catch {
        throw appError('error.pluginMetadata')
      }
    }
    let entryPaths = [selectedPath]
    if (before.isDirectory()) {
      if (['skills', 'prompts', 'themes'].some((name) => metadata.pi?.[name as 'skills']?.length))
        throw appError('error.piPluginResources')
      if (metadata.pi?.extensions?.length) {
        if (
          metadata.pi.extensions.some((entry) => entry.includes('\0') || /[!*?{}[\]]/.test(entry))
        )
          throw appError('error.piPluginEntry')
        entryPaths = metadata.pi.extensions.map((entry) => resolve(directory, entry))
      } else {
        if (metadata.pi) throw appError('error.piPluginEntry')
        const candidates: string[] = []
        for (const name of ['index.ts', 'index.js']) {
          try {
            await stat(join(directory, name))
            candidates.push(join(directory, name))
            break
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
          }
        }
        if (!candidates.length) throw appError('error.piPluginEntry')
        entryPaths = candidates
      }
    }
    const entries: PiPluginInspection['entries'] = []
    const seen = new Set<string>()
    for (const entryPath of entryPaths) {
      if (!['.ts', '.js', '.mjs', '.cjs', '.tsx'].includes(extname(entryPath)))
        throw appError('error.piPluginEntry')
      if (
        before.isDirectory() &&
        (!contains(directory, entryPath) || !contains(resolvedPath, await realpath(entryPath)))
      )
        throw appError('error.pluginOutside')
      const file = await inspectFile(entryPath, 20_000_000, false)
      if (!file.observation.bytes) throw appError('error.piPluginEntry')
      if (!seen.has(file.observation.resolvedPath)) {
        seen.add(file.observation.resolvedPath)
        entries.push({ ...file.observation, exists: true })
      }
    }
    const packageFile = packageRead
      ? { ...packageRead.observation, exists: true as const }
      : { path: packagePath, exists: false as const }
    const currentPackage = await observeExternalFile(packagePath)
    if (
      fileIdentity(before) !== fileIdentity(await stat(selectedPath, { bigint: true })) ||
      resolvedPath !== (await realpath(selectedPath)) ||
      packageFile.exists !== currentPackage.exists ||
      (packageFile.exists &&
        currentPackage.exists &&
        (packageFile.sha256 !== currentPackage.sha256 ||
          packageFile.resolvedPath !== currentPackage.resolvedPath))
    )
      throw appError('error.pluginChanged')
    const engineRanges = [
      '@earendil-works/pi-coding-agent',
      '@mariozechner/pi-coding-agent',
    ].flatMap((name) =>
      metadata.peerDependencies?.[name] ? [metadata.peerDependencies[name]!] : [],
    )
    return {
      selectedPath,
      resolvedPath,
      entries,
      packageFile,
      packageVersion: metadata.version ?? null,
      engineRanges,
    }
  } catch (error) {
    if (getErrorKey(error)) throw error
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw appError('error.pluginMissing')
    throw appError('error.pluginRead')
  }
}
