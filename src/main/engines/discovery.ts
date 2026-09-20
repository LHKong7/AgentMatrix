import { constants } from 'node:fs'
import { access, mkdir, mkdtemp, rm, realpath, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { delimiter, join } from 'node:path'
import { appError } from '../../shared/errors'
import { engineContracts, type SupportedEngine } from '../../shared/engines/contracts'
import {
  downloadArguments,
  engineCandidateSchema,
  engineDiscoverySchema,
  engineDownloadQuerySchema,
  engineDownloadResultSchema,
  engineDownloads,
  entryStatus,
  type EngineCandidate,
  type EngineDiscovery,
  type EngineDownloadResult,
} from '../../shared/engines/discovery'
import type { EngineWorkspace } from '../../shared/engines/workspace'
import { baseProcessEnvironment } from './process/managed-process'
import { captureCommand } from './process/capture-command'

interface DiscoveryDependencies {
  environment: NodeJS.ProcessEnv
  dataDirectory: string
  workspace: { load(): Promise<EngineWorkspace> }
}
interface SearchLocation {
  directory: string
  origin: EngineCandidate['origin']
}

const kinds = Object.keys(engineDownloads) as SupportedEngine[]
const versionPattern = /^[0-9][0-9A-Za-z.+-]{0,99}$/
/** Version reads and downloads execute a real CLI, which the process guardian supports on POSIX. */
export const discoverySupported = ['darwin', 'linux'].includes(process.platform)

export function managedEngineRoot(dataDirectory: string, kind: SupportedEngine): string {
  return join(dataDirectory, 'engines', kind)
}

/** Ordered search locations. Managed downloads win over a shell PATH entry of the same binary. */
export function searchLocations(
  environment: NodeJS.ProcessEnv,
  dataDirectory: string,
  kind: SupportedEngine,
): SearchLocation[] {
  const home = environment.HOME || homedir()
  const locations: SearchLocation[] = [
    {
      directory: join(managedEngineRoot(dataDirectory, kind), 'node_modules', '.bin'),
      origin: 'managed',
    },
  ]
  for (const directory of (environment.PATH ?? '').split(delimiter))
    if (directory) locations.push({ directory, origin: 'path' })
  for (const directory of [
    join(home, '.local', 'bin'),
    join(home, 'bin'),
    join(home, '.bun', 'bin'),
    join(home, '.deno', 'bin'),
    join(home, '.npm-global', 'bin'),
    join(home, '.volta', 'bin'),
    join(home, 'node_modules', '.bin'),
    '/usr/local/bin',
    '/opt/homebrew/bin',
    '/usr/bin',
  ])
    locations.push({ directory, origin: 'common' })
  return locations
}

async function executableAt(path: string): Promise<string | null> {
  try {
    const resolved = await realpath(path)
    if (!(await stat(resolved)).isFile()) return null
    await access(resolved, constants.X_OK)
    return resolved
  } catch {
    return null
  }
}

/** Reads a version in a throwaway configuration home so discovery never touches native state. */
async function readVersion(
  executable: string,
  environment: NodeJS.ProcessEnv,
  dataDirectory: string,
  signal: AbortSignal,
): Promise<string | null> {
  const parent = join(dataDirectory, 'probes')
  await mkdir(parent, { recursive: true, mode: 0o700 })
  const root = await mkdtemp(join(parent, 'discovery-'))
  try {
    const output = (
      await captureCommand(
        {
          executable,
          args: ['--version'],
          cwd: root,
          environment: {
            ...baseProcessEnvironment(environment),
            XDG_CONFIG_HOME: join(root, 'config'),
            XDG_DATA_HOME: join(root, 'data'),
            XDG_CACHE_HOME: join(root, 'cache'),
            XDG_STATE_HOME: join(root, 'state'),
            OPENCODE_DISABLE_AUTOUPDATE: 'true',
            PI_CODING_AGENT_DIR: join(root, 'pi'),
            DSH_HOME: join(root, 'dsh'),
            DSH_TELEMETRY_DISABLED: '1',
          },
        },
        signal,
        20_000,
      )
    ).trim()
    return versionPattern.test(output) ? output : null
  } catch {
    return null
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

async function candidatesFor(
  kind: SupportedEngine,
  dependencies: DiscoveryDependencies,
  saved: EngineWorkspace['installations'],
  signal: AbortSignal,
): Promise<EngineCandidate[]> {
  const { environment, dataDirectory } = dependencies
  const seen = new Set<string>()
  const found: { executable: string; origin: EngineCandidate['origin'] }[] = []
  for (const location of searchLocations(environment, dataDirectory, kind)) {
    if (found.length >= 4) break
    const executable = await executableAt(join(location.directory, engineDownloads[kind].binary))
    if (!executable || seen.has(executable)) continue
    seen.add(executable)
    found.push({ executable, origin: location.origin })
  }
  const candidates: EngineCandidate[] = []
  for (const entry of found) {
    const version = await readVersion(entry.executable, environment, dataDirectory, signal)
    candidates.push(
      engineCandidateSchema.parse({
        executable: entry.executable,
        version,
        matchesContract: version === engineContracts[kind].engineVersion,
        origin: entry.origin,
        installationId:
          saved.find((item) => item.kind === kind && item.executable === entry.executable)?.id ??
          null,
      }),
    )
  }
  return candidates
}

/** Read-only: it locates CLIs and reads their versions, and never edits the saved workspace. */
export async function discoverEngines(
  dependencies: DiscoveryDependencies,
  signal: AbortSignal,
): Promise<EngineDiscovery> {
  const { environment, dataDirectory } = dependencies
  const saved = discoverySupported ? (await dependencies.workspace.load()).installations : []
  const npm = discoverySupported ? await locateNpm(environment) : null
  const engines = []
  for (const kind of kinds) {
    const candidates = discoverySupported
      ? await candidatesFor(kind, dependencies, saved, signal)
      : []
    engines.push({
      kind,
      expectedVersion: engineContracts[kind].engineVersion,
      package: engineDownloads[kind].package,
      command: `npm ${downloadArguments(kind, managedEngineRoot(dataDirectory, kind)).join(' ')}`,
      status: entryStatus(candidates),
      candidates,
    })
  }
  return engineDiscoverySchema.parse({
    checkedAt: new Date().toISOString(),
    platform: process.platform,
    supported: discoverySupported,
    downloadAvailable: npm !== null,
    managedRoot: discoverySupported ? join(dataDirectory, 'engines') : null,
    engines,
  })
}

async function locateNpm(environment: NodeJS.ProcessEnv): Promise<string | null> {
  const home = environment.HOME || homedir()
  const directories = [
    ...(environment.PATH ?? '').split(delimiter).filter(Boolean),
    join(home, '.volta', 'bin'),
    join(home, '.local', 'bin'),
    '/usr/local/bin',
    '/opt/homebrew/bin',
    '/usr/bin',
  ]
  for (const directory of directories) {
    const executable = await executableAt(join(directory, 'npm'))
    if (executable) return executable
  }
  return null
}

/**
 * Installs the pinned package into the application's own directory with lifecycle scripts
 * disabled, then verifies the result by running the new executable's version command. A
 * package that needs its install scripts fails this check instead of being reported as ready.
 */
export async function downloadEngine(
  input: unknown,
  dependencies: DiscoveryDependencies,
  signal: AbortSignal,
): Promise<EngineDownloadResult> {
  const { kind } = engineDownloadQuerySchema.parse(input)
  const { environment, dataDirectory } = dependencies
  if (!discoverySupported) throw appError('error.engineDownloadUnsupported')
  const npm = await locateNpm(environment)
  if (!npm) throw appError('error.engineDownloadUnavailable')
  const prefix = managedEngineRoot(dataDirectory, kind)
  await mkdir(prefix, { recursive: true, mode: 0o700 })
  try {
    await captureCommand(
      {
        executable: npm,
        args: downloadArguments(kind, prefix),
        cwd: prefix,
        environment: {
          ...baseProcessEnvironment(environment),
          npm_config_update_notifier: 'false',
          npm_config_fund: 'false',
          npm_config_audit: 'false',
          npm_config_ignore_scripts: 'true',
        },
      },
      signal,
      600_000,
    )
  } catch {
    throw appError('error.engineDownloadFailed')
  }
  const discovery = await discoverEngines(dependencies, signal)
  const entry = discovery.engines.find((item) => item.kind === kind)
  const candidate = entry?.candidates.find(
    (item) => item.origin === 'managed' && item.version !== null,
  )
  if (!candidate) throw appError('error.engineDownloadFailed')
  return engineDownloadResultSchema.parse({ kind, candidate, discovery })
}
