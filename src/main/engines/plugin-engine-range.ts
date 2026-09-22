import { satisfies, valid, validRange } from 'semver'
import type { EngineInstallation } from '../../shared/engines/schema'
import type { OpenCodePluginInspection } from '../../shared/engines/plugin-inspection'

/** Compare declarations to saved probe metadata; do not turn a range match into runtime evidence. */
export function pluginEngineRangeStatus(
  range: string | null,
  installation: Pick<EngineInstallation, 'version' | 'probedAt'>,
): OpenCodePluginInspection['rangeStatus'] {
  if (range === null) return 'undeclared'
  if (!validRange(range)) return 'invalid-range'
  if (!installation.version || !installation.probedAt) return 'engine-unverified'
  if (!valid(installation.version)) return 'invalid-version'
  return satisfies(installation.version, range) ? 'matched' : 'mismatched'
}
