import { appError } from '../errors'
import { translate, type Locale, type MessageKey } from '../i18n'
import { pruneEvidence } from './evidence'
import {
  adapterVersionFor,
  bindingIssues,
  defaultRoute,
  type EngineProviderBinding,
} from './provider'
import { isSupportedEngine } from './contracts'
import type { AgentProfile, ModelProtocol } from './schema'
import {
  engineWorkspaceSchema,
  createEngineWorkspace,
  type EngineWorkspace,
  type PromptAsset,
  type SharedSetup,
  type SkillAsset,
} from './workspace'

export const collectionLabels = {
  agents: 'nav.agents',
  installations: 'config.installations',
  connections: 'config.connections',
  models: 'config.models',
  prompts: 'config.prompts',
  mcpServers: 'nav.mcpServers',
  skills: 'nav.skills',
  bundles: 'config.bundles',
  nativePlugins: 'config.nativePlugins',
} as const satisfies Record<string, MessageKey>
export type Collection = keyof typeof collectionLabels
export type LibraryCollection = Exclude<Collection, 'agents'>
export type ConfigurationEntry = EngineWorkspace[Collection][number]
export type LibraryEntry = EngineWorkspace[LibraryCollection][number]
export const libraryEntryLabels = {
  installations: 'config.itemEngine',
  connections: 'config.itemConnection',
  models: 'config.itemModel',
  prompts: 'config.itemPrompt',
  mcpServers: 'resources.mcpServers',
  skills: 'resources.skills',
  bundles: 'config.itemBundle',
  nativePlugins: 'config.itemNativePlugin',
} as const satisfies Record<LibraryCollection, MessageKey>

export function profileResourceCounts(workspace: EngineWorkspace, agent: AgentProfile) {
  const bundles = workspace.bundles.filter(
    (bundle) => bundle.enabled && agent.bundleIds.includes(bundle.id),
  )
  const enabledCount = (assets: { id: string; enabled: boolean }[], ids: string[]) => {
    const selected = new Set(ids)
    return assets.filter((asset) => asset.enabled && selected.has(asset.id)).length
  }
  return {
    prompts: enabledCount(workspace.prompts, [
      ...agent.promptBindings.map((binding) => binding.assetId),
      ...bundles.flatMap((bundle) => bundle.promptBindings.map((binding) => binding.assetId)),
    ]),
    skills: enabledCount(workspace.skills, [
      ...agent.skillBindings.map((binding) => binding.assetId),
      ...bundles.flatMap((bundle) => bundle.skillBindings.map((binding) => binding.assetId)),
    ]),
    mcp: enabledCount(workspace.mcpServers, [
      ...agent.mcpServerIds,
      ...bundles.flatMap((bundle) => bundle.mcpServerIds),
    ]),
    bundles: bundles.length,
  }
}

export function createProfile(id: string, locale: Locale): AgentProfile {
  return {
    id,
    name: translate(locale, 'defaults.newAgent'),
    description: '',
    enabled: true,
    engineInstallationId: null,
    modelProfileId: null,
    promptBindings: [],
    mcpServerIds: [],
    skillBindings: [],
    bundleIds: [],
    nativePluginIds: [],
    engineOptions: null,
    execution: { cwd: '', approval: 'ask' },
  }
}

export function createInitialEngineWorkspace(locale: Locale): EngineWorkspace {
  const workspace = createEngineWorkspace()
  const agent = createProfile('general-assistant', locale)
  agent.name = translate(locale, 'defaults.agent')
  agent.description = translate(locale, 'defaults.description')
  agent.promptBindings = [
    { assetId: 'default-prompt', selection: { follow: 'latest' }, mode: null },
  ]
  workspace.agents.push(agent)
  workspace.prompts.push({
    id: 'default-prompt',
    name: agent.name,
    description: '',
    enabled: true,
    purpose: 'role',
    currentVersion: 1,
    versions: [{ version: 1, content: translate(locale, 'defaults.prompt') }],
  })
  return workspace
}

