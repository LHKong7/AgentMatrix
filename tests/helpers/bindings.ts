import { bindConnectionToEngine } from '../../src/shared/engines/editing'
import { bindingFor } from '../../src/shared/engines/provider'
import type { EngineWorkspace } from '../../src/shared/engines/workspace'

/**
 * What creating an agent does in the interface: grant that agent's engine the connection its
 * model points at. Fixtures that predate engine grants use this instead of restating a binding.
 */
export function grantAgentConnections(
  workspace: EngineWorkspace,
  boundAt = '2026-09-18T00:00:00.000Z',
): EngineWorkspace {
  let result = workspace
  for (const agent of workspace.agents) {
    const model = result.models.find((item) => item.id === agent.modelProfileId)
    const connection = result.connections.find((item) => item.id === model?.connectionId)
    const installationId = agent.engineInstallationId
    if (!installationId || !connection) continue
    if (bindingFor(result, installationId, connection.id)) continue
    result = bindConnectionToEngine(result, {
      id: `bind-${result.engineBindings.length}`,
      installationId,
      connectionId: connection.id,
      boundAt,
    })
  }
  return result
}

/**
 * Repoints a fixture's only connection at another route, the way the interface does: a grant is
 * given for one route, so changing the route changes what was granted.
 */
export function useProtocol(
  workspace: EngineWorkspace,
  protocol: NonNullable<EngineWorkspace['connections'][number]['protocol']>,
): void {
  workspace.connections[0]!.protocol = protocol
  for (const binding of workspace.engineBindings)
    if (binding.connectionId === workspace.connections[0]!.id) binding.route = protocol
}
