import { describe, expect, it } from 'vitest'
import {
  bindConnectionToEngine,
  recordEvidence,
  releaseEngineBinding,
  removeConfiguration,
  upsertConfiguration,
} from '../src/shared/engines/editing'
import {
  evidenceStatus,
  fingerprintFor,
  hasEvidence,
  meetsEvidence,
} from '../src/shared/engines/evidence'
import { migrateWorkspaceDocument } from '../src/shared/engines/migration'
import {
  bindingIssues,
  connectionsBoundTo,
  credentialReachesEngine,
  grantCoversRoute,
  installationsBoundTo,
} from '../src/shared/engines/provider'
import { resolveAgentProfile } from '../src/shared/engines/resolution'
import {
  createEngineWorkspace,
  engineWorkspaceSchema,
  type EngineWorkspace,
} from '../src/shared/engines/workspace'

const at = '2026-09-22T00:00:00.000Z'
function workspace(): EngineWorkspace {
  const state = createEngineWorkspace()
  for (const [id, kind, version, modes] of [
    ['opencode-1', 'opencode', '1.18.16', ['acp']],
    ['pi-1', 'pi', '0.85.1', ['pi-rpc']],
  ] as const) {
    state.installations.push({
      id,
      name: id,
      kind,
      executable: `/opt/bin/${kind}`,
      prefixArgs: [],
      platform: 'darwin',
      version,
      modes: [...modes],
      probedAt: at,
    })
  }
  state.connections.push({
    id: 'minimax',
    name: 'MiniMax',
    protocol: 'openai-chat-completions',
    baseUrl: 'https://api.minimax.io/v1',
    auth: { kind: 'bearer', secret: { kind: 'credential', id: 'minimax-key' } },
    headers: {},
    secretHeaders: {},
    provider: {
      vendor: 'minimax',
      product: 'open-platform',
      region: 'global',
      organization: '',
      endpointScope: 'route-base',
    },
  })
  state.models.push({
    id: 'm3',
    name: 'MiniMax-M3',
    connectionId: 'minimax',
    modelId: 'MiniMax-M3',
    parameters: {},
  })
  for (const [id, installationId] of [
    ['writer', 'opencode-1'],
    ['second', 'pi-1'],
  ] as const) {
    state.agents.push({
      id,
      name: id,
      description: '',
      enabled: true,
      engineInstallationId: installationId,
      modelProfileId: 'm3',
      promptBindings: [],
      mcpServerIds: [],
      skillBindings: [],
      bundleIds: [],
      nativePluginIds: [],
      engineOptions: null,
      execution: { cwd: '/projects/app', approval: 'ask' },
    })
  }
  return engineWorkspaceSchema.parse(state)
}
const grantOpenCode = (state: EngineWorkspace) =>
  bindConnectionToEngine(state, {
    id: 'grant-opencode',
    installationId: 'opencode-1',
    connectionId: 'minimax',
    boundAt: at,
  })
const issuesFor = (state: EngineWorkspace, agentId: string) => {
  const resolution = resolveAgentProfile(state, agentId)
  return resolution.status === 'invalid' ? resolution.issues.map((issue) => issue.code) : []
}