export function createLibraryEntry(
  kind: LibraryCollection,
  id: string,
  platform: string,
): LibraryEntry {
  const base = { id, name: '', description: '', enabled: true }
  switch (kind) {
    case 'installations':
      return {
        id,
        name: '',
        kind: 'opencode',
        executable: '',
        prefixArgs: [],
        platform: platform === 'win32' ? 'win32' : platform === 'linux' ? 'linux' : 'darwin',
        version: null,
        modes: [],
        probedAt: null,
      }
    case 'connections':
      return {
        id,
        name: '',
        protocol: null,
        baseUrl: '',
        auth: { kind: 'unconfigured' },
        headers: {},
        secretHeaders: {},
      }
    case 'models':
      return { id, name: '', connectionId: null, modelId: '', parameters: {} }
    case 'prompts':
      return {
        ...base,
        purpose: 'unspecified',
        currentVersion: 1,
        versions: [{ version: 1, content: '' }],
      }
    case 'mcpServers':
      return {
        ...base,
        transport: 'stdio',
        command: '',
        args: [],
        cwd: '',
        environment: {},
        envRefs: {},
      }
    case 'skills':
      return {
        ...base,
        sourcePath: '',
        currentVersion: 1,
        versions: [{ version: 1, kind: 'markdown', content: '' }],
      }
    case 'bundles':
      return { ...base, version: '1.0.0', promptBindings: [], mcpServerIds: [], skillBindings: [] }
    case 'nativePlugins':
      return {
        id,
        name: '',
        engineInstallationId: '',
        nativeId: '',
        version: '',
        source: '',
        path: '',
      }
  }
}

export function upsertConfiguration(
  workspace: EngineWorkspace,
  kind: Collection,
  entry: ConfigurationEntry,
): EngineWorkspace {
  const entries: ConfigurationEntry[] = workspace[kind]
  const updated = entries.some((item) => item.id === entry.id)
    ? entries.map((item) => (item.id === entry.id ? entry : item))
    : [...entries, entry]
  return engineWorkspaceSchema.parse({ ...workspace, [kind]: updated })
}

/** Removing a definition preserves dependent profiles as editable drafts. */
export function removeConfiguration(
  input: EngineWorkspace,
  kind: Collection,
  id: string,
): EngineWorkspace {
  const workspace = engineWorkspaceSchema.parse(input)
  const removedPlugins = new Set(
    kind === 'installations'
      ? workspace.nativePlugins
          .filter((plugin) => plugin.engineInstallationId === id)
          .map((plugin) => plugin.id)
      : kind === 'nativePlugins'
        ? [id]
        : [],
  )
  const result = { ...workspace, [kind]: workspace[kind].filter((item) => item.id !== id) }
  if (kind === 'installations')
    result.nativePlugins = result.nativePlugins.filter((plugin) => !removedPlugins.has(plugin.id))
  if (kind === 'connections')
    result.models = result.models.map((model) =>
      model.connectionId === id ? { ...model, connectionId: null } : model,
    )
  result.agents = result.agents.map((agent) => ({
    ...agent,
    engineInstallationId:
      kind === 'installations' && agent.engineInstallationId === id
        ? null
        : agent.engineInstallationId,
    modelProfileId: kind === 'models' && agent.modelProfileId === id ? null : agent.modelProfileId,
    bundleIds:
      kind === 'bundles' ? agent.bundleIds.filter((value) => value !== id) : agent.bundleIds,
    nativePluginIds: agent.nativePluginIds.filter((value) => !removedPlugins.has(value)),
  }))
  for (const collection of ['agents', 'bundles'] as const) {
    for (const item of result[collection]) {
      if (kind === 'prompts')
        item.promptBindings = item.promptBindings.filter((binding) => binding.assetId !== id)
      if (kind === 'skills')
        item.skillBindings = item.skillBindings.filter((binding) => binding.assetId !== id)
      if (kind === 'mcpServers')
        item.mcpServerIds = item.mcpServerIds.filter((value) => value !== id)
    }
  }
  const setup = result.sharedSetup
  result.sharedSetup = {
    promptBindings:
      kind === 'prompts'
        ? setup.promptBindings.filter((binding) => binding.assetId !== id)
        : setup.promptBindings,
    skillBindings:
      kind === 'skills'
        ? setup.skillBindings.filter((binding) => binding.assetId !== id)
        : setup.skillBindings,
    mcpServerIds:
      kind === 'mcpServers'
        ? setup.mcpServerIds.filter((value) => value !== id)
        : setup.mcpServerIds,
    bundleIds:
      kind === 'bundles' ? setup.bundleIds.filter((value) => value !== id) : setup.bundleIds,
    excludedAgentIds:
      kind === 'agents'
        ? setup.excludedAgentIds.filter((value) => value !== id)
        : setup.excludedAgentIds,
  }
  // A removed engine or connection takes its grant with it: nothing stays authorized by accident.
  result.engineBindings = result.engineBindings.filter(
    (binding) =>
      !(kind === 'installations' && binding.installationId === id) &&
      !(kind === 'connections' && binding.connectionId === id),
  )
  result.evidence = pruneEvidence(result)
  return engineWorkspaceSchema.parse(result)
}

