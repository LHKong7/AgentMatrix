import { describe, expect, it } from 'vitest'
import {
  BrowserWorkspaceStore,
  legacyPreviewStorageKey,
  previewStorageKey,
} from '../src/shared/engines/browser-store'
import {
  createLibraryEntry,
  createProfile,
  profileResourceCounts,
  removeConfiguration,
  reviseMarkdownSkill,
  revisePrompt,
  upsertConfiguration,
} from '../src/shared/engines/editing'
import { migrateWorkspaceDocument } from '../src/shared/engines/migration'
import { createWorkspace } from '../src/shared/workspace'

function fixture() {
  return migrateWorkspaceDocument(createWorkspace()).workspace
}
describe('v2 configuration editing', () => {
  it('counts enabled shared assets once across direct and bundled bindings', () => {
    const workspace = fixture()
    workspace.bundles.push({
      id: 'b',
      name: 'Bundle',
      enabled: true,
      description: '',
      version: '1.0.0',
      promptBindings: workspace.agents[0]!.promptBindings,
      mcpServerIds: [],
      skillBindings: [],
    })
    workspace.agents[0]!.bundleIds = ['b']
    expect(profileResourceCounts(workspace, workspace.agents[0]!)).toEqual({
      prompts: 1,
      skills: 0,
      mcp: 0,
      bundles: 1,
    })
    workspace.prompts[0]!.enabled = false
    workspace.bundles[0]!.enabled = false
    expect(profileResourceCounts(workspace, workspace.agents[0]!)).toEqual({
      prompts: 0,
      skills: 0,
      mcp: 0,
      bundles: 0,
    })
  })
  it('preserves dependent agents and models as drafts when a shared connection is deleted', () => {
    const workspace = fixture()
    const next = removeConfiguration(workspace, 'connections', workspace.connections[0]!.id)
    expect(next.agents).toEqual(workspace.agents)
    expect(next.models[0]?.connectionId).toBeNull()
    expect(workspace.connections).toHaveLength(1)
    expect(workspace.models[0]?.connectionId).not.toBeNull()
  })
  it('removes references from direct and bundled bindings while preserving other assets', () => {
    const workspace = fixture()
    const prompt = workspace.prompts[0]!
    workspace.bundles.push({
      id: 'bundle',
      name: 'Bundle',
      description: '',
      enabled: true,
      version: '1.0.0',
      promptBindings: [
        { assetId: prompt.id, mode: 'append', selection: { follow: 'pinned', version: 1 } },
      ],
      mcpServerIds: [],
      skillBindings: [],
    })
    workspace.agents[0]!.bundleIds = ['bundle']
    const next = removeConfiguration(workspace, 'prompts', prompt.id)
    expect(next.agents[0]?.promptBindings).toEqual([])
    expect(next.bundles[0]?.promptBindings).toEqual([])
    expect(next.agents[0]?.bundleIds).toEqual(['bundle'])
    expect(next.models).toEqual(workspace.models)
    expect(workspace.prompts[0]).toEqual(prompt)
  })
  it('cleans installation-owned plugin references without deleting the agent', () => {
    const workspace = fixture()
    workspace.installations.push({
      id: 'engine',
      name: 'Pi',
      kind: 'pi',
      executable: '/bin/pi',
      prefixArgs: [],
      version: null,
      modes: [],
      probedAt: null,
      platform: 'darwin',
    })
    workspace.nativePlugins.push({
      id: 'extension',
      name: 'Extension',
      engineInstallationId: 'engine',
      nativeId: 'plugin',
      version: '1',
      source: 'local',
      path: '/plugins/extension.ts',
    })
    workspace.agents[0]!.engineInstallationId = 'engine'
    workspace.agents[0]!.nativePluginIds = ['extension']
    const next = removeConfiguration(workspace, 'installations', 'engine')
    expect(next.agents[0]).toMatchObject({ engineInstallationId: null, nativePluginIds: [] })
    expect(next.nativePlugins).toEqual([])
    expect(next.agents).toHaveLength(1)
  })
  it('appends content revisions, preserves pins, and avoids a version bump for unchanged text', () => {
    const workspace = fixture()
    const original = workspace.prompts[0]!
    const next = revisePrompt(original, 'New shared content')
    expect(next.versions[0]).toEqual(original.versions[0])
    expect(next.currentVersion).toBe(2)
    expect(revisePrompt(next, 'New shared content')).toBe(next)
    expect(upsertConfiguration(workspace, 'prompts', next).agents).toEqual(workspace.agents)
    expect(() =>
      reviseMarkdownSkill(
        {
          id: 's',
          name: 'S',
          description: '',
          enabled: true,
          sourcePath: '',
          currentVersion: 1,
          versions: [
            {
              version: 1,
              kind: 'directory',
              digest: 'a'.repeat(64),
              files: [{ path: 'SKILL.md', sha256: 'b'.repeat(64), bytes: 1, executable: false }],
            },
          ],
        },
        'text',
      ),
    ).toThrow('assetDirectoryEdit')
    expect(createProfile('new', 'zh-CN').name).toBe('新 Agent')
    expect(createLibraryEntry('models', 'm', 'darwin')).toMatchObject({
      parameters: {},
      connectionId: null,
    })
  })
})

