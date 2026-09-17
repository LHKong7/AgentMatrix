import { describe, expect, it } from 'vitest'
import { createWorkspace } from '../src/shared/workspace'
import { migrateWorkspaceDocument } from '../src/shared/engines/migration'
import { resolveAgentProfile } from '../src/shared/engines/resolution'

function fixture() {
  const workspace = migrateWorkspaceDocument(createWorkspace()).workspace
  workspace.installations.push({
    id: 'oc',
    kind: 'opencode',
    name: 'OpenCode',
    executable: '/opt/bin/opencode',
    prefixArgs: [],
    platform: 'darwin',
    version: '1.18.16',
    modes: ['acp'],
    probedAt: '2026-09-18T00:00:00Z',
  })
  workspace.agents[0]!.engineInstallationId = 'oc'
  workspace.agents[0]!.execution.cwd = '/project'
  workspace.agents[0]!.promptBindings[0]!.mode = 'append'
  workspace.models[0]!.modelId = 'test-model'
  workspace.connections[0]!.protocol = 'openai-chat-completions'
  workspace.connections[0]!.baseUrl = 'http://localhost:8080/v1'
  workspace.connections[0]!.auth = { kind: 'none' }
  workspace.prompts[0]!.versions.push({ version: 2, content: 'Updated role' })
  workspace.prompts[0]!.currentVersion = 2
  return workspace
}
function resolve(workspace: ReturnType<typeof fixture>) {
  return resolveAgentProfile(workspace, workspace.agents[0]!.id)
}

describe('shared configuration resolution', () => {
  it('does not treat migrated drafts as ready to launch', () => {
    const result = resolve(migrateWorkspaceDocument(createWorkspace()).workspace)
    expect(result.status).toBe('invalid')
    if (result.status === 'invalid')
      expect(result.issues.map((issue) => issue.code)).toEqual(
        expect.arrayContaining([
          'engine-required',
          'model-required',
          'protocol-required',
          'authentication-required',
          'cwd-required',
          'prompt-mode-required',
        ]),
      )
  })
  it('resolves latest revisions independently of later edits and still requires adapter validation', () => {
    const workspace = fixture()
    const result = resolve(workspace)
    expect(result.status).toBe('resolved')
    if (result.status !== 'resolved') return
    expect(result.requiresAdapterValidation).toBe(true)
    expect(result.configuration.prompts[0]).toMatchObject({
      version: 2,
      content: 'Updated role',
      source: 'agent',
    })
    workspace.prompts[0]!.versions[1]!.content = 'Changed afterwards'
    expect(result.configuration.prompts[0]!.content).toBe('Updated role')
  })
  it('lets direct bindings override conflicting bundle pins while reporting unresolved peer conflicts', () => {
    const workspace = fixture()
    const assetId = workspace.prompts[0]!.id
    workspace.bundles = [1, 2].map((version) => ({
      id: `bundle-${version}`,
      name: `Bundle ${version}`,
      description: '',
      enabled: true,
      version: '1.0.0',
      promptBindings: [{ assetId, mode: 'append', selection: { follow: 'pinned', version } }],
      mcpServerIds: [],
      skillBindings: [],
    }))
    workspace.agents[0]!.bundleIds = workspace.bundles.map((bundle) => bundle.id)
    expect(resolve(workspace).status).toBe('resolved')
    workspace.agents[0]!.promptBindings = []
    expect(resolve(workspace)).toMatchObject({
      status: 'invalid',
      issues: [{ code: 'binding-conflict' }],
    })
    workspace.bundles[1]!.enabled = false
    const result = resolve(workspace)
    expect(result.status).toBe('resolved')
    if (result.status === 'resolved')
      expect(result.configuration.prompts[0]).toMatchObject({
        version: 1,
        source: 'bundle:bundle-1',
      })
  })
  it('rejects multiple replacements and an unavailable secret before materialization', () => {
    const workspace = fixture()
    workspace.prompts.push({ ...structuredClone(workspace.prompts[0]!), id: 'second' })
    workspace.agents[0]!.promptBindings = workspace.prompts.map((asset) => ({
      assetId: asset.id,
      mode: 'replace',
      selection: { follow: 'latest' },
    }))
    workspace.connections[0]!.auth = { kind: 'bearer', secret: null }
    const result = resolve(workspace)
    expect(result.status).toBe('invalid')
    if (result.status === 'invalid')
      expect(result.issues.map((issue) => issue.code)).toEqual(
        expect.arrayContaining(['secret-required', 'replacement-conflict']),
      )
  })
  it('rejects mismatched engine-specific settings and unprobed installations', () => {
    const workspace = fixture()
    workspace.agents[0]!.engineOptions = { kind: 'pi' }
    workspace.installations[0]!.version = null
    const result = resolve(workspace)
    expect(result.status).toBe('invalid')
    if (result.status === 'invalid')
      expect(result.issues.map((issue) => issue.code)).toEqual(
        expect.arrayContaining(['engine-unprobed', 'engine-options-mismatch']),
      )
  })
})
