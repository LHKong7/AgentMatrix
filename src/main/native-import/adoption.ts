import { adapterVersionFor, type EngineProviderBinding } from '../../shared/engines/provider'
import type { NativeImportEngine } from '../../shared/engines/native-import'
import type { ModelConnection } from '../../shared/engines/schema'
import type { NativeImportPlan } from './plan'

/** Where each adopted connection came from in the CLI's own configuration. */
export interface NativeProviderSource {
  /** The provider key the CLI files it under, which is also the vendor it names. */
  nativeId: string
  /** The pointer into the native document, for the record. */
  path: string
}
export interface AdoptionContext {
  engine: NativeImportEngine
  installationId: string
  importId: string
  sources: ReadonlyMap<string, NativeProviderSource>
  at?: string
}

/** A root the adapter still appends a route to, or a base it sends requests to as it stands. */
function endpointScope(baseUrl: string): 'provider-root' | 'route-base' {
  if (!baseUrl) return 'provider-root'
  try {
    const { pathname } = new URL(baseUrl)
    return pathname === '' || pathname === '/' ? 'provider-root' : 'route-base'
  } catch {
    return 'provider-root'
  }
}

/**
 * Records what a CLI's own configuration says about the providers it reaches, and grants that
 * CLI — and only that CLI — the connections adopted from it.
 *
 * Reading a provider out of a CLI's configuration is evidence that this CLI already uses it, so
 * the grant is adopted with the connection rather than invented. Another CLI that happens to
 * speak the same protocol is not granted anything here.
 */
export function adoptNativeConnections(plan: NativeImportPlan, context: AdoptionContext): void {
  const boundAt = context.at ?? new Date().toISOString()
  let serial = 0
  for (const connection of plan.additions.connections) {
    const source = context.sources.get(connection.id)
    if (source?.nativeId.trim()) {
      const identity: NonNullable<ModelConnection['provider']> = {
        vendor: source.nativeId.trim().slice(0, 80),
        product: '',
        region: '',
        organization: '',
        endpointScope: endpointScope(connection.baseUrl),
      }
      connection.provider = identity
    }
    connection.origin = {
      kind: 'adopted',
      engine: context.engine,
      installationId: context.installationId,
      importId: context.importId,
      path: source?.path ?? '',
    }
    // A connection whose route the adapter could not identify is adopted unusable, not granted.
    if (!connection.protocol) continue
    const binding: EngineProviderBinding = {
      id: `import-${context.importId}-grant-${++serial}`.slice(0, 100),
      installationId: context.installationId,
      connectionId: connection.id,
      route: connection.protocol,
      nativeProviderId: source?.nativeId.slice(0, 200) ?? '',
      adapterVersion: adapterVersionFor(context.engine),
      boundAt,
    }
    plan.bindings.push(binding)
  }
}