describe('browser v2 migration and persistence', () => {
  function storage() {
    const values = new Map<string, string>()
    return {
      values,
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => {
        values.set(key, value)
      },
    }
  }
  it('creates fresh v2 drafts without legacy temperature, provider, or engine assumptions', () => {
    const data = storage()
    const initial = new BrowserWorkspaceStore(data, 'zh-CN').load()
    expect(initial.schemaVersion).toBe(2)
    expect(initial.models).toEqual([])
    expect(initial.connections).toEqual([])
    expect(initial.installations).toEqual([])
    expect(initial.agents[0]).toMatchObject({
      engineInstallationId: null,
      modelProfileId: null,
      engineOptions: null,
    })
    expect(initial.prompts[0]?.versions[0]?.content).toContain('你是一位')
    expect(data.getItem(legacyPreviewStorageKey)).toBeNull()
  })
  it('retains exact legacy bytes, migrates once, and enforces revision and history checks', () => {
    const data = storage()
    const original = JSON.stringify(createWorkspace('zh-CN'), null, 4)
    data.setItem(legacyPreviewStorageKey, original)
    const store = new BrowserWorkspaceStore(data, 'en')
    const migrated = store.load()
    expect(migrated.schemaVersion).toBe(2)
    expect(data.getItem(legacyPreviewStorageKey)).toBe(original)
    expect(new BrowserWorkspaceStore(data, 'zh-CN').load()).toEqual(migrated)
    const saved = store.save(migrated)
    expect(() => store.save(migrated)).toThrow('conflict')
    saved.prompts[0]!.versions[0]!.content = 'Rewrite'
    expect(() => store.save(saved)).toThrow('assetHistory')
  })
  it('never resets an unreadable v2 file or deletes v1 on quota failure', () => {
    const data = storage()
    const original = JSON.stringify(createWorkspace())
    data.setItem(legacyPreviewStorageKey, original)
    data.setItem(previewStorageKey, 'broken')
    expect(() => new BrowserWorkspaceStore(data, 'en').load()).toThrow('unreadable')
    expect(data.getItem(previewStorageKey)).toBe('broken')
    data.values.delete(previewStorageKey)
    const failing = {
      getItem: data.getItem,
      setItem: () => {
        throw new Error('Quota exceeded')
      },
    }
    expect(() => new BrowserWorkspaceStore(failing, 'en').load()).toThrow('Quota exceeded')
    expect(data.getItem(legacyPreviewStorageKey)).toBe(original)
    expect(data.getItem(previewStorageKey)).toBeNull()
  })
})
