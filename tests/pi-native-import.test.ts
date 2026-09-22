import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { parsePiSecretValue } from '../src/main/native-import/pi-values'
import { planPiImport, type PiImportDocuments } from '../src/main/native-import/pi'
import { parseNativeJsonc } from '../src/main/native-import/jsonc'
const plan = (files: PiImportDocuments) => planPiImport(files, 'pi', randomUUID())

describe('Pi secret templates remain inert data', () => {
  it.each([
    ['!touch /never-executed', { kind: 'unresolved' }],
    ['$API_KEY', { kind: 'environment', name: 'API_KEY' }],
    ['${API_KEY}', { kind: 'environment', name: 'API_KEY' }],
    ['API_KEY', { kind: 'literal', value: 'API_KEY' }],
    ['$!not-a-command', { kind: 'literal', value: '!not-a-command' }],
    ['$$API_KEY', { kind: 'literal', value: '$API_KEY' }],
    ['${PREFIX}_$SUFFIX', { kind: 'unresolved' }],
    ['Bearer $TOKEN', { kind: 'unresolved' }],
    ['${not-valid $NAME}', { kind: 'literal', value: '${not-valid $NAME}' }],
    ['literal$', { kind: 'literal', value: 'literal$' }],
    ['  !plain', { kind: 'literal', value: '  !plain' }],
  ])('parses %s without resolving it', (input, result) =>
    expect(parsePiSecretValue(input as string)).toEqual(result),
  )
  it('requires strict JSON for Pi while retaining OpenCode JSONC support', () => {
    for (const source of ['{"a":1,}', '{/*comment*/"a":1}', '{"a":1,"a":2}'])
      expect(() => parseNativeJsonc(source, true)).toThrow('error.nativeImportSyntax')
    expect(parseNativeJsonc('{/*comment*/"a":1,}')).toEqual({ a: 1 })
  })
})

