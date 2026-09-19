import { basename, dirname, isAbsolute, join } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import type {
  ExternalFile,
  InstructionSearch,
  InstructionSources,
} from '../../../../shared/engines/run-inputs'
import { appError } from '../../../../shared/errors'
import { parseNativeJsonc } from '../../../native-import/jsonc'
import { inspectFile } from '../../installed-plugin-files'
import { observeInstructionSearches } from '../../instruction-sources'

/** Read literal instruction selectors only. No CLI, macro resolution, network or secret access. */
export async function inspectOpenCodeInstructions(
  configs: ExternalFile[],
  roots: string[],
  home: string,
): Promise<InstructionSources> {
  const result: InstructionSources = { version: 1, patterns: [], unobserved: [] }
  const deadline = Date.now() + 30_000
  let totalFiles = 0,
    totalBytes = 0
  for (const source of configs) {
    if (!source.exists) continue
    const unobserved = (
      index: number | null,
      reason: InstructionSources['unobserved'][number]['reason'],
    ) => {
      result.unobserved.push({ source: source.path, index, reason })
      if (result.unobserved.length > 1000) throw appError('error.runLimit')
    }
    if (source.bytes > 4_194_304) {
      unobserved(null, 'configuration')
      continue
    }
    const read = await inspectFile(source.path, 4_194_304, true)
    if (!isDeepStrictEqual({ ...read.observation, exists: true }, source))
      throw appError('error.runSourceChanged')
    let instructions: unknown
    try {
      instructions = parseNativeJsonc(
        new TextDecoder('utf8', { fatal: true }).decode(read.content!),
      ).instructions
    } catch {
      unobserved(null, 'configuration')
      continue
    }
    if (instructions === undefined) continue
    if (!Array.isArray(instructions) || instructions.some((item) => typeof item !== 'string')) {
      unobserved(null, 'configuration')
      continue
    }
    for (const [index, raw] of (instructions as string[]).entries()) {
      if (/^https?:\/\//.test(raw)) {
        unobserved(index, 'remote')
        continue
      }
      if (/\{(?:env|file):/.test(raw)) {
        unobserved(index, 'dynamic')
        continue
      }
      if (!raw || raw.length > 1024 || raw.includes('\0')) {
        unobserved(index, 'configuration')
        continue
      }
      const pattern = raw.startsWith('~/') ? join(home, raw.slice(2)) : raw
      const searches: InstructionSearch[] = isAbsolute(pattern)
        ? [{ cwd: dirname(pattern), pattern: basename(pattern), dot: false }]
        : roots.map((cwd) => ({ cwd, pattern, dot: true }))
      const files = await observeInstructionSearches(searches, deadline)
      result.patterns.push({ source: source.path, index, searches, files })
      totalFiles += files.length
      totalBytes += files.reduce((sum, file) => sum + (file.exists ? file.bytes : 0), 0)
      if (result.patterns.length > 200 || totalFiles > 1000 || totalBytes > 256 * 1024 * 1024)
        throw appError('error.runLimit')
    }
  }
  return result
}
