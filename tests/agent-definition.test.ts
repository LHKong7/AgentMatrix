import { describe, expect, it } from 'vitest'
import {
  agentConfigurationDefinitions,
  agentDefinitionFor,
  defaultApproval,
  defaultEngineOptions,
} from '../src/shared/engines/agent-definition'
import { engineContracts, type SupportedEngine } from '../src/shared/engines/contracts'
import type { ResolvedAgentConfiguration } from '../src/shared/engines/resolution'
import { engineConfigurationIssues } from '../src/shared/engines/validation'
import type { AgentProfile } from '../src/shared/engines/schema'
import type { McpDefinition } from '../src/shared/engines/workspace'

const engines = Object.keys(agentConfigurationDefinitions) as SupportedEngine[]
const approvals: AgentProfile['execution']['approval'][] = ['ask', 'deny', 'unrestricted']
const toolServer: McpDefinition = {
  id: 'files',
  name: 'Files',
  description: '',
  enabled: true,
  transport: 'stdio',
  command: 'files-mcp',
  args: [],
  cwd: '',
  environment: {},
  envRefs: {},
}

function configuration(
  kind: SupportedEngine,
  values: {
    approval?: AgentProfile['execution']['approval']
    mcpServers?: McpDefinition[]
  } = {},
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
      engineOptions: defaultEngineOptions(kind),
      execution: { cwd: '/project', approval: values.approval ?? 'deny' },
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
      parameters: {},
    },
    connection: {
      id: 'connection-1',
      name: 'Connection',
      protocol: 'openai-chat-completions',
      baseUrl: 'https://api.example.com/v1',
      auth: { kind: 'bearer', secret: { kind: 'environment', name: 'API_KEY' } },
      headers: {},
      secretHeaders: {},
    },
    prompts: [],
    skills: [],
    mcpServers: values.mcpServers ?? [],
    nativePlugins: [],
  }
}
const codes = (kind: SupportedEngine, values: Parameters<typeof configuration>[1] = {}) =>
  engineConfigurationIssues(configuration(kind, values), { platform: 'darwin' }).map(
    (issue) => issue.code,
  )

describe('what an agent means on each CLI', () => {
  it('starts every CLI with options its own validator accepts', () => {
    for (const kind of engines) {
      expect(defaultEngineOptions(kind).kind).toBe(kind)
      expect(codes(kind)).not.toContain('native-options')
    }
    expect(agentDefinitionFor({ kind: 'opencode' })).toBe(agentConfigurationDefinitions.opencode)
    expect(agentDefinitionFor({ kind: 'claude-code' })).toBeNull()
    expect(agentDefinitionFor(null)).toBeNull()
  })

  it('offers exactly the execution policies the CLI maps', () => {
    for (const kind of engines) {
      const definition = agentConfigurationDefinitions[kind]
      for (const approval of approvals) {
        const mapped = !codes(kind, { approval }).includes('universal-approval')
        expect([kind, approval, definition.approvals.includes(approval)]).toEqual([
          kind,
          approval,
          mapped,
        ])
      }
    }
    // Pi has no approval prompt, so asking for one is answered with a choice, not a downgrade.
    expect(agentConfigurationDefinitions.pi.approvals).toEqual(['deny', 'unrestricted'])
    expect(defaultApproval('pi')).toBe('deny')
    expect(defaultApproval('opencode')).toBe('ask')
    expect(defaultApproval('pi', 'unrestricted')).toBe('unrestricted')
  })

  it('states which CLIs reach tool servers directly', () => {
    for (const kind of engines) {
      const needsExtension = codes(kind, { mcpServers: [toolServer] }).includes('mcp-extension')
      expect([kind, agentConfigurationDefinitions[kind].tools]).toEqual([
        kind,
        needsExtension ? 'extension-required' : 'native',
      ])
    }
  })

  it('lists the routes and reasoning values each CLI has, without inventing any', () => {
    expect(agentConfigurationDefinitions.opencode.reasoning).toEqual([])
    expect(agentConfigurationDefinitions.pi.reasoning).toEqual([
      'off',
      'minimal',
      'low',
      'medium',
      'high',
      'xhigh',
      'max',
    ])
    expect(agentConfigurationDefinitions['deepseek-harness'].reasoning).toEqual([
      'off',
      'low',
      'high',
      'max',
    ])
    expect(agentConfigurationDefinitions['deepseek-harness'].routes).toContain('deepseek-official')
    expect(agentConfigurationDefinitions.pi.routes).not.toContain('deepseek-official')
  })

  it('marks a required option that has to be chosen before a run', () => {
    for (const kind of engines) {
      for (const field of agentConfigurationDefinitions[kind].options) {
        if (field.requirement === 'required') expect(field.fallback).not.toBeNull()
        if (field.values) expect(field.values.length).toBeGreaterThan(0)
        if (field.values && field.fallback) expect(field.values).toContain(field.fallback)
      }
    }
  })
})
