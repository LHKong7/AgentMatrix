import { lstat, realpath } from 'node:fs/promises'
import { dirname, isAbsolute, join } from 'node:path'
import { observeExternalFile } from '../../run-input-store'
import { appError } from '../../../../shared/errors'
import type { GeneratedInputs } from '../../../../shared/engines/run-inputs'

export interface OpenCodeNativeLocations {
  home: string
  configHome: string
  managedDirectory?: string
  managedPreferences?: string[]
}

/** Known config/rule candidates only; plugin trees, remote sources, and discovered Skills remain partial. */
export async function inspectOpenCodeSources(
  cwd: string,
  locations: OpenCodeNativeLocations,
): Promise<GeneratedInputs['externalSources']> {
  if (
    ![
      cwd,
      locations.home,
      locations.configHome,
      ...(locations.managedPreferences ?? []),
      ...(locations.managedDirectory ? [locations.managedDirectory] : []),
    ].every(isAbsolute)
  )
    throw appError('error.openCodeConfiguration', { feature: 'native.source-path' })
  const paths = new Set<string>()
  const global = join(locations.configHome, 'opencode')
  for (const name of ['config.json', 'opencode.json', 'opencode.jsonc', 'AGENTS.md'])
    paths.add(join(global, name))
  paths.add(join(locations.home, '.claude', 'CLAUDE.md'))
  for (const name of ['opencode.json', 'opencode.jsonc'])
    paths.add(join(locations.home, '.opencode', name))
  let current = await realpath(cwd)
  for (let depth = 0; depth < 100; depth++) {
    for (const name of ['opencode.json', 'opencode.jsonc', 'AGENTS.md', 'CLAUDE.md', 'CONTEXT.md'])
      paths.add(join(current, name))
    for (const name of ['opencode.json', 'opencode.jsonc'])
      paths.add(join(current, '.opencode', name))
    const git = await lstat(join(current, '.git')).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== 'ENOENT') throw error
      return null
    })
    const parent = dirname(current)
    if (git || parent === current) break
    if (depth === 99)
      throw appError('error.openCodeConfiguration', { feature: 'native.source-depth' })
    current = parent
  }
  if (locations.managedDirectory)
    for (const name of ['opencode.json', 'opencode.jsonc'])
      paths.add(join(locations.managedDirectory, name))
  for (const path of locations.managedPreferences ?? []) paths.add(path)
  const files = []
  for (const path of [...paths].sort()) files.push(await observeExternalFile(path))
  return { coverage: 'partial', files }
}
