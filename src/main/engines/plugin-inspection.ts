import { pathToFileURL } from 'node:url'
import { appError, getErrorKey } from '../../shared/errors'
import { engineContracts, isSupportedEngine } from '../../shared/engines/contracts'
import {
  pluginInspectionQuerySchema,
  nativePluginInspectionSchema,
  type PluginInspection,
} from '../../shared/engines/plugin-inspection'
import type { EngineWorkspace } from '../../shared/engines/workspace'
import { inspectOpenCodePlugin } from './adapters/opencode/plugin-inspection'
import { inspectPiPlugin } from './adapters/pi/plugin-inspection'
import { inspectDshPlugin } from './adapters/dsh/plugin-inspection'
import { pluginEngineRangeStatus } from './plugin-engine-range'
import type { ExternalFile } from '../../shared/engines/run-inputs'
import { inspectFile } from './installed-plugin-files'

type MultiEngineInspection = Exclude<PluginInspection, { engine: 'opencode' }>
const piPeers = ['@earendil-works/pi-coding-agent', '@mariozechner/pi-coding-agent']
const dshPeers = [
  '@deepseek-ai/dsh',
  '@deepseek-ai/dsh-app-boot',
  '@deepseek-ai/dsh-acp',
  '@deepseek-ai/cordis',
  '@deepseek-ai/cordis-plugin-loader',
  '@deepseek-ai/cordis-plugin-include',
]

/** Read names and declarations from the already resolved package, checking its exact observation. */
async function packageDetails(file: ExternalFile | undefined) {
  if (!file?.exists) return null
  const current = await inspectFile(file.path, 256 * 1024, true)
  if (
    current.observation.sha256 !== file.sha256 ||
    current.observation.resolvedPath !== file.resolvedPath
  )
    throw appError('error.pluginChanged')
  // The engine resolver already validated the package and its peer declarations.
  const metadata = JSON.parse(
    new TextDecoder('utf-8', { fatal: true }).decode(current.content!),
  ) as {
    name?: unknown
    peerDependencies?: Record<string, string>
  }
  let name: string | null = null
  if (metadata.name !== undefined) {
    if (
      typeof metadata.name !== 'string' ||
      !metadata.name.trim() ||
      metadata.name.trim().length > 200 ||
      [...metadata.name].some((char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127)
    )
      throw appError('error.pluginMetadata')
    name = metadata.name.trim()
  }
  return {
    file: current.observation,
    name,
    peers: metadata.peerDependencies ?? {},
  }
}

export async function inspectNativePlugin(
  workspace: EngineWorkspace,
  input: unknown,
): Promise<PluginInspection> {
  const query = pluginInspectionQuerySchema.parse(input)
  const installation = workspace.installations.find((item) => item.id === query.installationId)
  if (!installation || !isSupportedEngine(installation.kind)) throw appError('error.pluginEngine')
  const common = {
    engine: installation.kind,
    installationId: installation.id,
    engineVersion: installation.version,
    resolverVersion: engineContracts[installation.kind].engineVersion,
    checkedAt: new Date().toISOString(),
    verification: 'files-only',
  } as const
  if (installation.kind === 'opencode') {
    const files = await inspectOpenCodePlugin(query.path)
    return nativePluginInspectionSchema.parse({
      ...common,
      ...files,
      localSpecifier: pathToFileURL(files.selectedPath).href,
      rangeStatus: pluginEngineRangeStatus(files.package?.engineRange ?? null, installation),
    })
  }
  try {
    const files =
      installation.kind === 'pi'
        ? await inspectPiPlugin(query.path)
        : await inspectDshPlugin(query.path)
    const metadata = await packageDetails(
      'packageFile' in files ? files.packageFile : files.metadata.find((file) => file.exists),
    )
    const names = installation.kind === 'pi' ? piPeers : dshPeers
    const declared = names.filter((name) => Object.hasOwn(metadata?.peers ?? {}, name))
    const requirements: MultiEngineInspection['requirements'] = declared.map((name) => {
      const isEngine = installation.kind === 'pi' || name === '@deepseek-ai/dsh'
      const version = isEngine ? installation.version : null
      const range = metadata!.peers[name]!
      return {
        name,
        range,
        version,
        source: isEngine ? 'saved-engine' : 'unverified-dependency',
        status: pluginEngineRangeStatus(
          range,
          isEngine ? installation : { version: null, probedAt: null },
        ),
      }
    })
    if (!requirements.length)
      requirements.push({
        name: installation.kind === 'pi' ? 'Pi' : 'DeepSeek Harness',
        range: null,
        version: installation.version,
        source: 'saved-engine',
        status: 'undeclared',
      })
    return nativePluginInspectionSchema.parse({
      ...common,
      selectedPath: files.selectedPath,
      resolvedPath: files.resolvedPath,
      localSpecifier: pathToFileURL(files.selectedPath).href,
      entries: ('entries' in files ? files.entries : [files.entry]).map(
        ({ path, resolvedPath, sha256, bytes }) => ({ path, resolvedPath, sha256, bytes }),
      ),
      package: metadata
        ? { file: metadata.file, name: metadata.name, version: files.packageVersion }
        : null,
      requirements,
    })
  } catch (error) {
    if (getErrorKey(error)) throw error
    throw appError('error.pluginRead')
  }
}
