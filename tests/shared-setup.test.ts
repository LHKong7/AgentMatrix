import { describe, expect, it } from 'vitest'
import {
  removeConfiguration,
  setSharedSetupParticipation,
  updateSharedSetup,
  upsertConfiguration,
} from '../src/shared/engines/editing'
import { resolveAgentProfile, sharedSetupFor, sharedSource } from '../src/shared/engines/resolution'
import {
  createEngineWorkspace,
  engineWorkspaceSchema,
  type EngineWorkspace,
} from '../src/shared/engines/workspace'

function workspace(): EngineWorkspace {
  const state = createEngineWorkspace()
  state.installations.push({
    id: 'installation-1',
    name: 'OpenCode',
    kind: 'opencode',
    executable: '/usr/local/bin/opencode',
    prefixArgs: [],
    platform: 'darwin',
    version: '1.18.16',
    modes: ['acp'],
    probedAt: '2026-09-18T00:00:00.000Z',
  })
  state.connections.push({
    id: 'connection-1',
    name: 'Provider',
    protocol: 'openai-chat-completions',
    baseUrl: 'https://api.example.com/v1',
    auth: { kind: 'bearer', secret: { kind: 'environment', name: 'API_KEY' } },
    headers: {},
    secretHeaders: {},
  })
  state.models.push({
    id: 'model-1',
    name: 'Model',
    connectionId: 'connection-1',
    modelId: 'gpt-4o-mini',
    parameters: {},
  })
  state.prompts.push({
    id: 'house-rules',
    name: 'House rules',
    description: '',
    enabled: true,
    purpose: 'role',
    currentVersion: 1,
    versions: [{ version: 1, content: 'Answer precisely.' }],
  })
  state.skills.push({
    id: 'review-skill',
    name: 'Review',
    description: '',
    enabled: true,
    sourcePath: '',
    currentVersion: 1,
    versions: [{ version: 1, kind: 'markdown', content: 'How to review.' }],
  })
  state.mcpServers.push({
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
  })
  for (const id of ['writer', 'reviewer']) {
    state.agents.push({
      id,
      name: id,
      description: '',
      enabled: true,
      engineInstallationId: 'installation-1',
      modelProfileId: 'model-1',
      promptBindings: [],
      mcpServerIds: [],
      skillBindings: [],
      bundleIds: [],
      nativePluginIds: [],
      engineOptions: { kind: 'opencode', agent: 'build' },
      execution: { cwd: '/projects/app', approval: 'ask' },
    })
  }
  state.engineBindings.push({
    id: 'grant-1',
    installationId: 'installation-1',
    connectionId: 'connection-1',
    route: 'openai-chat-completions',
    nativeProviderId: '',
    adapterVersion: 'opencode-acp@1+1.18.16',
    boundAt: '2026-09-18T00:00:00.000Z',
  })
  state.sharedSetup = {
    promptBindings: [
      { assetId: 'house-rules', selection: { follow: 'latest' }, mode: 'append' as const },
    ],
    skillBindings: [{ assetId: 'review-skill', selection: { follow: 'latest' } }],
    mcpServerIds: ['files'],
    bundleIds: [],
    excludedAgentIds: [],
  }
  return engineWorkspaceSchema.parse(state)
}
function resolved(state: EngineWorkspace, agentId: string) {
  const resolution = resolveAgentProfile(state, agentId)
  if (resolution.status !== 'resolved') throw new Error(`unresolved: ${JSON.stringify(resolution)}`)
  return resolution.configuration
}

