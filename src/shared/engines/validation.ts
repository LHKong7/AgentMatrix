import { appError } from '../errors'
import type { ConfigurationField } from './configuration-report'
import type { ResolvedAgentConfiguration } from './resolution'
import { engineContracts, isSupportedEngine, piApis, type SupportedEngine } from './contracts'
import { nativeProviderBaseUrl } from './provider-endpoint'

export type EngineIssueCode =
  | 'unsupported-engine'
  | 'installation-version'
  | 'platform'
  | 'prefix-arguments'
  | 'native-options'
  | 'native-plugins'
  | 'native-plugin-options'
  | 'plugins-pure-mode'
  | 'pi-plugin-policy'
  | 'protocol'
  | 'endpoint'
  | 'authentication'
  | 'secret-reference'
  | 'sampling'
  | 'reasoning'
  | 'reasoning-conflict'
  | 'thinking-level'
  | 'reserved-header'
  | 'native-headers'
  | 'empty-prompt'
  | 'replacement-conflict'
  | 'mcp-extension'
  | 'mcp-transport'
  | 'mcp-authentication'
  | 'universal-approval'
  | 'command-value'
export interface EngineIssue {
  code: EngineIssueCode
  field: ConfigurationField
  /** Stable native feature identifier for existing adapter error contracts; never a configuration value. */
  nativeFeature: string
  resourceId?: string
}

export function selectedPiThinking(
  configuration: Pick<ResolvedAgentConfiguration, 'agent' | 'model'>,
): { value: string; issue: EngineIssue | null } {
  const options = configuration.agent.engineOptions
  const requested = options?.kind === 'pi' ? options.thinkingLevel : undefined
  const shared = configuration.model.parameters.reasoning
  const value = requested || shared || 'off'
  const code =
    requested && shared && requested !== shared
      ? 'reasoning-conflict'
      : !['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'].includes(value)
        ? 'thinking-level'
        : null
  return {
    value,
    issue: code
      ? {
          code,
          field: 'reasoning',
          nativeFeature:
            code === 'reasoning-conflict' ? 'model.reasoning-conflict' : 'model.thinkingLevel',
        }
      : null,
  }
}

