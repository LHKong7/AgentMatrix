import { credentialReachesEngine } from './provider'
import type { AgentProfile, EngineInstallation, ModelConnection, ModelProfile } from './schema'
import {
  engineWorkspaceSchema,
  type EngineWorkspace,
  type McpDefinition,
  type SharedSetup,
  type SkillVersion,
} from './workspace'

/** Marks a prompt, Skill or tool that came from the workspace-wide setup. */
export const sharedSource = 'shared'

/** The shared setup an agent inherits, or null when that agent opted out. */
export function sharedSetupFor(workspace: EngineWorkspace, agentId: string): SharedSetup | null {
  const setup = workspace.sharedSetup
  return setup.excludedAgentIds.includes(agentId) ? null : setup
}

export type ResolutionIssueCode =
  | 'agent-missing'
  | 'agent-disabled'
  | 'engine-required'
  | 'engine-unprobed'
  | 'model-required'
  | 'connection-required'
  | 'engine-binding-required'
  | 'protocol-required'
  | 'endpoint-required'
  | 'authentication-required'
  | 'secret-required'
  | 'cwd-required'
  | 'prompt-mode-required'
  | 'replacement-conflict'
  | 'binding-conflict'
  | 'native-plugin-mismatch'
  | 'engine-options-mismatch'
export interface ResolutionIssue {
  code: ResolutionIssueCode
  path: string
}
export interface ResolvedPrompt {
  assetId: string
  version: number
  mode: 'append' | 'replace' | 'project-rule'
  content: string
  source: string
}
export interface ResolvedSkill {
  assetId: string
  name: string
  revision: SkillVersion
  source: string
}
export interface ResolvedAgentConfiguration {
  agent: AgentProfile
  installation: EngineInstallation
  model: ModelProfile
  connection: ModelConnection
  prompts: ResolvedPrompt[]
  skills: ResolvedSkill[]
  mcpServers: McpDefinition[]
  nativePlugins: EngineWorkspace['nativePlugins']
}
export type ProfileResolution =
  | { status: 'invalid'; issues: ResolutionIssue[] }
  | {
      status: 'resolved'
      configuration: ResolvedAgentConfiguration
      requiresAdapterValidation: true
    }

type Binding = AgentProfile['promptBindings'][number] | AgentProfile['skillBindings'][number]

/** Direct bindings override bundles by asset ID. Conflicting peer bindings are errors. */
function mergeBindings<T extends Binding>(
  direct: T[],
  bundled: { binding: T; source: string }[],
  path: string,
  issues: ResolutionIssue[],
): { binding: T; source: string }[] {
  const selected = new Map<string, { binding: T; source: string }>()
  const directIds = new Set(direct.map((binding) => binding.assetId))
  for (const entry of [
    ...direct.map((binding) => ({ binding, source: 'agent' })),
    ...bundled.filter((entry) => !directIds.has(entry.binding.assetId)),
  ]) {
    const previous = selected.get(entry.binding.assetId)
    if (!previous) selected.set(entry.binding.assetId, entry)
    else if (JSON.stringify(previous.binding) !== JSON.stringify(entry.binding)) {
      issues.push({ code: 'binding-conflict', path: `${path}.${entry.binding.assetId}` })
    }
  }
  return [...selected.values()]
}

/** Resolves shared intent only. Native policy, secret availability, and protocol checks still gate launch. */
export function resolveAgentProfile(input: EngineWorkspace, agentId: string): ProfileResolution {
  // Parsing copies the document: a subsequent library edit cannot mutate a returned resolution.
  return resolveParsedProfile(engineWorkspaceSchema.parse(input), agentId)
}

/** Validate and copy once when comparing many profiles in one workspace revision. */
export function resolveAgentProfiles(input: EngineWorkspace): Map<string, ProfileResolution> {
  const workspace = engineWorkspaceSchema.parse(input)
  return new Map(
    workspace.agents.map((agent) => [agent.id, resolveParsedProfile(workspace, agent.id)]),
  )
}