describe('one setup for every CLI agent', () => {
  it('gives every agent the shared instructions, Skills and tools', () => {
    const state = workspace()
    for (const agentId of ['writer', 'reviewer']) {
      const configuration = resolved(state, agentId)
      expect(configuration.prompts).toEqual([
        {
          assetId: 'house-rules',
          version: 1,
          mode: 'append',
          content: 'Answer precisely.',
          source: sharedSource,
        },
      ])
      expect(configuration.skills.map((skill) => [skill.assetId, skill.source])).toEqual([
        ['review-skill', sharedSource],
      ])
      expect(configuration.mcpServers.map((server) => server.id)).toEqual(['files'])
    }
  })

  it("keeps each agent's own engine, model and endpoint out of the shared setup", () => {
    const state = workspace()
    state.installations.push({
      ...state.installations[0]!,
      id: 'installation-2',
      name: 'Pi',
      kind: 'pi',
      version: '0.85.1',
      modes: ['pi-rpc'],
    })
    state.connections.push({
      ...state.connections[0]!,
      id: 'connection-2',
      baseUrl: 'https://pi.example.com/v1',
    })
    state.models.push({ ...state.models[0]!, id: 'model-2', connectionId: 'connection-2' })
    const reviewer = state.agents.find((agent) => agent.id === 'reviewer')!
    reviewer.engineInstallationId = 'installation-2'
    reviewer.modelProfileId = 'model-2'
    reviewer.engineOptions = { kind: 'pi' }
    // The shared setup never grants a connection: Pi is granted connection-2 on its own.
    state.engineBindings.push({
      id: 'grant-2',
      installationId: 'installation-2',
      connectionId: 'connection-2',
      route: 'openai-chat-completions',
      nativeProviderId: '',
      adapterVersion: 'pi-rpc@1+0.85.1',
      boundAt: '2026-09-18T00:00:00.000Z',
    })
    const parsed = engineWorkspaceSchema.parse(state)
    expect(resolved(parsed, 'writer').connection.baseUrl).toBe('https://api.example.com/v1')
    expect(resolved(parsed, 'reviewer').installation.kind).toBe('pi')
    expect(resolved(parsed, 'reviewer').connection.baseUrl).toBe('https://pi.example.com/v1')
    // The shared prompt still reaches both, whichever CLI they run.
    expect(resolved(parsed, 'reviewer').prompts[0]?.assetId).toBe('house-rules')
  })

  it("lets an agent's own binding replace an inherited one for the same asset", () => {
    const state = workspace()
    const writer = state.agents.find((agent) => agent.id === 'writer')!
    writer.promptBindings = [
      { assetId: 'house-rules', selection: { follow: 'pinned', version: 1 }, mode: 'replace' },
    ]
    const configuration = resolved(engineWorkspaceSchema.parse(state), 'writer')
    expect(configuration.prompts).toEqual([
      {
        assetId: 'house-rules',
        version: 1,
        mode: 'replace',
        content: 'Answer precisely.',
        source: 'agent',
      },
    ])
  })

  it('excludes an agent that opted out, without touching its own bindings', () => {
    const state = setSharedSetupParticipation(workspace(), 'reviewer', false)
    expect(sharedSetupFor(state, 'reviewer')).toBeNull()
    expect(sharedSetupFor(state, 'writer')).not.toBeNull()
    expect(resolved(state, 'reviewer').prompts).toEqual([])
    expect(resolved(state, 'reviewer').skills).toEqual([])
    expect(resolved(state, 'reviewer').mcpServers).toEqual([])
    expect(resolved(state, 'writer').prompts).toHaveLength(1)
    const restored = setSharedSetupParticipation(state, 'reviewer', true)
    expect(resolved(restored, 'reviewer').prompts).toHaveLength(1)
    expect(restored.sharedSetup.excludedAgentIds).toEqual([])
  })

  it('keeps the shared references valid when a resource or agent is removed', () => {
    const excluded = setSharedSetupParticipation(workspace(), 'reviewer', false)
    const withoutPrompt = removeConfiguration(excluded, 'prompts', 'house-rules')
    expect(withoutPrompt.sharedSetup.promptBindings).toEqual([])
    const withoutServer = removeConfiguration(withoutPrompt, 'mcpServers', 'files')
    expect(withoutServer.sharedSetup.mcpServerIds).toEqual([])
    const withoutAgent = removeConfiguration(withoutServer, 'agents', 'reviewer')
    expect(withoutAgent.sharedSetup.excludedAgentIds).toEqual([])
    expect(() => engineWorkspaceSchema.parse(withoutAgent)).not.toThrow()
  })

  it('rejects a shared reference to a resource that does not exist', () => {
    const state = workspace()
    expect(() => updateSharedSetup(state, { mcpServerIds: ['absent'] })).toThrow()
    expect(() => updateSharedSetup(state, { excludedAgentIds: ['absent'] })).toThrow()
  })

  it('applies a newly added agent without further setup', () => {
    const state = upsertConfiguration(workspace(), 'agents', {
      ...workspace().agents[0]!,
      id: 'third',
      name: 'Third',
    })
    expect(resolved(state, 'third').prompts[0]?.source).toBe(sharedSource)
  })
})
