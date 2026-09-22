import { engineContracts, isSupportedEngine, type SupportedEngine } from './contracts'
import { engineModelRequirements } from './model-requirements'
import { routesFor } from './provider'
import type { AgentProfile, EngineInstallation, ModelProtocol } from './schema'

type EngineOptions = NonNullable<AgentProfile['engineOptions']>
type Approval = AgentProfile['execution']['approval']

/** One field of the engine-specific part of an agent, in the order a form should ask for it. */
export interface AgentOptionField {
  key: string
  requirement: 'required' | 'optional'
  /** The values this CLI accepts, or null where it takes free text. */
  values: string[] | null
  /** What to offer first; null leaves the field empty. */
  fallback: string | null
}

/**
 * What an agent means on one CLI.
 *
 * The instructions, Skills and tools are shared across every CLI, but the rest of an agent is not
 * a common form with engine-specific extras bolted on: each CLI has its own idea of which
 * execution policies exist, which options must be chosen, and whether it can reach tool servers
 * at all. Editors read this instead of offering every field to every engine and reporting the
 * mismatch afterwards.
 */
export interface AgentConfigurationDefinition {
  kind: SupportedEngine
  engineVersion: string
  options: AgentOptionField[]
  /** Execution policies this CLI maps. A policy outside this list is not silently downgraded. */
  approvals: Approval[]
  /** Whether tool servers reach this CLI directly or need its extension. */
  tools: 'native' | 'extension-required'
  routes: ModelProtocol[]
  /** Reasoning values, unioned over the CLI's routes; empty where it maps none. */
  reasoning: string[]
}

function reasoningFor(kind: SupportedEngine): string[] {
  const values = engineModelRequirements[kind].protocols.flatMap(
    (protocol) => protocol.reasoning ?? [],
  )
  return [...new Set(values)]
}

export const agentConfigurationDefinitions: Record<SupportedEngine, AgentConfigurationDefinition> =
  {
    opencode: {
      kind: 'opencode',
      engineVersion: engineContracts.opencode.engineVersion,
      // OpenCode runs one of its own named agents; `build` is the one it ships with.
      options: [{ key: 'agent', requirement: 'required', values: null, fallback: 'build' }],
      approvals: ['ask', 'deny', 'unrestricted'],
      tools: 'native',
      routes: routesFor('opencode'),
      reasoning: reasoningFor('opencode'),
    },
    pi: {
      kind: 'pi',
      engineVersion: engineContracts.pi.engineVersion,
      options: [
        {
          key: 'thinkingLevel',
          requirement: 'optional',
          values: engineModelRequirements.pi.protocols[0]!.reasoning,
          fallback: null,
        },
        {
          key: 'projectTrust',
          requirement: 'optional',
          values: ['deny', 'trust-once'],
          fallback: null,
        },
        {
          key: 'contextFiles',
          requirement: 'optional',
          values: ['inherit', 'ignore'],
          fallback: null,
        },
      ],
      // Pi has no per-request approval prompt, so `ask` has nothing to map onto.
      approvals: ['deny', 'unrestricted'],
      tools: 'extension-required',
      routes: routesFor('pi'),
      reasoning: reasoningFor('pi'),
    },
    'deepseek-harness': {
      kind: 'deepseek-harness',
      engineVersion: engineContracts['deepseek-harness'].engineVersion,
      options: [
        {
          key: 'profileTemplate',
          requirement: 'required',
          values: ['acp', 'sdk', 'sdk-minimal'],
          fallback: 'acp',
        },
        { key: 'patchReload', requirement: 'required', values: ['startup'], fallback: 'startup' },
        {
          key: 'appendPosition',
          requirement: 'optional',
          values: ['prefix', 'suffix'],
          fallback: null,
        },
      ],
      approvals: ['ask', 'deny', 'unrestricted'],
      tools: 'native',
      routes: routesFor('deepseek-harness'),
      reasoning: reasoningFor('deepseek-harness'),
    },
  }

export function agentDefinitionFor(
  installation: Pick<EngineInstallation, 'kind'> | null,
): AgentConfigurationDefinition | null {
  if (!installation || !isSupportedEngine(installation.kind)) return null
  return agentConfigurationDefinitions[installation.kind]
}

/** The engine-specific options a new agent starts with on this CLI. */
export function defaultEngineOptions(kind: SupportedEngine): EngineOptions {
  switch (kind) {
    case 'opencode':
      return { kind, agent: 'build' }
    case 'pi':
      return { kind }
    case 'deepseek-harness':
      return { kind, profileTemplate: 'acp', patchReload: 'startup' }
  }
}

/** The execution policy to offer first: the one asked for where the CLI maps it. */
export function defaultApproval(kind: SupportedEngine, preferred: Approval = 'ask'): Approval {
  const { approvals } = agentConfigurationDefinitions[kind]
  return approvals.includes(preferred) ? preferred : approvals[0]!
}
