import { describe, expect, it } from 'vitest'
import { configurationMismatch } from '../src/main/engines/adapters/opencode/readback'

describe('requested OpenCode configuration readback', () => {
  it('permits added native defaults while checking each explicitly requested value', () => {
    const requested = {
      provider: { custom: { options: { baseURL: 'http://localhost/v1', apiKey: 'synthetic' } } },
      agent: { build: { prompt: 'role' } },
    }
    const loaded = { ...structuredClone(requested), theme: 'system', permission: 'ask' }
    expect(configurationMismatch(requested, loaded)).toBeNull()
    loaded.provider.custom.options.baseURL = 'http://different/v1'
    expect(configurationMismatch(requested, loaded)).toBe('provider.custom.options.baseURL')
    loaded.provider.custom.options.baseURL = requested.provider.custom.options.baseURL
    loaded.agent.build.prompt = 'native override'
    expect(configurationMismatch(requested, loaded)).toBe('agent.build.prompt')
  })
  it('allows extra native instruction files but preserves selected instruction order', () => {
    expect(
      configurationMismatch(
        { instructions: ['a', 'b'] },
        { instructions: ['native', 'a', 'extra', 'b'] },
      ),
    ).toBeNull()
    expect(configurationMismatch({ instructions: ['a', 'b'] }, { instructions: ['b', 'a'] })).toBe(
      'instructions',
    )
    expect(
      configurationMismatch(
        { mcp: { fixture: { command: ['node', 'file.js'] } } },
        { mcp: { fixture: { command: ['node', 'injected', 'file.js'] } } },
      ),
    ).toBe('mcp.fixture.command')
  })
  it('accepts equivalent permission normalization and detects differing per-tool rules', () => {
    const expected = { agent: { build: { permission: 'ask' } } }
    expect(
      configurationMismatch(expected, {
        agent: { build: { permission: { '*': 'ask', read: 'ask' } } },
      }),
    ).toBeNull()
    for (const permission of [{ '*': 'ask', read: 'allow' }, { read: 'ask' }, 'allow']) {
      expect(configurationMismatch(expected, { agent: { build: { permission } } })).toBe(
        'agent.build.permission',
      )
    }
  })
  it('does not confuse missing, null, false, and empty configuration', () => {
    for (const value of [null, false, {}, []]) {
      expect(configurationMismatch({ selected: value }, {})).toBe('selected')
    }
    expect(configurationMismatch({ feature: false }, { feature: null })).toBe('feature')
  })
})
