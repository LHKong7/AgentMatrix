import type { ConfigurationField } from './configuration-report'
import type { ResolvedAgentConfiguration } from './resolution'
import type { RunInputManifest } from './run-inputs'

export const canonicalIntent = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(canonicalIntent).join(',')}]`
  if (value !== null && typeof value === 'object')
    return `{${Object.entries(value)
      .filter(([, item]) => item !== undefined)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonicalIntent(item)}`)
      .join(',')}}`
  return JSON.stringify(value)
}
export type ConfigurationIntent = Record<ConfigurationField, unknown>
type CommonInputs = Pick<RunInputManifest, 'installation' | 'connection' | 'agent' | 'model'>
function common(value: CommonInputs) {
  const { installation: i, connection: c } = value
  return {
    installation: {
      id: i.id,
      kind: i.kind,
      executable: i.executable,
      prefixArgs: i.prefixArgs,
      version: i.version,
      platform: i.platform,
      modes: i.modes,
    },
    connection: {
      id: c.id,
      protocol: c.protocol,
      baseUrl: c.baseUrl,
      auth: c.auth,
      headers: c.headers,
      secretHeaders: c.secretHeaders,
    },
    authentication: { auth: c.auth, secretHeaders: c.secretHeaders },
    model: value.model.modelId,
    sampling: {
      temperature: value.model.parameters.temperature,
      topP: value.model.parameters.topP,
    },
    reasoning: value.model.parameters.reasoning ?? null,
    execution: value.agent.execution,
    'engine-options': value.agent.engineOptions,
  }
}
/** In-memory comparison data. Do not expose this projection: it can contain ordinary header/env values. */
export function resolvedIntent(value: ResolvedAgentConfiguration): ConfigurationIntent {
  return {
    ...common(value),
    prompts: value.prompts.map(({ assetId, version, source, mode }) => ({
      assetId,
      version,
      source,
      mode,
    })),
    skills: value.skills.map(({ assetId, revision, source, name }) => ({
      assetId,
      version: revision.version,
      source,
      name,
    })),
    mcp: value.mcpServers,
    plugins: value.nativePlugins,
  }
}
export function capturedIntent(value: RunInputManifest): ConfigurationIntent {
  return {
    ...common(value),
    prompts: value.prompts.map(({ assetId, version, source, mode }) => ({
      assetId,
      version,
      source,
      mode,
    })),
    skills: value.skills.map(({ assetId, version, source, name }) => ({
      assetId,
      version,
      source,
      name,
    })),
    mcp: value.mcpServers,
    plugins: value.nativePlugins,
  }
}
export function changedIntentFields(
  before: ConfigurationIntent,
  after: ConfigurationIntent,
): ConfigurationField[] {
  return (Object.keys(before) as ConfigurationField[]).filter(
    (key) => canonicalIntent(before[key]) !== canonicalIntent(after[key]),
  )
}
