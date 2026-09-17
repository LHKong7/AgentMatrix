import { describe, expect, it } from 'vitest'
import { createWorkspace } from '../src/shared/workspace'
import { migrateWorkspaceDocument } from '../src/shared/engines/migration'
import { engineWorkspaceSchema, skillVersionSchema } from '../src/shared/engines/workspace'

function legacyFixture() {
  const workspace = createWorkspace('zh-CN')
  workspace.revision = 12
  workspace.agents[0]!.id = 'a'.repeat(100)
  workspace.agents[0]!.systemPrompt = '保留原始内容\n{template}\n'
  workspace.agents[0]!.model = 'custom-model'
  workspace.agents[0]!.baseUrl = 'https://api.example.test/v1'
  workspace.agents[0]!.pluginIds = ['kit']
  workspace.agents[0]!.skillIds = ['review']
  workspace.mcpServers.push(
    {
      id: 'docs',
      name: 'Docs',
      description: '',
      enabled: true,
      transport: 'streamable-http',
      url: 'https://docs.example.test/mcp',
      bearerTokenEnv: 'DOCS_TOKEN',
    },
    {
      id: 'local',
      name: 'Local',
      description: '',
      enabled: true,
      transport: 'stdio',
      command: 'node',
      args: ['a path with spaces/server.js'],
      envRefs: { TOKEN: 'LOCAL_TOKEN' },
    },
  )
  workspace.skills.push({
    id: 'review',
    name: 'Review',
    description: '',
    enabled: false,
    instructions: 'Review carefully.',
    sourcePath: '/unread/skill',
  })
  workspace.plugins.push({
    id: 'kit',
    name: 'Kit',
    description: '',
    enabled: true,
    version: '1.2.3',
    mcpServerIds: ['docs', 'local'],
    skillIds: ['review'],
  })
  return workspace
}

describe('schema v2 asset migration', () => {
  it('preserves content, IDs, bundle references, environment references, and unresolved choices', () => {
    const old = legacyFixture()
    const before = structuredClone(old)
    const { workspace, migrated } = migrateWorkspaceDocument(old)
    expect(migrated).toBe(true)
    expect(old).toEqual(before)
    expect(workspace.revision).toBe(12)
    expect(workspace.agents[0]).toMatchObject({
      id: old.agents[0]!.id,
      engineInstallationId: null,
      engineOptions: null,
      bundleIds: ['kit'],
      promptBindings: [{ mode: null }],
    })
    expect(workspace.connections[0]).toMatchObject({
      protocol: null,
      baseUrl: old.agents[0]!.baseUrl,
      auth: { kind: 'unconfigured' },
    })
    expect(workspace.models[0]).toMatchObject({
      modelId: 'custom-model',
      parameters: { temperature: 0.7 },
    })
    expect(workspace.prompts[0]!.versions[0]!.content).toBe(old.agents[0]!.systemPrompt)
    expect(workspace.skills[0]).toMatchObject({
      sourcePath: '/unread/skill',
      enabled: false,
      versions: [{ kind: 'markdown', content: 'Review carefully.' }],
    })
    expect(workspace.bundles[0]).toMatchObject({
      id: 'kit',
      version: '1.2.3',
      mcpServerIds: ['docs', 'local'],
      skillBindings: [{ assetId: 'review' }],
    })
    expect(workspace.mcpServers[0]).toMatchObject({
      auth: { kind: 'bearer', secret: { kind: 'environment', name: 'DOCS_TOKEN' } },
    })
    expect(workspace.mcpServers[1]).toMatchObject({
      args: ['a path with spaces/server.js'],
      envRefs: { TOKEN: { kind: 'environment', name: 'LOCAL_TOKEN' } },
    })
    expect(workspace.installations).toEqual([])
  })

  it('is deterministic and does not migrate an already converted document twice', () => {
    const first = migrateWorkspaceDocument(legacyFixture())
    expect(migrateWorkspaceDocument(legacyFixture())).toEqual(first)
    expect(migrateWorkspaceDocument(first.workspace)).toEqual({
      workspace: first.workspace,
      migrated: false,
    })
  })

  it('rejects corrupt or future documents without mutating their input', () => {
    for (const input of [{ schemaVersion: 3 }, { schemaVersion: 2 }, legacyFixture()]) {
      if ('agents' in input) input.agents[0]!.pluginIds = ['missing']
      const before = structuredClone(input)
      expect(() => migrateWorkspaceDocument(input)).toThrow()
      expect(input).toEqual(before)
    }
  })

  it('rejects dangling pins, duplicate versions, and deleted bundle references', () => {
    const { workspace } = migrateWorkspaceDocument(legacyFixture())
    workspace.agents[0]!.promptBindings[0]!.selection = { follow: 'pinned', version: 2 }
    expect(engineWorkspaceSchema.safeParse(workspace).success).toBe(false)
    workspace.agents[0]!.promptBindings[0]!.selection = { follow: 'latest' }
    workspace.prompts[0]!.versions.push({ version: 1, content: 'Changed' })
    expect(engineWorkspaceSchema.safeParse(workspace).success).toBe(false)
    workspace.prompts[0]!.versions.pop()
    workspace.bundles = []
    expect(engineWorkspaceSchema.safeParse(workspace).success).toBe(false)
  })

  it('validates complete portable Skill manifests without reading arbitrary paths', () => {
    const file = { path: 'SKILL.md', sha256: 'a'.repeat(64), bytes: 10, executable: false }
    const asset = { version: 1, kind: 'directory', digest: 'b'.repeat(64), files: [file] }
    expect(skillVersionSchema.safeParse(asset).success).toBe(true)
    for (const path of [
      '../secret',
      '/absolute',
      'dir/../secret',
      'C:\\secret',
      'dir//file',
      'dir/./file',
    ]) {
      expect(
        skillVersionSchema.safeParse({ ...asset, files: [file, { ...file, path }] }).success,
      ).toBe(false)
    }
    expect(
      skillVersionSchema.safeParse({ ...asset, files: [{ ...file, path: 'README.md' }] }).success,
    ).toBe(false)
    expect(
      skillVersionSchema.safeParse({ ...asset, files: [file, { ...file, path: 'skill.md' }] })
        .success,
    ).toBe(false)
  })
})