describe('Pi import mapping and precedence', () => {
  it('reports dictionary keys that shared persistence cannot retain instead of claiming a mapping', () => {
    const result = plan({
      'models.json': parseNativeJsonc(
        '{"providers":{"custom":{"api":"openai-completions","headers":{"__proto__":"private-header"}}}}',
      ),
    })
    expect(result.credentials).toHaveLength(0)
    expect(result.diagnostics).toContainEqual({
      path: '/models.json/providers/custom/headers/__proto__',
      code: 'invalid-value',
    })
    expect(result.mappings.map((entry) => entry.path)).not.toContain(
      '/models.json/providers/custom/headers/__proto__',
    )
  })
  it('maps model-level routes, sampling, selected defaults and both prompt modes', () => {
    const result = plan({
      'models.json': {
        providers: {
          gateway: {
            api: 'openai-completions',
            baseUrl: 'https://example.test/v1',
            apiKey: 'literal-key',
            headers: { 'X-Shared': '$HEADER_KEY' },
            models: [
              {
                id: 'first',
                name: 'First model',
                samplingParams: { temperature: 0.4, top_p: 0.8, top_k: 12 },
                contextWindow: 1234,
              },
              {
                id: 'second',
                api: 'anthropic-messages',
                baseUrl: 'https://second.example.test',
                headers: { 'X-Model': '$!literal$$header' },
              },
            ],
          },
        },
      },
      'settings.json': {
        defaultProvider: 'gateway',
        defaultModel: 'first',
        defaultThinkingLevel: 'off',
        extensions: ['do-not-execute.ts'],
        skills: ['do-not-read'],
        defaultTools: ['read'],
      },
      'SYSTEM.md': 'Imported role {env:NOT_INTERPRETED}\n',
      'APPEND_SYSTEM.md': 'Extra instructions $NOT_INTERPRETED\n',
    })
    expect(result.additions.connections).toHaveLength(2)
    expect(result.additions.connections[0]).toMatchObject({
      protocol: 'openai-chat-completions',
      baseUrl: 'https://example.test/v1',
      secretHeaders: { 'X-Shared': { kind: 'environment', name: 'HEADER_KEY' } },
    })
    expect(result.additions.connections[1]).toMatchObject({
      protocol: 'anthropic-messages',
      baseUrl: 'https://second.example.test/v1',
      auth: { kind: 'api-key', header: 'x-api-key' },
    })
    expect(result.additions.models[0]).toMatchObject({
      modelId: 'first',
      parameters: { temperature: 0.4, topP: 0.8 },
    })
    expect(result.additions.models[1]!.connectionId).toBe(result.additions.connections[1]!.id)
    expect(result.additions.agents[0]).toMatchObject({
      enabled: false,
      modelProfileId: result.additions.models[0]!.id,
      engineOptions: {
        kind: 'pi',
        thinkingLevel: 'off',
        projectTrust: 'deny',
        contextFiles: 'inherit',
      },
      execution: { cwd: '', approval: 'ask' },
    })
    expect(result.additions.agents[0]!.promptBindings.map((entry) => entry.mode)).toEqual([
      'replace',
      'append',
    ])
    expect(result.additions.prompts.map((entry) => entry.versions[0]!.content)).toEqual([
      'Imported role {env:NOT_INTERPRETED}\n',
      'Extra instructions $NOT_INTERPRETED\n',
    ])
    expect(result.credentials.map((entry) => entry.value)).toEqual([
      'literal-key',
      '!literal$header',
    ])
    expect(result.diagnostics).toEqual(
      expect.arrayContaining([
        {
          path: '/models.json/providers/gateway/models/0/samplingParams/top_k',
          code: 'unconverted',
        },
        { path: '/models.json/providers/gateway/models/0/contextWindow', code: 'unconverted' },
        { path: '/settings.json/defaultTools', code: 'review-policy' },
        { path: '/settings.json/extensions/0', code: 'unconverted' },
      ]),
    )
  })
  it('uses selected auth.json before configured keys and captures explicit env values as literal credentials', () => {
    const result = plan({
      'models.json': {
        providers: {
          gateway: {
            api: 'openai-completions',
            baseUrl: 'https://example.test',
            apiKey: 'shadowed-provider-secret',
            headers: { 'X-Key': '$AUTH_HEADER' },
            models: [{ id: 'model' }],
          },
        },
      },
      'auth.json': {
        gateway: {
          type: 'api_key',
          key: '$AUTH_KEY',
          env: {
            AUTH_KEY: '!literal-auth-key',
            AUTH_HEADER: '$literal-header',
            UNUSED: 'unknown-env-secret',
          },
        },
      },
      'settings.json': { defaultProvider: 'gateway', defaultModel: 'model' },
    })
    expect(result.credentials.map((entry) => entry.value)).toEqual([
      '!literal-auth-key',
      '$literal-header',
    ])
    expect(result.mappings).toContainEqual(
      expect.objectContaining({ path: '/auth.json/gateway/env/AUTH_KEY', field: 'auth' }),
    )
    expect(result.mappings).toContainEqual(
      expect.objectContaining({
        path: '/auth.json/gateway/env/AUTH_HEADER',
        field: 'secretHeaders',
      }),
    )
    expect(JSON.stringify({ ...result, credentials: [] })).not.toMatch(
      /shadowed-provider-secret|literal-auth-key|literal-header|unknown-env-secret/,
    )
    expect(result.diagnostics).toContainEqual({
      path: '/models.json/providers/gateway/apiKey',
      code: 'unconverted',
    })
  })
  it.each(['!never-execute', 'prefix_$SECRET'])(
    'does not fall back to another key when a stored credential is unresolved: %s',
    (key) => {
      const result = plan({
        'models.json': {
          providers: {
            custom: {
              api: 'openai-completions',
              baseUrl: 'https://example.test',
              apiKey: 'do-not-use',
            },
          },
        },
        'auth.json': { custom: { type: 'api_key', key } },
      })
      expect(result.additions.connections[0]!.auth).toEqual({ kind: 'unconfigured' })
      expect(result.credentials).toHaveLength(0)
      expect(result.diagnostics).toContainEqual({
        path: '/auth.json/custom/key',
        code: 'unresolved-reference',
      })
    },
  )
  it('retains OAuth tokens and unsupported API families without guessing a runnable key route', () => {
    const result = plan({
      'models.json': {
        providers: {
          oauth: { api: 'openai-completions', apiKey: 'fallback-secret' },
          unknown: { api: 'future-api', apiKey: 'unmapped-key' },
        },
      },
      'auth.json': {
        oauth: {
          type: 'oauth',
          access: 'private-access',
          refresh: 'private-refresh',
          expires: 123,
        },
      },
    })
    expect(result.additions.connections[0]!.auth).toEqual({ kind: 'engine-login' })
    expect(result.additions.connections[1]!.protocol).toBeNull()
    expect(result.credentials).toHaveLength(0)
    expect(JSON.stringify(result)).not.toMatch(
      /fallback-secret|unmapped-key|private-access|private-refresh/,
    )
  })
  it('does not infer a default model or reproduce incompatible model overrides', () => {
    const result = plan({
      'models.json': {
        providers: {
          custom: {
            api: 'openai-completions',
            baseUrl: 'https://example.test',
            models: [{ id: 'one', compat: { supportsDeveloperRole: false } }, { id: 'two' }],
          },
        },
      },
    })
    expect(result.additions.agents[0]!.modelProfileId).toBeNull()
    expect(result.additions.models[0]!.connectionId).toBeNull()
    expect(result.diagnostics).toContainEqual({
      path: '/models.json/providers/custom/models/0/compat/supportsDeveloperRole',
      code: 'unconverted',
    })
  })
  it('rejects ambiguous model IDs and does not map empty prompts', () => {
    expect(() =>
      plan({
        'models.json': { providers: { custom: { models: [{ id: 'same' }, { id: 'same' }] } } },
      }),
    ).toThrow('error.invalidData')
    const result = plan({ 'SYSTEM.md': '', 'APPEND_SYSTEM.md': '   ' })
    expect(result.additions.prompts).toHaveLength(0)
    expect(result.diagnostics).toHaveLength(2)
  })
})