/** Static adapter constraints only. No filesystem, credentials, subprocesses or network access. */
export function engineConfigurationIssues(
  configuration: ResolvedAgentConfiguration,
  options: { expectedEngine?: SupportedEngine; platform?: string } = {},
): EngineIssue[] {
  const { installation, agent, connection, model } = configuration
  const kind = installation.kind
  const issues: EngineIssue[] = []
  const add = (
    code: EngineIssueCode,
    field: ConfigurationField,
    nativeFeature: string,
    resourceId?: string,
  ) => {
    issues.push({ code, field, nativeFeature, ...(resourceId ? { resourceId } : {}) })
  }
  if (!isSupportedEngine(kind)) {
    add('unsupported-engine', 'installation', 'installation.version')
    return issues
  }
  const contract = engineContracts[kind]
  if (
    (options.expectedEngine && options.expectedEngine !== kind) ||
    installation.version !== contract.engineVersion ||
    !installation.modes.includes(contract.mode)
  )
    add('installation-version', 'installation', 'installation.version')
  if (
    options.platform &&
    options.platform !== 'browser' &&
    (installation.platform !== options.platform || !['darwin', 'linux'].includes(options.platform))
  )
    add('platform', 'installation', 'installation.platform')
  if (
    (kind === 'deepseek-harness' && installation.prefixArgs.length > 0) ||
    (kind === 'pi' &&
      installation.prefixArgs.some(
        (arg) => arg === '-e' || arg === '--extension' || arg.startsWith('--extension='),
      )) ||
    installation.prefixArgs.some((arg) => arg.includes('\0'))
  )
    add('prefix-arguments', 'installation', 'installation.prefixArgs')
  if (
    agent.engineOptions &&
    (agent.engineOptions.kind !== kind ||
      (agent.engineOptions.kind === 'deepseek-harness' &&
        agent.engineOptions.profileTemplate !== 'acp'))
  )
    add(
      'native-options',
      'engine-options',
      kind === 'deepseek-harness' ? 'profileTemplate' : 'engineOptions',
    )
  if (
    agent.engineOptions?.kind === 'opencode' &&
    !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,99}$/.test(agent.engineOptions.agent)
  )
    add('native-options', 'engine-options', 'engineOptions.agent')
  if (configuration.nativePlugins.length) {
    if (
      configuration.nativePlugins.some((plugin) => plugin.options && plugin.options.kind !== kind)
    )
      add('native-plugin-options', 'plugins', 'nativePlugins.options')
    if (kind === 'pi' && agent.execution.approval !== 'unrestricted')
      add('pi-plugin-policy', 'plugins', 'nativePlugins.tools-policy')
    else if (
      kind === 'opencode' &&
      installation.prefixArgs.some((arg) => /^--pure(?:=|$)/.test(arg))
    )
      add('plugins-pure-mode', 'plugins', 'nativePlugins.pure-mode')
  }
  if (kind === 'pi' && agent.execution.approval === 'ask')
    add('universal-approval', 'execution', 'execution.universal-approval')
  const protocol = connection.protocol
  if (protocol === 'anthropic-messages' && connection.baseUrl) {
    try {
      nativeProviderBaseUrl(protocol, connection.baseUrl, kind)
    } catch {
      add('endpoint', 'connection', 'connection.endpoint')
    }
  }
  const nativeDsh = kind === 'deepseek-harness' && protocol === 'deepseek-official'
  if (
    !protocol ||
    (!Object.hasOwn(piApis, protocol) && !nativeDsh) ||
    !connection.baseUrl ||
    !model.modelId
  )
    add('protocol', 'connection', 'connection.protocol')
  const auth = connection.auth
  const standardKey =
    auth.kind === 'api-key' &&
    ((protocol === 'anthropic-messages' && auth.header.toLowerCase() === 'x-api-key') ||
      (protocol === 'gemini' && auth.header.toLowerCase() === 'x-goog-api-key'))
  const validAuth =
    kind === 'opencode' && protocol === 'openai-chat-completions'
      ? ['bearer', 'api-key', 'none'].includes(auth.kind)
      : (auth.kind === 'bearer' &&
          (protocol === 'openai-chat-completions' ||
            protocol === 'openai-responses' ||
            nativeDsh)) ||
        standardKey
  if (!validAuth) add('authentication', 'authentication', 'connection.auth')
  if ((auth.kind === 'bearer' || auth.kind === 'api-key') && !auth.secret)
    add('secret-reference', 'authentication', 'secret.reference')
  const sampling = model.parameters.temperature !== undefined || model.parameters.topP !== undefined
  if (
    sampling &&
    (kind === 'deepseek-harness' ||
      (kind === 'pi' && protocol !== 'openai-chat-completions' && protocol !== 'openai-responses'))
  )
    add('sampling', 'sampling', kind === 'pi' ? 'model.sampling-for-api' : 'model.sampling')
  if (kind === 'opencode' && model.parameters.reasoning !== undefined)
    add('reasoning', 'reasoning', 'model.parameters.reasoning')
  if (kind === 'pi') {
    const thinking = selectedPiThinking(configuration)
    if (thinking.issue) issues.push(thinking.issue)
  }
  if (kind === 'deepseek-harness') {
    if (
      !['off', ...(nativeDsh ? ['low', 'high', 'max'] : [])].includes(
        model.parameters.reasoning ?? 'off',
      )
    )
      add('reasoning', 'reasoning', 'model.reasoning')
    const headerNames = [
      ...Object.keys(connection.headers),
      ...Object.keys(connection.secretHeaders),
    ]
    if (headerNames.some((name) => name.toLowerCase() === 'user-agent'))
      add('reserved-header', 'connection', 'connection.reserved-header')
    if (nativeDsh && headerNames.length)
      add('native-headers', 'connection', 'connection.native-headers')
  }
  if (configuration.prompts.filter((prompt) => prompt.mode === 'replace').length > 1)
    add('replacement-conflict', 'prompts', 'prompts.replace')
  for (const prompt of configuration.prompts) {
    if (!prompt.content.trim() && (kind !== 'opencode' || prompt.mode === 'replace'))
      add(
        'empty-prompt',
        'prompts',
        kind === 'opencode' ? 'prompts.replace' : 'prompts.empty',
        prompt.assetId,
      )
  }
  if (kind === 'pi' && configuration.mcpServers.length)
    add('mcp-extension', 'mcp', 'mcp.extension-required')
  else
    for (const server of configuration.mcpServers) {
      if (server.transport === 'legacy-sse')
        add(
          'mcp-transport',
          'mcp',
          kind === 'opencode' ? 'mcp.forced-sse' : 'mcp.transport-or-auth',
          server.id,
        )
      if (server.transport === 'stdio') {
        if (
          [server.command, ...server.args, ...Object.values(server.environment)].some((value) =>
            value.includes('\0'),
          )
        )
          add('command-value', 'mcp', 'mcp.command', server.id)
      } else {
        if (kind === 'deepseek-harness' && server.auth.kind === 'oauth')
          add('mcp-authentication', 'mcp', 'mcp.transport-or-auth', server.id)
        if (server.auth.kind === 'bearer' && !server.auth.secret)
          add('secret-reference', 'mcp', 'secret.reference', server.id)
      }
    }
  return issues
}

/** Main-process adapters repeat this check; renderer diagnostics never authorize a launch. */
export function assertEngineConfiguration(
  configuration: ResolvedAgentConfiguration,
  options: { expectedEngine?: SupportedEngine; platform?: string } = {},
): void {
  const first = engineConfigurationIssues(configuration, options)[0]
  if (!first) return
  const kind = options.expectedEngine ?? configuration.installation.kind
  const key =
    kind === 'opencode'
      ? 'error.openCodeConfiguration'
      : kind === 'pi'
        ? 'error.piConfiguration'
        : kind === 'deepseek-harness'
          ? 'error.dshConfiguration'
          : 'error.runtimeUnsupported'
  throw appError(key, { feature: first.nativeFeature })
}