/**
 * Grants one connection to one CLI, which is the only thing that lets its credential reach that
 * CLI. Discovery, protocol compatibility and a complete requirements checklist do not.
 */
export function bindConnectionToEngine(
  input: EngineWorkspace,
  draft: {
    id: string
    installationId: string
    connectionId: string
    route?: ModelProtocol
    nativeProviderId?: string
    boundAt?: string
  },
): EngineWorkspace {
  const workspace = engineWorkspaceSchema.parse(input)
  const installation = workspace.installations.find((item) => item.id === draft.installationId)
  const connection = workspace.connections.find((item) => item.id === draft.connectionId)
  if (!installation || !connection) throw appError('error.engineBinding', { reason: 'missing' })
  const kind = isSupportedEngine(installation.kind) ? installation.kind : null
  const route =
    draft.route ??
    (kind ? defaultRoute(connection, kind) : (connection.protocol ?? 'openai-chat-completions'))
  const binding: EngineProviderBinding = {
    id: draft.id,
    installationId: draft.installationId,
    connectionId: draft.connectionId,
    route,
    nativeProviderId: draft.nativeProviderId ?? '',
    adapterVersion: adapterVersionFor(installation.kind),
    boundAt: draft.boundAt ?? new Date().toISOString(),
  }
  const issues = bindingIssues(workspace, binding)
  if (issues.length) throw appError('error.engineBinding', { reason: issues.join(', ') })
  return engineWorkspaceSchema.parse({
    ...workspace,
    engineBindings: [...workspace.engineBindings.filter((item) => item.id !== binding.id), binding],
  })
}

/** Withdraws a grant. The connection stays; this CLI stops being handed its credential. */
export function releaseEngineBinding(input: EngineWorkspace, bindingId: string): EngineWorkspace {
  const workspace = engineWorkspaceSchema.parse(input)
  const remaining = {
    ...workspace,
    engineBindings: workspace.engineBindings.filter((binding) => binding.id !== bindingId),
  }
  return engineWorkspaceSchema.parse({ ...remaining, evidence: pruneEvidence(remaining) })
}

export function revisePrompt(asset: PromptAsset, content: string): PromptAsset {
  if (
    asset.versions.find((revision) => revision.version === asset.currentVersion)?.content ===
    content
  )
    return asset
  const version = Math.max(...asset.versions.map((revision) => revision.version)) + 1
  return { ...asset, currentVersion: version, versions: [...asset.versions, { version, content }] }
}

export function reviseMarkdownSkill(asset: SkillAsset, content: string): SkillAsset {
  const current = asset.versions.find((revision) => revision.version === asset.currentVersion)
  if (current?.kind !== 'markdown') throw appError('error.assetDirectoryEdit')
  if (current.content === content) return asset
  const version = Math.max(...asset.versions.map((revision) => revision.version)) + 1
  return {
    ...asset,
    currentVersion: version,
    versions: [...asset.versions, { version, kind: 'markdown', content }],
  }
}

export function validateAssetHistory(current: EngineWorkspace, next: EngineWorkspace): void {
  for (const collection of ['prompts', 'skills'] as const) {
    for (const prior of current[collection]) {
      const updated = next[collection].find((asset) => asset.id === prior.id)
      if (!updated) continue
      const priorMax = Math.max(...prior.versions.map((revision) => revision.version))
      for (const revision of prior.versions) {
        if (
          JSON.stringify(updated.versions.find((item) => item.version === revision.version)) !==
          JSON.stringify(revision)
        )
          throw appError('error.assetHistory')
      }
      for (const revision of updated.versions) {
        if (
          revision.version <= priorMax &&
          !prior.versions.some((item) => item.version === revision.version)
        )
          throw appError('error.assetHistory')
      }
    }
  }
}

/** Replaces the setup every agent inherits. Individual model and engine choices are untouched. */
export function updateSharedSetup(
  input: EngineWorkspace,
  patch: Partial<SharedSetup>,
): EngineWorkspace {
  const workspace = engineWorkspaceSchema.parse(input)
  return engineWorkspaceSchema.parse({
    ...workspace,
    sharedSetup: { ...workspace.sharedSetup, ...patch },
  })
}

/** Opts one agent in or out of the shared setup without touching its own bindings. */
export function setSharedSetupParticipation(
  input: EngineWorkspace,
  agentId: string,
  participates: boolean,
): EngineWorkspace {
  const workspace = engineWorkspaceSchema.parse(input)
  const excluded = workspace.sharedSetup.excludedAgentIds.filter((value) => value !== agentId)
  return updateSharedSetup(workspace, {
    excludedAgentIds: participates ? excluded : [...excluded, agentId],
  })
}
