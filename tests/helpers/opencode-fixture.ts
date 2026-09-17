import type { EngineWorkspace } from '../../src/shared/engines/workspace'

export function openCodeWorkspace(executable: string, cwd: string): EngineWorkspace {
  return {
    schemaVersion: 2,
    revision: 1,
    installations: [
      {
        id: 'oc',
        name: 'OpenCode',
        kind: 'opencode',
        executable,
        prefixArgs: [],
        platform: process.platform as 'darwin' | 'linux' | 'win32',
        version: '1.18.16',
        modes: ['acp'],
        probedAt: '2026-09-18T00:00:00Z',
      },
    ],
    agents: [
      {
        id: 'reviewer',
        name: 'Reviewer',
        description: '',
        enabled: true,
        engineInstallationId: 'oc',
        modelProfileId: 'model',
        bundleIds: [],
        nativePluginIds: [],
        mcpServerIds: [],
        engineOptions: { kind: 'opencode', agent: 'build' },
        execution: { cwd, approval: 'ask' },
        promptBindings: [
          { assetId: 'role', mode: 'replace', selection: { follow: 'latest' } },
          { assetId: 'rules', mode: 'append', selection: { follow: 'latest' } },
        ],
        skillBindings: [{ assetId: 'review-skill', selection: { follow: 'latest' } }],
      },
    ],
    connections: [
      {
        id: 'local',
        name: 'Custom endpoint',
        protocol: 'openai-chat-completions',
        baseUrl: 'http://127.0.0.1:8080/v1',
        auth: { kind: 'bearer', secret: { kind: 'environment', name: 'PROBE_KEY' } },
        headers: { 'X-Probe': 'agentmatrix' },
        secretHeaders: {},
      },
    ],
    models: [
      {
        id: 'model',
        name: 'Custom model',
        modelId: 'fixture-model',
        connectionId: 'local',
        parameters: {},
      },
    ],
    prompts: [
      {
        id: 'role',
        name: 'Role',
        description: '',
        enabled: true,
        purpose: 'role',
        currentVersion: 1,
        versions: [
          {
            version: 1,
            content: 'You are the AgentMatrix integration probe. Preserve the marker ROLE_MARKER.',
          },
        ],
      },
      {
        id: 'rules',
        name: 'Rules',
        description: '',
        enabled: true,
        purpose: 'project-rule',
        currentVersion: 1,
        versions: [{ version: 1, content: 'Additional instruction APPEND_MARKER.' }],
      },
    ],
    skills: [
      {
        id: 'review-skill',
        name: 'Review changes',
        description: '',
        enabled: true,
        sourcePath: '',
        currentVersion: 1,
        versions: [{ version: 1, kind: 'markdown', content: 'Inspect the diff. SKILL_MARKER.' }],
      },
    ],
    bundles: [],
    nativePlugins: [],
    mcpServers: [],
  }
}
