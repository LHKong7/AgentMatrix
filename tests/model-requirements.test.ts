import { describe, expect, it } from 'vitest'
import {
  describeModelRequirements,
  defaultTargetEngine,
  engineModelRequirements,
  enginesForProtocol,
  protocolRequirement,
  type AuthKind,
} from '../src/shared/engines/model-requirements'
import { engineConfigurationIssues } from '../src/shared/engines/validation'
import { modelProtocolSchema, type ModelConnection, type ModelProtocol } from '../src/shared/engines/schema'
import type { ResolvedAgentConfiguration } from '../src/shared/engines/resolution'
import { engineContracts, type SupportedEngine } from '../src/shared/engines/contracts'
import { createEngineWorkspace } from '../src/shared/engines/workspace'

const engines = Object.keys(engineModelRequirements) as SupportedEngine[]
const authKinds: AuthKind[] = ['unconfigured', 'none', 'api-key', 'bearer', 'engine-login']

function connection(values: Partial<ModelConnection> = {}): ModelConnection {
  return {
    id: 'connection-1',
    name: 'Connection',
    protocol: 'openai-chat-completions',
    baseUrl: 'https://api.example.com/v1',
    auth: { kind: 'bearer', secret: { kind: 'environment', name: 'API_KEY' } },
    headers: {},
    secretHeaders: {},
    ...values,
  }
}
function configuration(
  kind: SupportedEngine,
  values: { connection?: ModelConnection; parameters?: ResolvedAgentConfiguration['model']['parameters'] } = {},
): ResolvedAgentConfiguration {
  return {
    agent: {
      id: 'agent-1',
      name: 'Agent',
      description: '',
      enabled: true,
      engineInstallationId: 'installation-1',
      modelProfileId: 'model-1',
      promptBindings: [],
      mcpServerIds: [],
      skillBindings: [],
      bundleIds: [],
      nativePluginIds: [],
      engineOptions:
        kind === 'opencode'
          ? { kind, agent: 'build' }
          : kind === 'pi'
            ? { kind }
            : { kind, profileTemplate: 'acp', patchReload: 'startup' },
      execution: { cwd: '/project', approval: kind === 'pi' ? 'deny' : 'ask' },
    },
    installation: {
      id: 'installation-1',
      name: 'Engine',
      kind,
      executable: '/usr/local/bin/engine',
      prefixArgs: [],
      platform: 'darwin',
      version: engineContracts[kind].engineVersion,
      modes: [engineContracts[kind].mode],
      probedAt: '2026-09-18T00:00:00.000Z',
    },
    model: {
      id: 'model-1',
      name: 'Model',
      connectionId: 'connection-1',
      modelId: 'model-id',
      parameters: values.parameters ?? {},
    },
    connection: values.connection ?? connection(),
    prompts: [],
    skills: [],
    mcpServers: [],
    nativePlugins: [],
  }
}
const hasIssue = (
  kind: SupportedEngine,
  code: string,
  values: Parameters<typeof configuration>[1] = {},
) =>
  engineConfigurationIssues(configuration(kind, values), { platform: 'darwin' }).some(
    (issue) => issue.code === code,
  )

