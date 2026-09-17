import { dirname, join } from 'node:path'
import { realpath } from 'node:fs/promises'
import { observeExternalFile } from '../../run-input-store'
import type { GeneratedInputs } from '../../../../shared/engines/run-inputs'
import { appError } from '../../../../shared/errors'

/** Pi context discovery walks to the filesystem root, independently of project trust. */
export async function inspectPiSources(cwd: string): Promise<GeneratedInputs['externalSources']> {
  let directory = await realpath(cwd)
  const paths = new Set(
    ['settings.json', 'SYSTEM.md', 'APPEND_SYSTEM.md'].map((name) => join(directory, '.pi', name)),
  )
  for (let depth = 0; ; depth++) {
    for (const name of ['AGENTS.override.md', 'AGENTS.md', 'AGENTS.MD', 'CLAUDE.md', 'CLAUDE.MD'])
      paths.add(join(directory, name))
    const parent = dirname(directory)
    if (parent === directory) break
    if (depth >= 99) throw appError('error.piConfiguration', { feature: 'native.source-depth' })
    directory = parent
  }
  const files = []
  for (const path of [...paths].sort()) files.push(await observeExternalFile(path))
  return { coverage: 'partial', files }
}
