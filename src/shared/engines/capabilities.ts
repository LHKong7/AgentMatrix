import { capabilitySchema, type Capability } from './schema'
import type { ConfigurationField } from './configuration-report'
import type { ResolvedAgentConfiguration } from './resolution'
import { canonicalIntent } from './intent'
import { engineContracts, isSupportedEngine } from './contracts'
import { engineConfigurationIssues, type EngineIssue } from './validation'

export interface ConfigurationCapability extends Capability {
  feature: ConfigurationField
  requested: boolean
}
export interface ConfigurationCapabilities {
  profileId: string
  profileDigest: string
  assessedAt: string
  route: {
    connectionId: string
    protocol: ResolvedAgentConfiguration['connection']['protocol']
    modelId: string
  }
  issues: EngineIssue[]
  /** Static constraints only. Native startup, filesystem and credential checks have not run. */
  eligibleForStartupChecks: boolean
  capabilities: ConfigurationCapability[]
}

/** Describe the current draft, never promote contract knowledge into runtime verification. */
export async function describeConfigurationCapabilities(
  input: ResolvedAgentConfiguration,
  platform?: string,
): Promise<ConfigurationCapabilities> {
  // Capture before awaiting WebCrypto so callers cannot mutate identity during the digest operation.
  const configuration = structuredClone(input)
  const issues = engineConfigurationIssues(configuration, { platform })
  const assessedAt = new Date().toISOString()
  const identity = new TextEncoder().encode(
    canonicalIntent({ configuration, platform: platform ?? null }),
  )
  const profileDigest = Array.from(
    new Uint8Array(await crypto.subtle.digest('SHA-256', identity)),
    (byte) => byte.toString(16).padStart(2, '0'),
  ).join('')
  const { installation, connection, model, agent } = configuration
  const report: ConfigurationCapabilities = {
    profileId: agent.id,
    profileDigest,
    assessedAt,
    route: { connectionId: connection.id, protocol: connection.protocol, modelId: model.modelId },
    issues,
    eligibleForStartupChecks: issues.length === 0,
    capabilities: [],
  }
  if (!isSupportedEngine(installation.kind)) return report
  const kind = installation.kind,
    contract = engineContracts[kind]
  const requested: Record<ConfigurationField, boolean> = {
    installation: true,
    connection: true,
    authentication: true,
    model: true,
    sampling: model.parameters.temperature !== undefined || model.parameters.topP !== undefined,
    reasoning:
      (model.parameters.reasoning !== undefined && model.parameters.reasoning !== 'off') ||
      (agent.engineOptions?.kind === 'pi' &&
        Boolean(agent.engineOptions.thinkingLevel && agent.engineOptions.thinkingLevel !== 'off')),
    execution: true,
    'engine-options': agent.engineOptions !== null,
    prompts: configuration.prompts.length > 0,
    skills: configuration.skills.length > 0,
    mcp: configuration.mcpServers.length > 0,
    plugins: configuration.nativePlugins.length > 0,
  }
  for (const feature of Object.keys(requested) as ConfigurationField[]) {
    let mechanism: Capability['mechanism'] =
      feature === 'installation' || feature === 'model' ? 'native' : 'adapter'
    if (feature === 'mcp' && kind === 'pi') mechanism = 'extension-required'
    if (
      (feature === 'plugins' && kind !== 'opencode') ||
      (feature === 'sampling' &&
        (kind === 'deepseek-harness' ||
          (kind === 'pi' && !connection.protocol?.startsWith('openai-')))) ||
      (feature === 'reasoning' &&
        (kind === 'opencode' ||
          (kind === 'deepseek-harness' && connection.protocol !== 'deepseek-official'))) ||
      (feature === 'execution' && kind === 'pi' && agent.execution.approval === 'ask')
    )
      mechanism = 'unsupported'
    const issue = issues.find((item) => item.field === feature)
    const availability: Capability['availability'] =
      mechanism === 'extension-required'
        ? 'missing-dependency'
        : mechanism === 'unsupported' || issue
          ? 'blocked'
          : 'unknown'
    const reason = issue
      ? `support.issue.${issue.code}`
      : mechanism === 'extension-required'
        ? 'support.issue.mcp-extension'
        : mechanism === 'unsupported'
          ? 'support.reason.unsupported'
          : !requested[feature]
            ? 'support.reason.unused'
            : feature === 'authentication'
              ? 'support.reason.credentials'
              : feature === 'skills' || feature === 'prompts'
                ? 'support.reason.assets'
                : feature === 'mcp'
                  ? 'support.reason.mcp'
                  : 'support.reason.startup'
    report.capabilities.push({
      ...capabilitySchema.parse({
        feature,
        mechanism,
        availability,
        verification: 'untested',
        reason,
        installationId: installation.id,
        engineVersion: installation.version ?? 'unprobed',
        mode: contract.mode,
        profileDigest,
        evidence: [
          {
            kind: 'contract',
            source: `adapter:${contract.id}@${contract.version}`,
            checkedAt: assessedAt,
          },
        ],
      }),
      feature,
      requested: requested[feature],
    })
  }
  return report
}
