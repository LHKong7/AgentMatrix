import { basename } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import type { RunInputManifest } from '../../../../shared/engines/run-inputs'
import {
  configurationFieldSchema,
  type ConfigurationDiagnostic,
} from '../../../../shared/engines/configuration-report'
import { parseNativeJsonc } from '../../../native-import/jsonc'
import { inspectFile } from '../../installed-plugin-files'
import { configurationMismatch, openCodeMismatches } from './configuration-mismatch'

/** Matching declarations are evidence of a possible source, never a claim about native merge order. */
export async function matchOpenCodeOverrideSources(
  manifest: RunInputManifest,
  expected: unknown,
  actual: unknown,
  signal?: AbortSignal,
): Promise<NonNullable<ConfigurationDiagnostic['sourceMatches']>> {
  const result: NonNullable<ConfigurationDiagnostic['sourceMatches']> = []
  const mismatches = openCodeMismatches(expected, actual)
  let bytes = 0
  const deadline = Date.now() + 2000
  for (const [sourceIndex, source] of manifest.externalSources.files.entries()) {
    if (signal?.aborted || Date.now() > deadline) break
    if (
      !source.exists ||
      !['config.json', 'opencode.json', 'opencode.jsonc'].includes(basename(source.path))
    )
      continue
    if (source.bytes > 1_048_576 || bytes + source.bytes > 8_388_608) continue
    bytes += source.bytes
    try {
      const read = await inspectFile(source.path, 1_048_576, true)
      if (!isDeepStrictEqual({ ...read.observation, exists: true }, source)) continue
      const parsed = parseNativeJsonc(
        new TextDecoder('utf8', { fatal: true }).decode(read.content!),
      )
      const fields = new Set<ConfigurationDiagnostic['fields'][number]>()
      for (const mismatch of mismatches) {
        let value: unknown = parsed
        for (const part of mismatch.path) {
          value =
            value !== null && typeof value === 'object' && Object.hasOwn(value, part)
              ? (value as Record<string, unknown>)[part]
              : undefined
        }
        if (value === undefined || /\{(?:file|env):/.test(JSON.stringify(value))) continue
        // JSON parsing uses null prototypes; normalize only in memory for structural comparison.
        const matches =
          isDeepStrictEqual(JSON.parse(JSON.stringify(value)), mismatch.actual) ||
          (typeof value === 'string' &&
            mismatch.path[0] === 'agent' &&
            mismatch.path.at(-1) === 'permission' &&
            configurationMismatch(value, mismatch.actual, mismatch.path.join('.')) === null)
        if (matches) for (const field of mismatch.fields) fields.add(field)
      }
      if (fields.size)
        result.push({
          sourceIndex,
          fields: configurationFieldSchema.options.filter((field) => fields.has(field)),
        })
    } catch {
      // Unreadable, changed, dynamic or unsupported sources must not replace the primary failure.
    }
  }
  return result
}
