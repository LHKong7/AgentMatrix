import { engineContracts, isSupportedEngine, type SupportedEngine } from './contracts'
import { nativeProviderBaseUrl } from './provider-endpoint'
import type { ModelConnection, ModelProfile, ModelProtocol } from './schema'
import type { EngineWorkspace } from './workspace'

export type AuthKind = ModelConnection['auth']['kind']

export interface ProtocolRequirement {
  protocol: ModelProtocol
  /** Authentication strategies this adapter maps on this route, in the order editors offer them. */
  auth: AuthKind[]
  /** The header an API key must use, or null where the route accepts any header name. */
  apiKeyHeader: string | null
  /** Whether temperature and top-p reach the native request on this route. */
  sampling: boolean
  /** Allowed reasoning values, or null where this adapter does not map reasoning at all. */
  reasoning: string[] | null
  /** Custom connection headers on this route. */
  headers: 'allowed' | 'reserved-user-agent' | 'none'
  /** How the adapter interprets the saved base URL. */
  endpoint: 'plain' | 'anthropic-root-or-v1'
  /** A model identifier in the form this route expects, shown as a placeholder. */
  modelIdExample: string
}
export interface EngineModelRequirements {
  kind: SupportedEngine
  engineVersion: string
  protocols: ProtocolRequirement[]
}

const piThinking = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']
const examples: Record<ModelProtocol, string> = {
  'openai-chat-completions': 'gpt-4o-mini',
  'openai-responses': 'gpt-4o',
  'anthropic-messages': 'claude-sonnet-4-5',
  gemini: 'gemini-2.0-flash',
  vertex: 'gemini-2.0-flash',
  'deepseek-official': 'deepseek-chat',
}

function sharedRoute(
  protocol: ModelProtocol,
  overrides: Partial<ProtocolRequirement>,
): ProtocolRequirement {
  return {
    protocol,
    auth: protocol === 'anthropic-messages' || protocol === 'gemini' ? ['api-key'] : ['bearer'],
    apiKeyHeader:
      protocol === 'anthropic-messages'
        ? 'x-api-key'
        : protocol === 'gemini'
          ? 'x-goog-api-key'
          : null,
    sampling: true,
    reasoning: null,
    headers: 'allowed',
    endpoint: protocol === 'anthropic-messages' ? 'anthropic-root-or-v1' : 'plain',
    modelIdExample: examples[protocol],
    ...overrides,
  }
}

/**
 * What each pinned CLI accepts for a model route. The engine decides which protocols,
 * authentication strategies, sampling and reasoning settings can be filled in at all, so the
 * editors read this table instead of offering every shared field to every engine.
 */
export const engineModelRequirements: Record<SupportedEngine, EngineModelRequirements> = {
  opencode: {
    kind: 'opencode',
    engineVersion: engineContracts.opencode.engineVersion,
    protocols: [
      // Its OpenAI-compatible route also accepts an unauthenticated or custom-header endpoint.
      sharedRoute('openai-chat-completions', { auth: ['bearer', 'api-key', 'none'] }),
      sharedRoute('openai-responses', {}),
      sharedRoute('anthropic-messages', {}),
      sharedRoute('gemini', {}),
    ],
  },
  pi: {
    kind: 'pi',
    engineVersion: engineContracts.pi.engineVersion,
    protocols: [
      sharedRoute('openai-chat-completions', { reasoning: piThinking }),
      sharedRoute('openai-responses', { reasoning: piThinking }),
      sharedRoute('anthropic-messages', { sampling: false, reasoning: piThinking }),
      sharedRoute('gemini', { sampling: false, reasoning: piThinking }),
    ],
  },
  'deepseek-harness': {
    kind: 'deepseek-harness',
    engineVersion: engineContracts['deepseek-harness'].engineVersion,
    protocols: [
      sharedRoute('openai-chat-completions', {
        sampling: false,
        reasoning: ['off'],
        headers: 'reserved-user-agent',
      }),
      sharedRoute('openai-responses', {
        sampling: false,
        reasoning: ['off'],
        headers: 'reserved-user-agent',
      }),
      sharedRoute('anthropic-messages', {
        sampling: false,
        reasoning: ['off'],
        headers: 'reserved-user-agent',
      }),
      sharedRoute('gemini', {
        sampling: false,
        reasoning: ['off'],
        headers: 'reserved-user-agent',
      }),
      // The native DeepSeek component takes no custom headers and maps its own effort levels.
      sharedRoute('deepseek-official', {
        sampling: false,
        reasoning: ['off', 'low', 'high', 'max'],
        headers: 'none',
      }),
    ],
  },
}

export function protocolRequirement(
  kind: SupportedEngine,
  protocol: ModelProtocol | null,
): ProtocolRequirement | null {
  if (!protocol) return null
  return (
    engineModelRequirements[kind].protocols.find((entry) => entry.protocol === protocol) ?? null
  )
}

export function enginesForProtocol(protocol: ModelProtocol): SupportedEngine[] {
  return (Object.keys(engineModelRequirements) as SupportedEngine[]).filter((kind) =>
    protocolRequirement(kind, protocol),
  )
}

export type RequirementId =
  | 'protocol'
  | 'endpoint'
  | 'authentication'
  | 'secret'
  | 'model-id'
  | 'sampling'
  | 'reasoning'
  | 'headers'
