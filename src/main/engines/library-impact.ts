import { appError } from '../../shared/errors'
import {
  missingProfile,
  prepareLibraryImpact,
  type LibraryChange,
  type LibraryImpact,
  type LibraryImpactQuery,
} from '../../shared/engines/impact'
import type { EngineWorkspace } from '../../shared/engines/workspace'
import type { RunInputManifest } from '../../shared/engines/run-inputs'
import type { SessionSnapshot } from '../../shared/sessions/schema'
import { buildConfigurationReport } from './configuration-report'

function capturedReference(manifest: RunInputManifest, change: LibraryChange): boolean {
  const id = change.entry.id
  switch (change.collection) {
    case 'installations':
      return manifest.installation.id === id
    case 'connections':
      return manifest.connection.id === id
    case 'models':
      return manifest.model.id === id
    case 'bundles':
      return manifest.agent.bundleIds.includes(id)
    case 'prompts':
      return manifest.prompts.some((item) => item.assetId === id)
    case 'skills':
      return manifest.skills.some((item) => item.assetId === id)
    case 'mcpServers':
      return manifest.mcpServers.some((item) => item.id === id)
    case 'nativePlugins':
      return manifest.nativePlugins.some((item) => item.id === id)
  }
}

/** Read-only dependencies deliberately exclude credentials, process launch and all write methods. */
export async function previewLibraryImpact(
  query: LibraryImpactQuery,
  snapshots: SessionSnapshot[],
  workspace: { load(): Promise<EngineWorkspace> },
  runs: { read(id: string): Promise<RunInputManifest> },
): Promise<LibraryImpact> {
  const current = await workspace.load()
  const prepared = prepareLibraryImpact(current, query)
  const related = new Set(prepared.profiles.map((profile) => profile.id))
  const remaining = snapshots
    .filter(
      (snapshot) =>
        snapshot.status !== 'closed' &&
        (!query.afterSessionId || snapshot.id > query.afterSessionId),
    )
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
  // Snapshot integrity includes asset-file reads. Bound each page, including unrelated captures.
  const page = remaining.slice(0, 20)
  const sessions: LibraryImpact['sessions'] = []
  for (const snapshot of page) {
    const identity = {
      id: snapshot.id,
      agentId: snapshot.agentId,
      status: snapshot.status,
      createdAt: snapshot.createdAt,
    }
    try {
      const manifest = await runs.read(snapshot.snapshotId)
      const before = buildConfigurationReport(
        manifest,
        snapshot,
        current,
        prepared.before.get(snapshot.agentId) ?? missingProfile,
      )
      if (!related.has(snapshot.agentId) && !capturedReference(manifest, prepared.query.change))
        continue
      const after = buildConfigurationReport(
        manifest,
        snapshot,
        prepared.proposed,
        prepared.after.get(snapshot.agentId) ?? missingProfile,
      )
      sessions.push({
        ...identity,
        effect:
          after.savedState === 'same' || after.savedState === 'pending'
            ? after.savedState
            : 'unresolved',
        alreadyPending: before.savedState === 'pending',
        fields: after.fields.filter((field) => field.changed === true).map((field) => field.id),
        assets: after.assets.map((asset) => ({
          kind: asset.kind,
          id: asset.id,
          capturedVersion: asset.version,
          proposedVersion: asset.nextVersion,
        })),
      })
    } catch {
      // An unreadable capture cannot be proven unrelated. Keep uncertainty visible, without raw errors.
      sessions.push({
        ...identity,
        effect: 'unavailable',
        alreadyPending: false,
        fields: [],
        assets: [],
      })
    }
  }
  if ((await workspace.load()).revision !== current.revision) throw appError('error.conflict')
  return {
    revision: current.revision,
    profiles: prepared.profiles,
    sessions,
    sessionScope: 'desktop',
    scannedSessions: page.length,
    nextSessionId: remaining.length > page.length ? page.at(-1)!.id : null,
  }
}
