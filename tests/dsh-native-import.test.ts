import { describe, expect, it } from 'vitest'
import { planDshImport } from '../src/main/native-import/dsh'
import {
  dshSections,
  field,
  origin,
  type DshImportDocuments,
} from '../src/main/native-import/dsh-layers'
import { ImportExpression, parseImportYaml } from '../src/main/native-import/dsh-yaml'

const yaml = (text: string, expressions = false) => parseImportYaml(text, expressions)
const map = (files: DshImportDocuments) => planDshImport(files, 'dsh', 'fixture')
const settings = `
llm-pi-ai:
  providers:
    gateway:
      api: openai-completions
      baseURL: https://gateway.example/v1
      apiKeyEnv: CUSTOM_KEY
      headers:
        X-Private: header-secret
      models:
        - id: model-one
          name: First model
agent-default-model:
  provider: gateway
  model: model-one
  reasoningEffort: off
`
describe('DSH native import', () => {
  it('retains executable tags as inert leaves and preserves literal text', () => {
    const parsed = yaml('code: !!js process.exit(1)\nliteral: "!!js process.exit(1)"', true)
    expect(parsed).toEqual({
      code: new ImportExpression('process.exit(1)'),
      literal: '!!js process.exit(1)',
    })
    expect(() => yaml('code: !!js process.exit(1)')).toThrow('nativeImportYaml')
  })
  it.each([
    'key: one\nkey: two',
    'key: !unknown expression',
    'key: .inf',
    'key: .nan',
    'one: &first { value: a }\ntwo: *first',
    '<<: { value: a }',
    '? [a, b]\n: value',
    'one: 1\n---\ntwo: 2',
    '1: value',
  ])('rejects ambiguous or unsupported YAML: %s', (input) => {
    expect(() => yaml(input, true)).toThrow('nativeImportYaml')
  })
  it.each([
    'version: 2',
    'version: 1\nunknown: secret',
    'version: 1\nrefs: {KEY: 123}',
    'version: 1\nrecords: {bad: {kind: grant, payload: secret}}',
    'version: 1\nrecords: {llm-pi-ai/gateway: {kind: other}}',
  ])('rejects invalid credential documents without importing partial secrets', (input) => {
    expect(() =>
      map({ 'settings.yaml': yaml(settings), '.credentials.yaml': yaml(input) }),
    ).toThrow('nativeImportYaml')
  })
  it('bounds nested nodes, key lengths and wide documents', () => {
    expect(() => yaml('['.repeat(40) + 'null' + ']'.repeat(40))).toThrow('nativeImportLimit')
    expect(() => yaml('x'.repeat(201) + ': value')).toThrow('nativeImportLimit')
    expect(() => yaml(JSON.stringify(Array(4001).fill(null)))).toThrow('nativeImportLimit')
  })
  it('maps settings, selected stored keys, defaults and a literal persona without reading ambient values', () => {
    const files = {
      'settings.yaml': yaml(settings),
      '.credentials.yaml': yaml(
        'version: 1\nrefs:\n  CUSTOM_KEY: stored-secret\nrecords:\n  llm-pi-ai/unused:\n    kind: grant\n    payload: {access: unused-token}',
      ),
      'cordis.patch.yml': yaml(
        '- insert:\n    - id: system\n      name: "@deepseek-ai/dsh-system-prompt"\n      config:\n        personaPrefix: "Imported instructions $HOME"',
        true,
      ),
    }
    const result = map(files)
    expect(result.credentials.map((entry) => entry.value)).toEqual([
      'stored-secret',
      'header-secret',
    ])
    expect(result.additions.connections[0]).toMatchObject({
      protocol: 'openai-chat-completions',
      baseUrl: 'https://gateway.example/v1',
      auth: { kind: 'bearer', secret: { kind: 'credential' } },
    })
    expect(result.additions.agents[0]).toMatchObject({
      enabled: false,
      modelProfileId: result.additions.models[0]!.id,
      engineOptions: { kind: 'deepseek-harness', appendPosition: 'prefix' },
      execution: { cwd: '', approval: 'ask' },
    })
    expect(result.additions.prompts[0]!.versions[0]!.content).toBe('Imported instructions $HOME')
    expect(result.mappings).toContainEqual(
      expect.objectContaining({ path: '/.credentials.yaml/refs/CUSTOM_KEY', field: 'auth' }),
    )
    expect(result.diagnostics).toContainEqual({
      path: '/settings.yaml/llm-pi-ai/providers/gateway/apiKeyEnv',
      code: 'review-precedence',
    })
    expect(
      result.diagnostics.some((entry) =>
        entry.path.startsWith('/.credentials.yaml/records/llm-pi-ai~1unused'),
      ),
    ).toBe(true)
    expect(JSON.stringify({ ...result, credentials: [] })).not.toContain('stored-secret')
    expect(JSON.stringify({ ...result, credentials: [] })).not.toContain('header-secret')
    expect(JSON.stringify({ ...result, credentials: [] })).not.toContain('unused-token')
  })
  it('applies whole-row config replacement then recursively merges settings with exact leaf origins', () => {
    const files = {
      'cordis.yml': yaml(
        '- id: provider\n  name: "@deepseek-ai/dsh-llm-pi-ai"\n  config:\n    providers:\n      removed: {api: openai-responses, baseURL: https://old.example}',
        true,
      ),
      'cordis.patch.yml': yaml(
        '- id: provider\n  config:\n    providers:\n      gateway:\n        api: openai-completions\n        baseURL: https://base.example\n        apiKeyEnv: BASE_KEY\n        headers: {X-Base: original}\n        models: [{id: old-model}]',
        true,
      ),
      'settings.yaml': yaml(
        'llm-pi-ai:\n  providers:\n    gateway:\n      baseURL: https://final.example\n      models: [{id: final-model}]',
      ),
    }
    const before = JSON.stringify(files)
    const sections = dshSections(files, () => {})
    const gateway = field(field(sections.get('llm-pi-ai')!, 'providers'), 'gateway')
    expect(origin(field(gateway, 'baseURL'))).toBe(
      '/settings.yaml/llm-pi-ai/providers/gateway/baseURL',
    )
    expect(origin(field(gateway, 'api'))).toBe('/cordis.patch.yml/0/config/providers/gateway/api')
    const result = map(files)
    expect(result.additions.connections).toHaveLength(1)
    expect(result.additions.connections[0]!.baseUrl).toBe('https://final.example')
    expect(result.additions.models.map((item) => item.modelId)).toEqual(['final-model'])
    expect(result.additions.agents[0]!.modelProfileId).toBeNull()
    expect(JSON.stringify(files)).toBe(before)
    expect(result.mappings).toContainEqual(
      expect.objectContaining({ path: '/settings.yaml/llm-pi-ai/providers/gateway/models/0/id' }),
    )
  })
  it('does not infer missing bundles from conventional patch row IDs or activate disabled/conditional rows', () => {
    const result = map({
      'cordis.patch.yml': yaml(
        '- id: llm-pi-ai\n  config: {providers: {gateway: {api: openai-completions}}}',
        true,
      ),
    })
    expect(result.additions.connections).toEqual([])
    expect(result.diagnostics).toContainEqual({ path: '/cordis.patch.yml/0', code: 'unconverted' })
    for (const control of ['disabled: true', 'disabled: !!js true', 'filter: custom']) {
      const value = map({
        'cordis.yml': yaml(
          `- id: provider\n  name: '@deepseek-ai/dsh-llm-pi-ai'\n  ${control}`,
          true,
        ),
        'settings.yaml': yaml(settings),
      })
      expect(value.additions.connections).toEqual([])
    }
  })
  it('refuses duplicate row IDs, provider ownership and model IDs', () => {
    expect(() => map({ 'cordis.yml': yaml('- {id: same}\n- {id: same}', true) })).toThrow(
      'nativeImportYaml',
    )
    expect(() =>
      map({
        'settings.yaml': yaml(
          settings.replace(
            '- id: model-one\n          name: First model',
            '- id: model-one\n        - id: model-one',
          ),
        ),
      }),
    ).toThrow('invalidData')
    expect(() =>
      map({
        'settings.yaml': yaml(
          settings.replace('gateway:', 'deepseek-official:') + '\nllm-deepseek: {}',
        ),
      }),
    ).toThrow('invalidData')
  })
  it('preserves DeepSeek native routing, its default credential reference and default reasoning', () => {
    const result = map({
      'settings.yaml': yaml(
        'llm-deepseek:\n  baseURL: https://native.example\n  models: [{id: native-model}]\nagent-default-model: {provider: deepseek-official, model: native-model}',
      ),
    })
    expect(result.additions.connections[0]).toMatchObject({
      protocol: 'deepseek-official',
      auth: { kind: 'bearer', secret: { kind: 'environment', name: 'DEEPSEEK_API_KEY' } },
    })
    expect(result.additions.models[0]!.parameters.reasoning).toBe('high')
    expect(result.additions.agents[0]!.modelProfileId).toBe(result.additions.models[0]!.id)
  })
  it('retains unsupported compatibility and prompt templates without pretending they are literal settings', () => {
    const result = map({
      'settings.yaml': yaml(
        settings.replace(
          'apiKeyEnv: CUSTOM_KEY',
          'apiKeyEnv: CUSTOM_KEY\n      compat: {thinkingFormat: custom}',
        ),
      ),
      'cordis.yml': yaml(
        '- name: "@deepseek-ai/dsh-system-prompt"\n  config:\n    personaPrefix: "Hello {{user}}"\n    personaSuffix: !!js process.exit(1)',
        true,
      ),
    })
    expect(result.additions.models[0]!.connectionId).toBeNull()
    expect(result.additions.prompts).toEqual([])
    expect(
      result.diagnostics.filter((entry) => entry.code === 'unresolved-reference'),
    ).toHaveLength(2)
  })
  it('keeps both persona positions as separate assets requiring explicit binding review', () => {
    const result = map({
      'cordis.yml': yaml(
        '- name: "@deepseek-ai/dsh-system-prompt"\n  config: {personaPrefix: Before, personaSuffix: After}',
        true,
      ),
    })
    expect(result.additions.prompts).toHaveLength(2)
    expect(result.additions.agents[0]!.promptBindings).toEqual([])
    expect(result.diagnostics.some((entry) => entry.code === 'review-policy')).toBe(true)
  })
  it('maps only exact environment expressions and never evaluates dynamic expressions or ordinary object lookalikes', () => {
    const result = map({
      'cordis.yml': yaml(
        `- name: '@deepseek-ai/dsh-llm-pi-ai'
  config:
    providers:
      gateway:
        api: openai-completions
        baseURL: https://gateway.example
        apiKeyEnv: KEY
        headers:
          X-Env: !!js process.env.HEADER_KEY
          X-Quoted: !!js process.env['QUOTED_KEY']
          X-Dynamic: !!js (() => process.exit(1))()
          X-Lookalike: {source: process.env.HEADER_KEY}
          __proto__: secret
`,
        true,
      ),
    })
    expect(result.additions.connections[0]!.secretHeaders).toEqual({
      'X-Env': { kind: 'environment', name: 'HEADER_KEY' },
      'X-Quoted': { kind: 'environment', name: 'QUOTED_KEY' },
    })
    expect(result.credentials).toEqual([])
    expect(result.diagnostics.some((item) => item.code === 'unresolved-reference')).toBe(true)
  })
  it('keeps OAuth and command-based stored records opaque and does not fall back past explicit apiKeyEnv', () => {
    const base = settings.replace('      apiKeyEnv: CUSTOM_KEY\n', '')
    for (const record of [
      '{kind: grant, payload: {access: secret-token}}',
      '{kind: api-key, key: "!touch /never-run"}',
    ]) {
      const result = map({
        'settings.yaml': yaml(base),
        '.credentials.yaml': yaml(`version: 1\nrecords:\n  llm-pi-ai/gateway: ${record}`),
      })
      expect(result.credentials.map((entry) => entry.value)).toEqual(['header-secret'])
      expect(JSON.stringify(result.additions)).not.toContain('secret-token')
    }
    const result = map({
      'settings.yaml': yaml(settings),
      '.credentials.yaml': yaml(
        'version: 1\nrecords:\n  llm-pi-ai/gateway: {kind: api-key, key: record-secret}',
      ),
    })
    expect(result.additions.connections[0]!.auth).toEqual({
      kind: 'bearer',
      secret: { kind: 'environment', name: 'CUSTOM_KEY' },
    })
    expect(result.credentials.map((entry) => entry.value)).not.toContain('record-secret')
  })
})