export type RequirementStatus = 'ok' | 'unset' | 'blocked' | 'not-applicable'
export interface RequirementCheck {
  id: RequirementId
  status: RequirementStatus
  /** Values to interpolate into the message, such as the allowed reasoning list. */
  detail?: string
}

/**
 * Static field-level guidance for one engine and the connection/model a draft points at.
 * It reports what can still be filled in; it never proves a provider accepts the request.
 */
export function describeModelRequirements(
  kind: SupportedEngine,
  draft: { connection?: ModelConnection | null; model?: ModelProfile | null },
): RequirementCheck[] {
  const { connection, model } = draft
  const route = protocolRequirement(kind, connection?.protocol ?? null)
  const checks: RequirementCheck[] = []
  const supported = engineModelRequirements[kind].protocols.map((entry) => entry.protocol)
  if (!connection) checks.push({ id: 'protocol', status: 'unset' })
  else if (!connection.protocol) checks.push({ id: 'protocol', status: 'unset' })
  else if (!route) checks.push({ id: 'protocol', status: 'blocked', detail: supported.join(', ') })
  else checks.push({ id: 'protocol', status: 'ok', detail: route.protocol })

  if (connection && route) {
    if (!connection.baseUrl) checks.push({ id: 'endpoint', status: 'unset' })
    else if (route.endpoint === 'anthropic-root-or-v1') {
      try {
        nativeProviderBaseUrl('anthropic-messages', connection.baseUrl, kind)
        checks.push({ id: 'endpoint', status: 'ok' })
      } catch {
        checks.push({ id: 'endpoint', status: 'blocked' })
      }
    } else checks.push({ id: 'endpoint', status: 'ok' })

    const auth = connection.auth
    const allowed = route.auth.includes(auth.kind)
    const headerMatches =
      auth.kind !== 'api-key' ||
      !route.apiKeyHeader ||
      auth.header.toLowerCase() === route.apiKeyHeader
    if (auth.kind === 'unconfigured') checks.push({ id: 'authentication', status: 'unset' })
    else if (!allowed || !headerMatches)
      checks.push({
        id: 'authentication',
        status: 'blocked',
        detail: route.apiKeyHeader
          ? `${route.auth.join(', ')} · ${route.apiKeyHeader}`
          : route.auth.join(', '),
      })
    else checks.push({ id: 'authentication', status: 'ok', detail: auth.kind })

    if (auth.kind === 'api-key' || auth.kind === 'bearer')
      checks.push({ id: 'secret', status: auth.secret ? 'ok' : 'unset' })
    else checks.push({ id: 'secret', status: 'not-applicable' })

    const headerNames = [
      ...Object.keys(connection.headers),
      ...Object.keys(connection.secretHeaders),
    ]
    if (route.headers === 'none' && headerNames.length)
      checks.push({ id: 'headers', status: 'blocked' })
    else if (
      route.headers === 'reserved-user-agent' &&
      headerNames.some((name) => name.toLowerCase() === 'user-agent')
    )
      checks.push({ id: 'headers', status: 'blocked', detail: 'User-Agent' })
    else checks.push({ id: 'headers', status: headerNames.length ? 'ok' : 'not-applicable' })
  }

  if (model) {
    checks.push({ id: 'model-id', status: model.modelId ? 'ok' : 'unset' })
    const sampling =
      model.parameters.temperature !== undefined || model.parameters.topP !== undefined
    if (!sampling) checks.push({ id: 'sampling', status: 'not-applicable' })
    else checks.push({ id: 'sampling', status: route && route.sampling ? 'ok' : 'blocked' })
    const reasoning = model.parameters.reasoning
    if (reasoning === undefined) checks.push({ id: 'reasoning', status: 'not-applicable' })
    else if (!route) checks.push({ id: 'reasoning', status: 'blocked' })
    else if (route.reasoning === null) checks.push({ id: 'reasoning', status: 'blocked' })
    else
      checks.push({
        id: 'reasoning',
        status: route.reasoning.includes(reasoning) ? 'ok' : 'blocked',
        detail: route.reasoning.join(', '),
      })
  }
  return checks
}

export function blockedRequirements(checks: RequirementCheck[]): RequirementCheck[] {
  return checks.filter((check) => check.status === 'blocked')
}

/**
 * The engine an editor should describe first: the one already bound through an agent, then the
 * only installed supported engine, and otherwise nothing until the user chooses.
 */
export function defaultTargetEngine(
  workspace: EngineWorkspace,
  target: { modelId?: string; connectionId?: string },
): SupportedEngine | null {
  const engineOf = (installationId: string | null) => {
    const kind = workspace.installations.find((item) => item.id === installationId)?.kind
    return kind && isSupportedEngine(kind) ? kind : null
  }
  const modelIds = new Set<string>()
  if (target.modelId) modelIds.add(target.modelId)
  if (target.connectionId)
    for (const model of workspace.models)
      if (model.connectionId === target.connectionId) modelIds.add(model.id)
  for (const agent of workspace.agents)
    if (agent.modelProfileId && modelIds.has(agent.modelProfileId)) {
      const kind = engineOf(agent.engineInstallationId)
      if (kind) return kind
    }
  const installed = [
    ...new Set(
      workspace.installations
        .map((item) => item.kind)
        .filter((kind): kind is SupportedEngine => isSupportedEngine(kind)),
    ),
  ]
  return installed.length === 1 ? installed[0]! : null
}
