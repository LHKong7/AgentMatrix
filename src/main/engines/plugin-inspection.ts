import { pathToFileURL } from 'node:url'
import { appError } from '../../shared/errors'
import { engineContracts } from '../../shared/engines/contracts'
import {
  pluginInspectionQuerySchema,
  pluginInspectionSchema,
  type PluginInspection,
} from '../../shared/engines/plugin-inspection'
import type { EngineWorkspace } from '../../shared/engines/workspace'
import { inspectOpenCodePlugin } from './adapters/opencode/plugin-inspection'

export async function inspectNativePlugin(
  workspace: EngineWorkspace,
  input: unknown,
): Promise<PluginInspection> {
  const query = pluginInspectionQuerySchema.parse(input)
  const installation = workspace.installations.find((item) => item.id === query.installationId)
  if (installation?.kind !== 'opencode') throw appError('error.pluginEngine')
  const files = await inspectOpenCodePlugin(query.path)
  return pluginInspectionSchema.parse({
    ...files,
    installationId: installation.id,
    engineVersion: installation.version,
    resolverVersion: engineContracts.opencode.engineVersion,
    checkedAt: new Date().toISOString(),
    localSpecifier: pathToFileURL(files.selectedPath).href,
    verification: 'files-only',
  })
}