describe('per-engine model requirements', () => {
  it('describes only the routes each pinned CLI maps', () => {
    expect(engineModelRequirements.opencode.protocols.map((entry) => entry.protocol)).toEqual([
      'openai-chat-completions',
      'openai-responses',
      'anthropic-messages',
      'gemini',
    ])
    expect(protocolRequirement('deepseek-harness', 'deepseek-official')).toMatchObject({
      sampling: false,
      headers: 'none',
      reasoning: ['off', 'low', 'high', 'max'],
    })
    expect(protocolRequirement('pi', 'deepseek-official')).toBeNull()
    expect(protocolRequirement('opencode', 'vertex')).toBeNull()
    expect(enginesForProtocol('anthropic-messages')).toEqual(engines)
    expect(enginesForProtocol('deepseek-official')).toEqual(['deepseek-harness'])
    expect(enginesForProtocol('vertex')).toEqual([])
  })

  it('matches the runtime validator on every engine and route', () => {
    for (const kind of engines)
      for (const protocol of modelProtocolSchema.options) {
        const route = protocolRequirement(kind, protocol)
        const blocked = hasIssue(kind, 'protocol', {
          connection: connection({ protocol, auth: { kind: 'bearer', secret: null } }),
        })
        expect(Boolean(route), `${kind}/${protocol}`).toBe(!blocked)
      }
  })

  it('matches the runtime validator on authentication, including the API-key header', () => {
    for (const kind of engines)
      for (const route of engineModelRequirements[kind].protocols)
        for (const auth of authKinds)
          for (const header of ['x-api-key', 'x-goog-api-key', 'authorization']) {
            const value: ModelConnection['auth'] =
              auth === 'api-key'
                ? { kind: auth, header, secret: { kind: 'environment', name: 'KEY' } }
                : auth === 'bearer'
                  ? { kind: auth, secret: { kind: 'environment', name: 'KEY' } }
                  : { kind: auth as 'none' | 'unconfigured' | 'engine-login' }
            const current = connection({ protocol: route.protocol, auth: value })
            const validatorAccepts = !hasIssue(kind, 'authentication', { connection: current })
            const tableAccepts =
              route.auth.includes(auth) &&
              (auth !== 'api-key' || !route.apiKeyHeader || header === route.apiKeyHeader)
            expect(tableAccepts, `${kind}/${route.protocol}/${auth}/${header}`).toBe(
              validatorAccepts,
            )
            if (auth !== 'api-key') break
          }
  })

  it('matches the runtime validator on sampling and reasoning', () => {
    for (const kind of engines)
      for (const route of engineModelRequirements[kind].protocols) {
        const current = connection({ protocol: route.protocol })
        expect(
          !hasIssue(kind, 'sampling', { connection: current, parameters: { temperature: 0.4 } }),
          `${kind}/${route.protocol}/sampling`,
        ).toBe(route.sampling)
        for (const value of ['off', 'low', 'medium', 'high', 'max', 'xhigh', 'minimal', 'sloppy']) {
          // Pi reports an out-of-range value through its own thinking-level rule.
          const issues = engineConfigurationIssues(
            configuration(kind, { connection: current, parameters: { reasoning: value } }),
            { platform: 'darwin' },
          )
          const accepted = !issues.some(
            (issue) => issue.code === 'reasoning' || issue.code === 'thinking-level',
          )
          expect(route.reasoning?.includes(value) ?? false, `${kind}/${route.protocol}/${value}`).toBe(
            accepted,
          )
        }
      }
  })

  it('matches the runtime validator on reserved and rejected headers', () => {
    for (const kind of engines)
      for (const route of engineModelRequirements[kind].protocols) {
        const reserved = connection({
          protocol: route.protocol,
          headers: { 'User-Agent': 'x' },
        })
        const custom = connection({ protocol: route.protocol, headers: { 'X-Trace': 'x' } })
        const reservedBlocked = engineConfigurationIssues(
          configuration(kind, { connection: reserved }),
          { platform: 'darwin' },
        ).some((issue) => issue.code === 'reserved-header' || issue.code === 'native-headers')
        const customBlocked = engineConfigurationIssues(
          configuration(kind, { connection: custom }),
          { platform: 'darwin' },
        ).some((issue) => issue.code === 'reserved-header' || issue.code === 'native-headers')
        expect(reservedBlocked, `${kind}/${route.protocol}/user-agent`).toBe(
          route.headers !== 'allowed',
        )
        expect(customBlocked, `${kind}/${route.protocol}/custom`).toBe(route.headers === 'none')
      }
  })
})