describe('a connection reaches one CLI only through a grant', () => {
  it('hands the credential to the granted engine and to no other', () => {
    const granted = grantOpenCode(workspace())
    expect(credentialReachesEngine(granted, 'opencode-1', 'minimax')).toBe(true)
    expect(credentialReachesEngine(granted, 'pi-1', 'minimax')).toBe(false)
    expect(issuesFor(granted, 'writer')).toEqual([])
    // Pi speaks the same protocol and uses the same model profile. That is not authorization.
    expect(issuesFor(granted, 'second')).toEqual(['engine-binding-required'])
    const both = bindConnectionToEngine(granted, {
      id: 'grant-pi',
      installationId: 'pi-1',
      connectionId: 'minimax',
      boundAt: at,
    })
    expect(issuesFor(both, 'second')).toEqual([])
    expect(installationsBoundTo(both, 'minimax').map((item) => item.id)).toEqual([
      'opencode-1',
      'pi-1',
    ])
    expect(connectionsBoundTo(both, 'pi-1').map((item) => item.id)).toEqual(['minimax'])
  })

  it('withdraws the grant with the engine, the connection or the grant itself', () => {
    const granted = grantOpenCode(workspace())
    expect(releaseEngineBinding(granted, 'grant-opencode').engineBindings).toEqual([])
    expect(removeConfiguration(granted, 'installations', 'opencode-1').engineBindings).toEqual([])
    expect(removeConfiguration(granted, 'connections', 'minimax').engineBindings).toEqual([])
    // An unrelated removal keeps it.
    expect(removeConfiguration(granted, 'installations', 'pi-1').engineBindings).toHaveLength(1)
  })

  it('refuses a second grant, an unsupported route and a route the connection is not for', () => {
    const granted = grantOpenCode(workspace())
    expect(() =>
      bindConnectionToEngine(granted, {
        id: 'grant-again',
        installationId: 'opencode-1',
        connectionId: 'minimax',
      }),
    ).toThrow()
    expect(
      bindingIssues(granted, {
        id: 'draft',
        installationId: 'pi-1',
        connectionId: 'minimax',
        route: 'deepseek-official',
      }),
    ).toEqual(['route-unsupported', 'route-mismatch'])
    expect(
      bindingIssues(granted, {
        id: 'draft',
        installationId: 'opencode-1',
        connectionId: 'minimax',
        route: 'anthropic-messages',
      }),
    ).toEqual(['route-mismatch', 'duplicate'])
  })

  it('grants the pairs an upgraded workspace already used, and nothing more', () => {
    const document = JSON.parse(JSON.stringify(grantOpenCode(workspace()))) as Record<
      string,
      unknown
    >
    delete document.engineBindings
    const upgraded = migrateWorkspaceDocument(document, at)
    expect(upgraded.migrated).toBe(true)
    expect(upgraded.from).toBe(2)
    expect(
      upgraded.workspace.engineBindings.map((binding) => [
        binding.installationId,
        binding.connectionId,
        binding.route,
        binding.adapterVersion,
      ]),
    ).toEqual([
      ['opencode-1', 'minimax', 'openai-chat-completions', 'opencode-acp@1+1.18.16'],
      ['pi-1', 'minimax', 'openai-chat-completions', 'pi-rpc@1+0.85.1'],
    ])
    // A connection no agent uses stays unavailable to every engine.
    const unused = upsertConfiguration(upgraded.workspace, 'connections', {
      id: 'unused',
      name: 'Unused',
      protocol: 'openai-chat-completions',
      baseUrl: 'https://api.example.com/v1',
      auth: { kind: 'none' },
      headers: {},
      secretHeaders: {},
    })
    const document2 = JSON.parse(JSON.stringify(unused)) as Record<string, unknown>
    delete document2.engineBindings
    expect(
      migrateWorkspaceDocument(document2, at).workspace.engineBindings.map(
        (binding) => binding.connectionId,
      ),
    ).toEqual(['minimax', 'minimax'])
  })
})

