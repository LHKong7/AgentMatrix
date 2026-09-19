import { lstat, realpath } from 'node:fs/promises'
import { dirname, isAbsolute, join } from 'node:path'
import { observeExternalFile, observeResourceDirectory } from '../../external-sources'
import { appError } from '../../../../shared/errors'
import type { GeneratedInputs } from '../../../../shared/engines/run-inputs'
import { inspectOpenCodeInstructions } from './instructions'

export interface OpenCodeNativeLocations {
  home: string
  configHome: string
  managedDirectory?: string
  managedPreferences?: string[]
}

/** Config/rules and native Markdown resources; plugin trees, remote sources, and Skills remain partial. */
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
  const resourceRoots = new Set([global, join(locations.home, '.opencode')])
  for (const name of ['config.json', 'opencode.json', 'opencode.jsonc', 'AGENTS.md'])
    paths.add(join(global, name))
  paths.add(join(locations.home, '.claude', 'CLAUDE.md'))
  for (const name of ['opencode.json', 'opencode.jsonc'])
    paths.add(join(locations.home, '.opencode', name))
  let current = await realpath(cwd)
  const instructionRoots: string[] = []
  for (let depth = 0; depth < 100; depth++) {
    instructionRoots.push(current)
    resourceRoots.add(join(current, '.opencode'))
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
  const directories = []
  let resourceFiles = 0
  let resourceBytes = 0
  for (const root of [...resourceRoots].sort())
    for (const [name, kind] of [
      ['agent', 'opencode-agent'],
      ['agents', 'opencode-agent'],
      ['mode', 'opencode-mode'],
      ['modes', 'opencode-mode'],
      ['command', 'opencode-command'],
      ['commands', 'opencode-command'],
    ] as const) {
      const directory = await observeResourceDirectory(join(root, name), kind)
      resourceFiles += directory.observation.exists ? directory.observation.files.length : 0
      if (directory.observation.exists)
        resourceBytes += directory.observation.files.reduce(
          (sum, file) => sum + (file.exists ? file.bytes : 0),
          0,
        )
      if (resourceFiles > 1000 || resourceBytes > 256 * 1024 * 1024)
        throw appError('error.runLimit')
      directories.push(directory)
    }
  const instructionSources = await inspectOpenCodeInstructions(
    files.filter((file) => /\.(?:json|jsonc)$/.test(file.path)),
    instructionRoots,
    locations.home,
  )
  return { coverage: 'partial', files, directories, instructionSources }
}
