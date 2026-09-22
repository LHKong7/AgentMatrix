import { z } from 'zod'
import {
  engineInstallationSchema,
  modelConnectionSchema,
  modelProfileSchema,
  entityId,
} from './schema'
import {
  promptAssetSchema,
  skillAssetSchema,
  capabilityBundleSchema,
  mcpDefinitionSchema,
  nativePluginSchema,
  type EngineWorkspace,
} from './workspace'
import { upsertConfiguration, validateAssetHistory } from './editing'
import {
  resolveAgentProfiles,
  type ProfileResolution,
  type ResolutionIssueCode,
} from './resolution'
import { changedIntentFields, resolvedIntent } from './intent'
import type { ConfigurationField } from './configuration-report'
import type { SessionStatus } from '../sessions/schema'
import { appError } from '../errors'

export const libraryChangeSchema = z.discriminatedUnion('collection', [
  z.object({ collection: z.literal('installations'), entry: engineInstallationSchema }).strict(),
  z.object({ collection: z.literal('connections'), entry: modelConnectionSchema }).strict(),
  z.object({ collection: z.literal('models'), entry: modelProfileSchema }).strict(),
  z.object({ collection: z.literal('prompts'), entry: promptAssetSchema }).strict(),
  z.object({ collection: z.literal('skills'), entry: skillAssetSchema }).strict(),
  z.object({ collection: z.literal('bundles'), entry: capabilityBundleSchema }).strict(),
  z.object({ collection: z.literal('mcpServers'), entry: mcpDefinitionSchema }).strict(),
  z.object({ collection: z.literal('nativePlugins'), entry: nativePluginSchema }).strict(),
])
export const libraryImpactQuerySchema = z
  .object({
    revision: z.number().int().nonnegative(),
    change: libraryChangeSchema,
    afterSessionId: entityId.optional(),
  })
  .strict()
export type LibraryChange = z.infer<typeof libraryChangeSchema>
export type LibraryImpactQuery = z.infer<typeof libraryImpactQuerySchema>
export interface ProfileImpact {
  id: string
  name: string
  enabled: boolean
  effect: 'changed' | 'unchanged' | 'unresolved' | 'blocked' | 'resolved'
  fields: ConfigurationField[]
  issues: ResolutionIssueCode[]
}
export interface SessionImpact {
  id: string
  agentId: string
  status: SessionStatus
  createdAt: string
  effect: 'pending' | 'same' | 'unresolved' | 'unavailable'
  alreadyPending: boolean
  fields: ConfigurationField[]
  assets: {
    kind: 'prompt' | 'skill'
    id: string
    capturedVersion: number
    proposedVersion: number | null
  }[]
}
export interface LibraryImpact {
  revision: number
  profiles: ProfileImpact[]
  sessions: SessionImpact[]
  sessionScope: 'desktop' | 'browser'
  scannedSessions: number
  nextSessionId: string | null
}

/** Relationship discovery includes disabled and shadowed bindings; resolution determines actual effects. */
export function referencesLibraryEntry(
  workspace: EngineWorkspace,
  agentId: string,
  change: LibraryChange,
): boolean {
  const agent = workspace.agents.find((item) => item.id === agentId)
  if (!agent) return false
  const id = change.entry.id
  const bundles = workspace.bundles.filter((bundle) => agent.bundleIds.includes(bundle.id))
  switch (change.collection) {
    case 'installations':
      return agent.engineInstallationId === id
    case 'models':
      return agent.modelProfileId === id
    case 'connections':
      return (
        workspace.models.find((model) => model.id === agent.modelProfileId)?.connectionId === id
      )
    case 'bundles':
      return agent.bundleIds.includes(id)
    case 'nativePlugins':
      return agent.nativePluginIds.includes(id)
    case 'prompts':
      return [agent, ...bundles].some((item) =>
        item.promptBindings.some((binding) => binding.assetId === id),
      )
    case 'skills':
      return [agent, ...bundles].some((item) =>
        item.skillBindings.some((binding) => binding.assetId === id),
      )
    case 'mcpServers':
      return [agent, ...bundles].some((item) => item.mcpServerIds.includes(id))
  }
}

export function prepareLibraryImpact(workspace: EngineWorkspace, input: unknown) {
  const query = libraryImpactQuerySchema.parse(input)
  if (query.revision !== workspace.revision) throw appError('error.conflict')
  const proposed = upsertConfiguration(workspace, query.change.collection, query.change.entry)
  validateAssetHistory(workspace, proposed)
  const before = resolveAgentProfiles(workspace),
    after = resolveAgentProfiles(proposed)
  const profiles: ProfileImpact[] = []
  for (const agent of proposed.agents) {
    if (
      !referencesLibraryEntry(workspace, agent.id, query.change) &&
      !referencesLibraryEntry(proposed, agent.id, query.change)
    )
      continue
    const previous = before.get(agent.id)!,
      next = after.get(agent.id)!
    const fields =
      previous.status === 'resolved' && next.status === 'resolved'
        ? changedIntentFields(
            resolvedIntent(previous.configuration),
            resolvedIntent(next.configuration),
          )
        : []
    profiles.push({
      id: agent.id,
      name: agent.name,
      enabled: agent.enabled,
      fields,
      effect:
        previous.status === 'resolved'
          ? next.status === 'resolved'
            ? fields.length
              ? 'changed'
              : 'unchanged'
            : 'blocked'
          : next.status === 'resolved'
            ? 'resolved'
            : 'unresolved',
      issues: next.status === 'invalid' ? [...new Set(next.issues.map((issue) => issue.code))] : [],
    })
  }
  return { query, proposed, before, after, profiles }
}
export const missingProfile: ProfileResolution = {
  status: 'invalid',
  issues: [{ code: 'agent-missing', path: 'agentId' }],
}