describe('field guidance', () => {
  const model = (parameters: ResolvedAgentConfiguration['model']['parameters'] = {}) => ({
    id: 'model-1',
    name: 'Model',
    connectionId: 'connection-1',
    modelId: 'gpt-4o-mini',
    parameters,
  })
  const statusOf = (
    kind: SupportedEngine,
    id: string,
    draft: Parameters<typeof describeModelRequirements>[1],
  ) => describeModelRequirements(kind, draft)?.find((check) => check.id === id)?.status

  it('reports an unmapped route with the routes the engine does support', () => {
    const checks = describeModelRequirements('pi', {
      connection: connection({ protocol: 'deepseek-official' }),
    })
    const protocol = checks.find((check) => check.id === 'protocol')!
    expect(protocol.status).toBe('blocked')
    expect(protocol.detail).toContain('openai-chat-completions')
    expect(statusOf('deepseek-harness', 'protocol', {
      connection: connection({ protocol: 'deepseek-official' }),
    })).toBe('ok')
  })

  it('separates an unset field from one the engine rejects', () => {
    expect(statusOf('opencode', 'reasoning', { model: model() })).toBe('not-applicable')
    expect(
      statusOf('opencode', 'reasoning', {
        connection: connection(),
        model: model({ reasoning: 'high' }),
      }),
    ).toBe('blocked')
    expect(
      statusOf('pi', 'reasoning', { connection: connection(), model: model({ reasoning: 'high' }) }),
    ).toBe('ok')
    expect(
      statusOf('deepseek-harness', 'sampling', {
        connection: connection(),
        model: model({ temperature: 0.2 }),
      }),
    ).toBe('blocked')
    expect(statusOf('opencode', 'model-id', { model: { ...model(), modelId: '' } })).toBe('unset')
    expect(statusOf('opencode', 'secret', {
      connection: connection({ auth: { kind: 'bearer', secret: null } }),
    })).toBe('unset')
  })

  it('checks the Anthropic base URL shape for the selected engine', () => {
    const base = (baseUrl: string) =>
      statusOf('opencode', 'endpoint', {
        connection: connection({ protocol: 'anthropic-messages', baseUrl, auth: { kind: 'api-key', header: 'x-api-key', secret: null } }),
      })
    expect(base('https://api.anthropic.com')).toBe('ok')
    expect(base('https://api.anthropic.com/v1')).toBe('ok')
    expect(base('https://api.anthropic.com/v1/messages')).toBe('blocked')
    expect(base('')).toBe('unset')
  })
})

describe('default engine for an editor', () => {
  function workspaceWith(kind: SupportedEngine) {
    const workspace = createEngineWorkspace()
    workspace.installations.push({
      id: 'installation-1',
      name: 'Engine',
      kind,
      executable: '/usr/local/bin/engine',
      prefixArgs: [],
      platform: 'darwin',
      version: null,
      modes: [],
      probedAt: null,
    })
    workspace.agents.push({
      id: 'agent-1',
      name: 'Agent',
      description: '',
      enabled: true,
      engineInstallationId: null,
      modelProfileId: null,
      promptBindings: [],
      mcpServerIds: [],
      skillBindings: [],
      bundleIds: [],
      nativePluginIds: [],
      engineOptions: null,
      execution: { cwd: '', approval: 'ask' },
    })
    workspace.connections.push(connection())
    workspace.models.push({
      id: 'model-1',
      name: 'Model',
      connectionId: 'connection-1',
      modelId: 'gpt-4o-mini',
      parameters: {},
    })
    return workspace
  }

  it('follows the engine an agent already binds', () => {
    const workspace = workspaceWith('pi')
    workspace.agents[0]!.engineInstallationId = 'installation-1'
    workspace.agents[0]!.modelProfileId = 'model-1'
    expect(defaultTargetEngine(workspace, { modelId: 'model-1' })).toBe('pi')
    expect(defaultTargetEngine(workspace, { connectionId: 'connection-1' })).toBe('pi')
  })

  it('falls back to the only installed engine and otherwise asks', () => {
    const workspace = workspaceWith('deepseek-harness')
    expect(defaultTargetEngine(workspace, { modelId: 'model-1' })).toBe('deepseek-harness')
    workspace.installations.push({
      ...workspace.installations[0]!,
      id: 'installation-2',
      kind: 'opencode',
    })
    expect(defaultTargetEngine(workspace, { modelId: 'model-1' })).toBeNull()
    expect(defaultTargetEngine(createEngineWorkspace(), {})).toBeNull()
  })
})

describe('protocol coverage', () => {
  it('keeps an example identifier for every protocol the schema allows', () => {
    const covered = new Set<ModelProtocol>()
    for (const kind of engines)
      for (const route of engineModelRequirements[kind].protocols) {
        expect(route.modelIdExample.length).toBeGreaterThan(0)
        covered.add(route.protocol)
      }
    expect([...covered].sort()).toEqual(
      modelProtocolSchema.options.filter((protocol) => protocol !== 'vertex').sort(),
    )
  })
})
