import { z } from 'zod'
import { engineContracts, type SupportedEngine } from './contracts'
import { absolutePath, entityId } from './schema'

/**
 * Published packages that provide a pinned CLI, with the command each one installs.
 * The download never takes a package, version, or command from the renderer: only the engine
 * kind crosses the IPC boundary, and lifecycle scripts stay disabled.
 */
export const engineDownloads = {
  opencode: { package: 'opencode-ai', binary: 'opencode' },
  pi: { package: '@earendil-works/pi-coding-agent', binary: 'pi' },
  'deepseek-harness': { package: '@deepseek-ai/dsh', binary: 'dsh' },
} as const satisfies Record<SupportedEngine, { package: string; binary: string }>

export const supportedEngineSchema = z.enum(['opencode', 'pi', 'deepseek-harness'])

export function downloadArguments(kind: SupportedEngine, prefix: string): string[] {
  const { package: name } = engineDownloads[kind]
  return [
    'install',
    '--prefix',
    prefix,
    '--ignore-scripts',
    '--no-audit',
    '--no-fund',
    '--save-exact',
    `${name}@${engineContracts[kind].engineVersion}`,
  ]
}

export const engineCandidateSchema = z
  .object({
    executable: absolutePath,
    /** Null when the version command could not be read; it is never assumed from a path. */
    version: z.string().min(1).max(100).nullable(),
    matchesContract: z.boolean(),
    origin: z.enum(['managed', 'path', 'common']),
    /** A saved installation already pointing at this executable, when one exists. */
    installationId: entityId.nullable(),
  })
  .strict()
export type EngineCandidate = z.infer<typeof engineCandidateSchema>

export const engineDiscoveryEntrySchema = z
  .object({
    kind: supportedEngineSchema,
    expectedVersion: z.string().min(1).max(100),
    package: z.string().min(1).max(200),
    /** The exact command a download would run, so it can also be copied and run by hand. */
    command: z.string().max(1000),
    status: z.enum(['ready', 'version-mismatch', 'missing']),
    candidates: z.array(engineCandidateSchema).max(20),
  })
  .strict()
export type EngineDiscoveryEntry = z.infer<typeof engineDiscoveryEntrySchema>

export const engineDiscoverySchema = z
  .object({
    checkedAt: z.iso.datetime(),
    platform: z.string().max(100),
    /** Discovery executes version commands, which the desktop runtime supports on POSIX only. */
    supported: z.boolean(),
    downloadAvailable: z.boolean(),
    managedRoot: z.string().max(4000).nullable(),
    engines: z.array(engineDiscoveryEntrySchema).max(10),
  })
  .strict()
export type EngineDiscovery = z.infer<typeof engineDiscoverySchema>

export const engineDownloadQuerySchema = z.object({ kind: supportedEngineSchema }).strict()
export const engineDownloadResultSchema = z
  .object({
    kind: supportedEngineSchema,
    candidate: engineCandidateSchema,
    discovery: engineDiscoverySchema,
  })
  .strict()
export type EngineDownloadResult = z.infer<typeof engineDownloadResultSchema>

export function entryStatus(candidates: EngineCandidate[]): EngineDiscoveryEntry['status'] {
  if (candidates.some((candidate) => candidate.matchesContract)) return 'ready'
  return candidates.length ? 'version-mismatch' : 'missing'
}

/** The candidate a one-click flow should adopt: a pinned match first, then any readable version. */
export function preferredCandidate(entry: EngineDiscoveryEntry): EngineCandidate | null {
  return (
    entry.candidates.find((candidate) => candidate.matchesContract) ??
    entry.candidates.find((candidate) => candidate.version !== null) ??
    entry.candidates[0] ??
    null
  )
}

/** Placeholder report for environments without a CLI runtime, such as the browser preview. */
export function unsupportedDiscovery(platform: string): EngineDiscovery {
  return engineDiscoverySchema.parse({
    checkedAt: new Date().toISOString(),
    platform,
    supported: false,
    downloadAvailable: false,
    managedRoot: null,
    engines: (Object.keys(engineDownloads) as SupportedEngine[]).map((kind) => ({
      kind,
      expectedVersion: engineContracts[kind].engineVersion,
      package: engineDownloads[kind].package,
      command: `npm ${downloadArguments(kind, '<app data>/engines/' + kind).join(' ')}`,
      status: 'missing',
      candidates: [],
    })),
  })
}
