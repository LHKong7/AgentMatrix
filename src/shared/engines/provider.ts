import { z } from 'zod'
import { engineContracts, isSupportedEngine, type SupportedEngine } from './contracts'
import { engineModelRequirements } from './model-requirements'
import {
  entityId,
  modelProtocolSchema,
  type EngineInstallation,
  type ModelConnection,
  type ModelProtocol,
} from './schema'

/**
 * A connection reaches one CLI only through an explicit binding.
 *
 * Connections are managed once, for the whole workspace, but a shared connection is not a shared
 * credential: protocol compatibility alone never authorizes AgentMatrix to hand a provider key to
 * another CLI. The binding is that authorization, and it records which route and adapter it was
 * granted for, so a later adapter change is visible rather than silent.
 */
export const engineProviderBindingSchema = z
  .object({
    id: entityId,
    installationId: entityId,
    connectionId: entityId,
    /** The protocol this engine speaks to that provider; the connection may support others. */
    route: modelProtocolSchema,
    /** The provider key inside the engine's own configuration; empty when AgentMatrix declares it. */
    nativeProviderId: z.string().max(200),
    /** The adapter the binding was granted for. A different adapter invalidates its evidence. */
    adapterVersion: z.string().min(1).max(100),
    boundAt: z.iso.datetime(),
  })
  .strict()
export type EngineProviderBinding = z.infer<typeof engineProviderBindingSchema>

interface BindingWorkspace {
  installations: EngineInstallation[]
  connections: ModelConnection[]
  engineBindings: EngineProviderBinding[]
}

/** The adapter identity a binding is granted for: contract, contract revision and engine version. */
export function adapterVersionFor(kind: string): string {
  if (!isSupportedEngine(kind)) return `unsupported:${kind}`.slice(0, 100)
  const contract = engineContracts[kind]
  return `${contract.id}@${contract.version}+${contract.engineVersion}`
}

/** The routes an engine can use to reach a provider at all. */
export function routesFor(kind: SupportedEngine): ModelProtocol[] {
  return engineModelRequirements[kind].protocols.map((protocol) => protocol.protocol)
}

export function bindingFor(
  workspace: BindingWorkspace,
  installationId: string | null,
  connectionId: string | null,
): EngineProviderBinding | null {
  if (!installationId || !connectionId) return null
  return (
    workspace.engineBindings.find(
      (binding) =>
        binding.installationId === installationId && binding.connectionId === connectionId,
    ) ?? null
  )
}

/**
 * §12 Credential Scope. Answers the only question that may gate a credential: has this
 * installation been bound to this connection? Reachability, protocol support and a passing
 * requirements checklist deliberately do not.
 */
export function credentialReachesEngine(
  workspace: BindingWorkspace,
  installationId: string | null,
  connectionId: string | null,
): boolean {
  return bindingFor(workspace, installationId, connectionId) !== null
}

/** The connections one installation may be handed, in workspace order. */
export function connectionsBoundTo(
  workspace: BindingWorkspace,
  installationId: string,
): ModelConnection[] {
  const bound = new Set(
    workspace.engineBindings
      .filter((binding) => binding.installationId === installationId)
      .map((binding) => binding.connectionId),
  )
  return workspace.connections.filter((connection) => bound.has(connection.id))
}

/** The installations one connection has been granted to, in workspace order. */
export function installationsBoundTo(
  workspace: BindingWorkspace,
  connectionId: string,
): EngineInstallation[] {
  const bound = new Set(
    workspace.engineBindings
      .filter((binding) => binding.connectionId === connectionId)
      .map((binding) => binding.installationId),
  )
  return workspace.installations.filter((installation) => bound.has(installation.id))
}

export type BindingIssueCode =
  | 'installation-missing'
  | 'connection-missing'
  | 'engine-unsupported'
  | 'route-unsupported'
  | 'route-mismatch'
  | 'duplicate'
/** Why a binding cannot be granted as asked. An empty list means it can. */
export function bindingIssues(
  workspace: BindingWorkspace,
  draft: Pick<EngineProviderBinding, 'id' | 'installationId' | 'connectionId' | 'route'>,
): BindingIssueCode[] {
  const issues: BindingIssueCode[] = []
  const installation = workspace.installations.find((item) => item.id === draft.installationId)
  const connection = workspace.connections.find((item) => item.id === draft.connectionId)
  if (!installation) issues.push('installation-missing')
  if (!connection) issues.push('connection-missing')
  if (installation) {
    if (!isSupportedEngine(installation.kind)) issues.push('engine-unsupported')
    else if (!routesFor(installation.kind).includes(draft.route)) issues.push('route-unsupported')
  }
  // The connection states which protocol its endpoint and credential are for. Binding another
  // route to it would be a silent conversion, so the connection has to be edited instead.
  if (connection?.protocol && connection.protocol !== draft.route) issues.push('route-mismatch')
  const existing = bindingFor(workspace, draft.installationId, draft.connectionId)
  if (existing && existing.id !== draft.id) issues.push('duplicate')
  return issues
}

/** The route to offer first when binding: what the connection already states, else the engine's. */
export function defaultRoute(
  connection: ModelConnection | null,
  kind: SupportedEngine,
): ModelProtocol {
  const routes = routesFor(kind)
  if (connection?.protocol && routes.includes(connection.protocol)) return connection.protocol
  return routes[0]!
}

export function createBinding(
  id: string,
  installation: EngineInstallation,
  connection: ModelConnection,
  options: { route?: ModelProtocol; nativeProviderId?: string; boundAt?: string } = {},
): EngineProviderBinding {
  const kind = isSupportedEngine(installation.kind) ? installation.kind : null
  return {
    id,
    installationId: installation.id,
    connectionId: connection.id,
    route:
      options.route ??
      (kind ? defaultRoute(connection, kind) : (connection.protocol ?? 'openai-chat-completions')),
    nativeProviderId: options.nativeProviderId ?? '',
    adapterVersion: adapterVersionFor(installation.kind),
    boundAt: options.boundAt ?? new Date().toISOString(),
  }
}
