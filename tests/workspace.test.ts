import { describe, expect, it } from 'vitest'
import {
  createWorkspace,
  mcpServerSchema,
  removeResource,
  resolveResources,
  workspaceSchema,
  type Workspace,
} from '../src/shared/workspace'

function fixture(): Workspace {
  const workspace = createWorkspace()
  workspace.mcpServers.push({
    id: 'files',
    name: 'Files',
    description: '',
    enabled: true,
    transport: 'stdio',
    command: 'npx',
    args: ['-y', 'example-server'],
    envRefs: { TOKEN: 'MY_TOKEN' },
  })
  workspace.skills.push({
    id: 'writing',
    name: 'Writing',
    description: '',
    enabled: true,
    instructions: 'Write clearly.',
    sourcePath: '',
  })
  workspace.plugins.push({
    id: 'kit',
    name: 'Kit',
    description: '',
    enabled: true,
    version: '1.0.0',
    mcpServerIds: ['files'],
    skillIds: ['writing'],
  })
  workspace.agents[0]!.mcpServerIds = ['files']
  workspace.agents[0]!.pluginIds = ['kit']
  return workspace
}

describe('workspace boundaries', () => {
  it('accepts the initial workspace and valid bound resources', () => {
    expect(workspaceSchema.safeParse(createWorkspace()).success).toBe(true)
    expect(workspaceSchema.safeParse(fixture()).success).toBe(true)
  })
  it('rejects dangling bindings and duplicate IDs', () => {
    const state = fixture()
    state.agents[0]!.skillIds = ['missing']
    expect(workspaceSchema.safeParse(state).success).toBe(false)
    state.agents[0]!.skillIds = []
    state.plugins.push(state.plugins[0]!)
    expect(workspaceSchema.safeParse(state).success).toBe(false)
  })
  it('rejects unknown fields, empty names and unsupported schema versions', () => {
    expect(workspaceSchema.safeParse({ ...createWorkspace(), schemaVersion: 2 }).success).toBe(
      false,
    )
    expect(workspaceSchema.safeParse({ ...createWorkspace(), arbitrary: true }).success).toBe(false)
    const state = createWorkspace()
    state.agents[0]!.name = '   '
    expect(workspaceSchema.safeParse(state).success).toBe(false)
  })
  it('rejects non-http URLs and secret values in environment references', () => {
    expect(
      mcpServerSchema.safeParse({
        id: 'bad',
        name: 'Bad',
        description: '',
        enabled: true,
        transport: 'streamable-http',
        url: 'file:///etc/passwd',
        bearerTokenEnv: '',
      }).success,
    ).toBe(false)
    expect(
      mcpServerSchema.safeParse({
        ...fixture().mcpServers[0],
        envRefs: { TOKEN: 'sk-secret-value' },
      }).success,
    ).toBe(false)
  })
})

describe('resource composition', () => {
  it('merges plugin resources with direct bindings without duplicates', () => {
    const state = fixture()
    const effective = resolveResources(state, state.agents[0]!)
    expect(effective.mcpServers.map((item) => item.id)).toEqual(['files'])
    expect(effective.skills.map((item) => item.id)).toEqual(['writing'])
  })
  it('excludes disabled plugins and resources, and all capabilities of disabled agents', () => {
    const state = fixture()
    state.plugins[0]!.enabled = false
    expect(resolveResources(state, state.agents[0]!).skills).toEqual([])
    state.mcpServers[0]!.enabled = false
    expect(resolveResources(state, state.agents[0]!).mcpServers).toEqual([])
    state.agents[0]!.enabled = false
    expect(resolveResources(state, state.agents[0]!)).toEqual({
      mcpServers: [],
      skills: [],
      plugins: [],
    })
  })
  it('cleans direct and plugin references atomically without mutating the original', () => {
    const state = fixture()
    const next = removeResource(state, 'mcpServers', 'files')
    expect(next.mcpServers).toEqual([])
    expect(next.agents[0]!.mcpServerIds).toEqual([])
    expect(next.plugins[0]!.mcpServerIds).toEqual([])
    expect(state.mcpServers).toHaveLength(1)
    expect(workspaceSchema.safeParse(next).success).toBe(true)
  })
  it('removes plugin bindings while preserving independent resources', () => {
    const next = removeResource(fixture(), 'plugins', 'kit')
    expect(next.agents[0]!.pluginIds).toEqual([])
    expect(next.mcpServers).toHaveLength(1)
    expect(next.skills).toHaveLength(1)
  })
})