describe('evidence records what was observed and never more', () => {
  const observed = (state: EngineWorkspace, kind: 'discovered' | 'connection-tested') =>
    recordEvidence(state, {
      id: `evidence-${kind}`,
      subject: { kind: 'connection', id: 'minimax' },
      kind,
      result: 'pass',
      fingerprint: fingerprintFor(state, { kind: 'connection', id: 'minimax' })!,
      adapterVersion: 'opencode-acp@1+1.18.16',
      observedAt: at,
    })

  it('does not promote a lower observation to a higher state', () => {
    const state = observed(grantOpenCode(workspace()), 'discovered')
    const subject = { kind: 'connection', id: 'minimax' } as const
    expect(evidenceStatus(state, subject).level).toBe('discovered')
    expect(hasEvidence(state, subject, 'discovered')).toBe(true)
    expect(hasEvidence(state, subject, 'configuration-valid')).toBe(false)
    expect(hasEvidence(state, subject, 'connection-tested')).toBe(false)
    // A stronger observation covers the weaker states it necessarily passed through.
    expect(meetsEvidence('model-response', 'connection-tested')).toBe(true)
    expect(meetsEvidence('connection-tested', 'model-response')).toBe(false)
    expect(meetsEvidence(null, 'discovered')).toBe(false)
  })

  it('retires a record when the subject it was observed on changes', () => {
    const tested = observed(grantOpenCode(workspace()), 'connection-tested')
    const subject = { kind: 'connection', id: 'minimax' } as const
    expect(evidenceStatus(tested, subject).level).toBe('connection-tested')
    const rotated = upsertConfiguration(tested, 'connections', {
      ...tested.connections[0]!,
      auth: { kind: 'bearer', secret: { kind: 'credential', id: 'rotated-key' } },
    })
    const status = evidenceStatus(rotated, subject)
    expect(status.level).toBeNull()
    expect(status.stale.map((record) => record.kind)).toEqual(['connection-tested'])
    // The record is kept, so the interface can say the endpoint was tested before, not now.
    expect(rotated.evidence).toHaveLength(1)
  })

  it('keeps a grant and an engine under separate observation', () => {
    const state = grantOpenCode(workspace())
    const binding = { kind: 'binding', id: 'grant-opencode' } as const
    const installation = { kind: 'installation', id: 'opencode-1' } as const
    expect(fingerprintFor(state, binding)).not.toBe(fingerprintFor(state, installation))
    const filed = recordEvidence(state, {
      id: 'session-ready',
      subject: binding,
      kind: 'session-ready',
      result: 'pass',
      fingerprint: fingerprintFor(state, binding)!,
      adapterVersion: 'opencode-acp@1+1.18.16',
      observedAt: at,
    })
    expect(evidenceStatus(filed, binding).level).toBe('session-ready')
    expect(evidenceStatus(filed, installation).level).toBeNull()
    // Withdrawing the grant drops what was only true of it.
    expect(releaseEngineBinding(filed, 'grant-opencode').evidence).toEqual([])
  })

  it('files one record per subject and kind, keeping the newest', () => {
    const first = observed(grantOpenCode(workspace()), 'connection-tested')
    const subject = { kind: 'connection', id: 'minimax' } as const
    const second = recordEvidence(first, {
      id: 'evidence-later',
      subject,
      kind: 'connection-tested',
      result: 'fail',
      fingerprint: fingerprintFor(first, subject)!,
      adapterVersion: 'opencode-acp@1+1.18.16',
      observedAt: '2026-09-22T01:00:00.000Z',
      detail: 'HTTP 401',
    })
    expect(second.evidence.map((record) => [record.id, record.result])).toEqual([
      ['evidence-later', 'fail'],
    ])
    const status = evidenceStatus(second, subject)
    expect(status.level).toBeNull()
    expect(status.failures.map((record) => record.detail)).toEqual(['HTTP 401'])
  })
})

describe('a grant is for one route', () => {
  it('stops covering the connection when it is repointed, until it is given again', () => {
    const granted = grantOpenCode(workspace())
    expect(issuesFor(granted, 'writer')).toEqual([])
    const repointed = upsertConfiguration(granted, 'connections', {
      ...granted.connections[0]!,
      protocol: 'anthropic-messages',
      auth: { kind: 'api-key', header: 'x-api-key', secret: { kind: 'credential', id: 'key' } },
    })
    expect(issuesFor(repointed, 'writer')).toEqual(['engine-binding-route'])
    expect(grantCoversRoute(repointed.engineBindings[0]!, repointed.connections[0]!)).toBe(false)
    // Giving it again for the new route replaces the grant rather than adding a second one.
    const regranted = bindConnectionToEngine(repointed, {
      id: 'grant-opencode',
      installationId: 'opencode-1',
      connectionId: 'minimax',
      boundAt: at,
    })
    expect(regranted.engineBindings).toHaveLength(1)
    expect(regranted.engineBindings[0]!.route).toBe('anthropic-messages')
    expect(issuesFor(regranted, 'writer')).toEqual([])
  })

  it('leaves a grant alone while the connection has no route of its own', () => {
    const granted = grantOpenCode(workspace())
    const draft = upsertConfiguration(granted, 'connections', {
      ...granted.connections[0]!,
      protocol: null,
    })
    expect(grantCoversRoute(draft.engineBindings[0]!, draft.connections[0]!)).toBe(true)
    expect(issuesFor(draft, 'writer')).toEqual(['protocol-required'])
  })
})
