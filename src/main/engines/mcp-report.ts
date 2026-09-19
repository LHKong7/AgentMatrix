import type { ConfigurationObservation } from '../../shared/engines/configuration-report'
import type { RunInputManifest } from '../../shared/engines/run-inputs'
import { mcpObservationSchema, type McpReport } from '../../shared/engines/mcp-observation'
import { RuntimeFailure } from './runtime'

/** Receipts are meaningful only for the captured server list and native configuration check. */
export function mcpObservation(
  manifest: RunInputManifest,
  observation: ConfigurationObservation | null | undefined,
) {
  const recorded = observation?.mcpConnections
  if (!recorded) return null
  const parsed = mcpObservationSchema.safeParse(recorded)
  if (
    !parsed.success ||
    manifest.installation.kind !== 'opencode' ||
    !observation.checks.includes('opencode.instance-config') ||
    parsed.data.statuses.length !== manifest.mcpServers.length ||
    Date.parse(parsed.data.checkedAt) > Date.parse(observation.checkedAt)
  )
    throw new RuntimeFailure('configuration', 'report.mcp-identity')
  return parsed.data
}

export function buildMcpReport(
  manifest: RunInputManifest,
  observation: ConfigurationObservation | null,
): McpReport {
  const recorded = mcpObservation(manifest, observation)
  return {
    source: recorded?.source ?? 'unknown',
    checkedAt: recorded?.checkedAt ?? null,
    entries: manifest.mcpServers.map((server, slot) => ({
      slot,
      name: server.name,
      transport: server.transport,
      status: recorded?.statuses[slot] ?? 'unknown',
    })),
  }
}
