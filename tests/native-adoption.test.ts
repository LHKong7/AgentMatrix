import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { parseNativeJsonc } from '../src/main/native-import/jsonc'
import { planOpenCodeImport } from '../src/main/native-import/opencode'
import { credentialReachesEngine } from '../src/shared/engines/provider'
import { createEngineWorkspace } from '../src/shared/engines/workspace'

const source = JSON.stringify({
  provider: {
    minimax: {
      npm: '@ai-sdk/openai-compatible',
      name: 'MiniMax',
      options: { baseURL: 'https://api.minimax.io/v1', apiKey: 'synthetic-adoption-secret' },
      models: { 'MiniMax-M3': {} },
    },
    unknown: { name: 'Unrecognized', options: { baseURL: 'https://api.example.com' } },
  },
})
const plan = (installationId = 'opencode-1') =>
  planOpenCodeImport(parseNativeJsonc(source), installationId, randomUUID())

describe('adopting a provider out of a CLI’s own configuration', () => {
  it('names the provider, records where it was read, and grants that CLI alone', () => {
    const adopted = plan()
    const minimax = adopted.additions.connections.find(
      (connection) => connection.name === 'MiniMax',
    )!
    expect(minimax.provider).toEqual({
      vendor: 'minimax',
      product: '',
      region: '',
      organization: '',
      endpointScope: 'route-base',
    })
    expect(minimax.origin).toMatchObject({
      kind: 'adopted',
      engine: 'opencode',
      installationId: 'opencode-1',
      path: '/provider/minimax',
    })
    const grant = adopted.bindings.find((binding) => binding.connectionId === minimax.id)!
    expect(grant).toMatchObject({
      installationId: 'opencode-1',
      route: 'openai-chat-completions',
      nativeProviderId: 'minimax',
      adapterVersion: 'opencode-acp@1+1.18.16',
    })
    // The grant covers the installation the configuration was read from, and no other.
    const workspace = {
      ...createEngineWorkspace(),
      connections: adopted.additions.connections,
      engineBindings: adopted.bindings,
    }
    expect(credentialReachesEngine(workspace, 'opencode-1', minimax.id)).toBe(true)
    expect(credentialReachesEngine(workspace, 'pi-1', minimax.id)).toBe(false)
  })

  it('adopts a provider whose route it could not identify without granting it', () => {
    const adopted = plan()
    const unknown = adopted.additions.connections.find(
      (connection) => connection.name === 'Unrecognized',
    )!
    expect(unknown.protocol).toBeNull()
    expect(unknown.origin).toMatchObject({ kind: 'adopted', path: '/provider/unknown' })
    // A root the adapter still appends a route to is not the same as a base it sends to.
    expect(unknown.provider?.endpointScope).toBe('provider-root')
    expect(adopted.bindings.map((binding) => binding.connectionId)).not.toContain(unknown.id)
  })

  it('keeps the grant identifiers unique and inside one import', () => {
    const first = plan()
    const second = plan('opencode-2')
    const identifiers = [...first.bindings, ...second.bindings].map((binding) => binding.id)
    expect(new Set(identifiers).size).toBe(identifiers.length)
    for (const id of identifiers) expect(id).toMatch(/^[a-zA-Z0-9_-]{1,100}$/)
    expect(second.bindings.every((binding) => binding.installationId === 'opencode-2')).toBe(true)
  })
})