function resolveParsedProfile(workspace: EngineWorkspace, agentId: string): ProfileResolution {
  const issues: ResolutionIssue[] = []
  const issue = (code: ResolutionIssueCode, path: string) => issues.push({ code, path })
  const agent = workspace.agents.find((item) => item.id === agentId)
  if (!agent) return { status: 'invalid', issues: [{ code: 'agent-missing', path: 'agentId' }] }
  if (!agent.enabled) issue('agent-disabled', 'enabled')
  const installation = workspace.installations.find(
    (item) => item.id === agent.engineInstallationId,
  )
  if (!installation) issue('engine-required', 'engineInstallationId')
  else {
    if (!installation.version || !installation.probedAt || !installation.modes.length)
      issue('engine-unprobed', 'engineInstallationId')
    if (agent.engineOptions && agent.engineOptions.kind !== installation.kind)
      issue('engine-options-mismatch', 'engineOptions')
  }
  const model = workspace.models.find((item) => item.id === agent.modelProfileId)
  if (!model || !model.modelId) issue('model-required', 'modelProfileId')
  const connection = workspace.connections.find((item) => item.id === model?.connectionId)
  if (!connection) issue('connection-required', 'modelProfileId.connectionId')
  else {
    // The connection is managed once for the workspace, but reaching this CLI is a separate,
    // explicit grant. Without it the engine is never handed this provider's credential.
    if (installation && !credentialReachesEngine(workspace, installation.id, connection.id))
      issue('engine-binding-required', 'modelProfileId.connectionId')
    if (!connection.protocol) issue('protocol-required', 'connection.protocol')
    if (!connection.baseUrl && !['engine-login', 'cloud-identity'].includes(connection.auth.kind))
      issue('endpoint-required', 'connection.baseUrl')
    if (connection.auth.kind === 'unconfigured') issue('authentication-required', 'connection.auth')
    if (
      (connection.auth.kind === 'api-key' || connection.auth.kind === 'bearer') &&
      !connection.auth.secret
    )
      issue('secret-required', 'connection.auth.secret')
  }
  if (!agent.execution.cwd) issue('cwd-required', 'execution.cwd')
  // Instructions, Skills and tools come from the shared setup unless this agent opted out;
  // the engine, model route and endpoint stay the agent's own.
  const shared = sharedSetupFor(workspace, agent.id)
  const bundles = [...new Set([...(shared?.bundleIds ?? []), ...agent.bundleIds])]
    .map((id) => workspace.bundles.find((item) => item.id === id)!)
    .filter((item) => item.enabled)
  const inherited = <T>(bindings: T[]) =>
    bindings.map((binding) => ({ binding, source: sharedSource }))
  const promptBindings = mergeBindings(
    agent.promptBindings,
    [
      ...inherited(shared?.promptBindings ?? []),
      ...bundles.flatMap((bundle) =>
        bundle.promptBindings.map((binding) => ({ binding, source: `bundle:${bundle.id}` })),
      ),
    ],
    'promptBindings',
    issues,
  )
  const prompts: ResolvedPrompt[] = []
  for (const { binding, source } of promptBindings) {
    const asset = workspace.prompts.find((item) => item.id === binding.assetId)!
    if (!asset.enabled) continue
    if (!binding.mode) {
      issue('prompt-mode-required', `promptBindings.${asset.id}.mode`)
      continue
    }
    const number =
      binding.selection.follow === 'latest' ? asset.currentVersion : binding.selection.version
    const revision = asset.versions.find((item) => item.version === number)!
    prompts.push({
      assetId: asset.id,
      version: number,
      mode: binding.mode,
      content: revision.content,
      source,
    })
  }
  if (prompts.filter((prompt) => prompt.mode === 'replace').length > 1)
    issue('replacement-conflict', 'promptBindings')
  const skillBindings = mergeBindings(
    agent.skillBindings,
    [
      ...inherited(shared?.skillBindings ?? []),
      ...bundles.flatMap((bundle) =>
        bundle.skillBindings.map((binding) => ({ binding, source: `bundle:${bundle.id}` })),
      ),
    ],
    'skillBindings',
    issues,
  )
  const skills: ResolvedSkill[] = []
  for (const { binding, source } of skillBindings) {
    const asset = workspace.skills.find((item) => item.id === binding.assetId)!
    if (!asset.enabled) continue
    const number =
      binding.selection.follow === 'latest' ? asset.currentVersion : binding.selection.version
    skills.push({
      assetId: asset.id,
      name: asset.name,
      revision: asset.versions.find((item) => item.version === number)!,
      source,
    })
  }
  const mcpIds = new Set([
    ...agent.mcpServerIds,
    ...(shared?.mcpServerIds ?? []),
    ...bundles.flatMap((bundle) => bundle.mcpServerIds),
  ])
  const mcpServers = [...mcpIds]
    .map((id) => workspace.mcpServers.find((item) => item.id === id)!)
    .filter((item) => item.enabled)
  for (const server of mcpServers) {
    if (server.transport !== 'stdio' && server.auth.kind === 'bearer' && !server.auth.secret)
      issue('secret-required', `mcpServers.${server.id}.auth.secret`)
  }
  const nativePlugins = agent.nativePluginIds.map((id) =>
    workspace.nativePlugins.find((item) => item.id === id)!,
  )
  for (const plugin of nativePlugins) {
    if (plugin.engineInstallationId !== agent.engineInstallationId)
      issue('native-plugin-mismatch', `nativePluginIds.${plugin.id}`)
  }
  if (issues.length || !installation || !model || !connection) return { status: 'invalid', issues }
  return {
    status: 'resolved',
    configuration: {
      agent,
      installation,
      model,
      connection,
      prompts,
      skills,
      mcpServers,
      nativePlugins,
    },
    requiresAdapterValidation: true,
  }
}
