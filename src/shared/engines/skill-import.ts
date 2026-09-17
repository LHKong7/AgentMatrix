import { skillVersionSchema, type SkillAsset, type SkillVersion } from './workspace'

export interface CapturedSkillDirectory {
  sourcePath: string
  snapshot: Extract<SkillVersion, { kind: 'directory' }>
}

/** A new asset replaces its empty draft; an existing asset keeps every saved version. */
export function importSkillRevision(
  asset: SkillAsset,
  capture: CapturedSkillDirectory,
  isNew: boolean,
): SkillAsset {
  const snapshot = skillVersionSchema.parse(capture.snapshot)
  if (snapshot.kind !== 'directory') throw new Error('Expected a directory capture')
  const current = asset.versions.find((item) => item.version === asset.currentVersion)
  if (current?.kind === 'directory' && current.digest === snapshot.digest)
    return { ...asset, sourcePath: capture.sourcePath }
  const version = isNew ? 1 : Math.max(...asset.versions.map((item) => item.version)) + 1
  const revision = { ...snapshot, version }
  return {
    ...asset,
    sourcePath: capture.sourcePath,
    currentVersion: version,
    versions: isNew ? [revision] : [...asset.versions, revision],
  }
}
