import { expect, it } from 'vitest'
import {
  importedProviderBaseUrl,
  nativeProviderBaseUrl,
} from '../src/shared/engines/provider-endpoint'
import { engineConfigurationIssues } from '../src/shared/engines/validation'
import { resolveAgentProfile } from '../src/shared/engines/resolution'
import { piWorkspace } from './helpers/pi-fixture'
import { planPiImport } from '../src/main/native-import/pi'
import { planDshImport } from '../src/main/native-import/dsh'
import { planOpenCodeImport } from '../src/main/native-import/opencode'
import { parseImportYaml } from '../src/main/native-import/dsh-yaml'
import { useProtocol } from './helpers/bindings'

it.each([
  'https://gateway.test/proxy',
  'https://gateway.test/proxy/',
  'https://gateway.test/proxy/v1',
  'https://gateway.test/proxy/v1/',
])('maps %s to one Messages target across SDK contracts', (value) => {
  expect(nativeProviderBaseUrl('anthropic-messages', value, 'opencode') + '/messages').toBe(
    'https://gateway.test/proxy/v1/messages',
  )
  for (const engine of ['pi', 'deepseek-harness'] as const)
    expect(nativeProviderBaseUrl('anthropic-messages', value, engine) + '/v1/messages').toBe(
      'https://gateway.test/proxy/v1/messages',
    )
})
it('handles origin roots, encoded proxy paths and unrelated protocols without path loss', () => {
  expect(nativeProviderBaseUrl('anthropic-messages', 'https://gateway.test', 'opencode')).toBe(
    'https://gateway.test/v1',
  )
  expect(nativeProviderBaseUrl('anthropic-messages', 'https://gateway.test/v1', 'pi')).toBe(
    'https://gateway.test',
  )
  expect(
    nativeProviderBaseUrl('anthropic-messages', 'https://gateway.test/proxy%2Ftenant/v1/', 'pi'),
  ).toBe('https://gateway.test/proxy%2Ftenant')
  for (const protocol of [
    'openai-chat-completions',
    'openai-responses',
    'deepseek-official',
    'gemini',
  ] as const)
    expect(nativeProviderBaseUrl(protocol, 'https://gateway.test/custom/', 'pi')).toBe(
      'https://gateway.test/custom/',
    )
})

it.each(['?token=private', '#private', '/messages', '/messages/'])(
  'diagnoses unsupported Anthropic suffix %s without including its value',
  (suffix) => {
    const workspace = piWorkspace('/engine', '/project')
    useProtocol(workspace, 'anthropic-messages')
    workspace.connections[0]!.baseUrl = `https://gateway.test/v1${suffix}`
    workspace.connections[0]!.auth = {
      kind: 'api-key',
      header: 'x-api-key',
      secret: { kind: 'environment', name: 'KEY' },
    }
    const resolution = resolveAgentProfile(workspace, 'reviewer')
    if (resolution.status !== 'resolved') throw new Error('Expected resolved fixture')
    const issues = engineConfigurationIssues(resolution.configuration)
    expect(issues).toContainEqual({
      code: 'endpoint',
      field: 'connection',
      nativeFeature: 'connection.endpoint',
    })
    expect(JSON.stringify(issues)).not.toContain('private')
  },
)

it.each(['https://gateway.test/proxy', 'https://gateway.test/proxy/v1'])(
  'preserves the Pi/DSH native request target when importing %s',
  (native) => {
    const pi = planPiImport(
      {
        'models.json': {
          providers: {
            custom: {
              api: 'anthropic-messages',
              baseUrl: native,
              apiKey: '$KEY',
              models: [{ id: 'fixture' }],
            },
          },
        },
      },
      'pi',
      'fixture',
    )
    const dsh = planDshImport(
      {
        'settings.yaml': parseImportYaml(
          JSON.stringify({
            'llm-pi-ai': {
              providers: {
                custom: {
                  api: 'anthropic-messages',
                  baseURL: native,
                  apiKeyEnv: 'KEY',
                  models: [{ id: 'fixture' }],
                },
              },
            },
          }),
          false,
        ),
      },
      'dsh',
      'fixture',
    )
    for (const [engine, plan] of [
      ['pi', pi],
      ['deepseek-harness', dsh],
    ] as const) {
      const connection = plan.additions.connections[0]!
      expect(connection.baseUrl).toBe(native + '/v1')
      expect(nativeProviderBaseUrl(connection.protocol, connection.baseUrl, engine)).toBe(native)
      expect(plan.mappings).toContainEqual(expect.objectContaining({ field: 'baseUrl' }))
    }
  },
)

it('preserves representable OpenCode native endpoints and diagnoses other paths without remapping them', () => {
  for (const native of ['https://gateway.test/proxy/v1/', 'https://gateway.test/nonstandard']) {
    const plan = planOpenCodeImport(
      { provider: { custom: { npm: '@ai-sdk/anthropic', options: { baseURL: native } } } },
      'opencode',
      'fixture',
    )
    if (native.endsWith('/v1/')) {
      expect(plan.additions.connections[0]!.baseUrl).toBe('https://gateway.test/proxy/v1')
    } else {
      expect(plan.additions.connections[0]!.baseUrl).toBe('')
      expect(plan.diagnostics).toContainEqual({
        path: '/provider/custom/options/baseURL',
        code: 'invalid-value',
      })
      expect(() => importedProviderBaseUrl('anthropic-messages', native, 'opencode')).toThrow()
    }
  }
})
