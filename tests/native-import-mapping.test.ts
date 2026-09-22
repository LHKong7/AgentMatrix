import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { parseNativeJsonc } from '../src/main/native-import/jsonc'
import { planOpenCodeImport } from '../src/main/native-import/opencode'
import { openCodePromptReferences } from '../src/main/native-import/opencode-prompts'

const plan = (source: string) =>
  planOpenCodeImport(parseNativeJsonc(source), 'opencode', randomUUID())
describe('inert OpenCode configuration parsing', () => {
  it('accepts JSONC without expanding macros, executing plugins or interpreting prototype keys', () => {
    const parsed = parseNativeJsonc(`{
      // Native source comments survive in the separate archive.
      "__proto__": {"polluted": true},
      "constructor": "data",
      "prompt": "{file:/not-read}",
      "key": "{env:NOT_RESOLVED}",
    }`)
    expect(Object.getPrototypeOf(parsed)).toBeNull()
    expect(parsed.prompt).toBe('{file:/not-read}')
    expect(parsed.__proto__).toEqual({ polluted: true })
    expect(Object.hasOwn({}, 'polluted')).toBe(false)
  })
  it.each([
    '[]',
    'null',
    '{"a":1,"a":2}',
    '{"a":{"x":1,"x":2}}',
    '{"secret":"do-not-echo"',
    '{"n":1e1000}',
  ])('rejects invalid/ambiguous input without echoing source values', (source) => {
    expect(() => parseNativeJsonc(source)).toThrow('error.nativeImportSyntax')
    try {
      parseNativeJsonc(source)
    } catch (error) {
      expect(String(error)).not.toContain('do-not-echo')
    }
  })
  it('bounds depth and value count', () => {
    expect(() => parseNativeJsonc(JSON.stringify({ ['a'.repeat(201)]: 0 }))).toThrow(
      'error.nativeImportLimit',
    )
    expect(() => parseNativeJsonc('{"a":'.repeat(34) + '0' + '}'.repeat(34))).toThrow(
      'error.nativeImportLimit',
    )
    expect(() => parseNativeJsonc(JSON.stringify({ values: Array(4000).fill(0) }))).toThrow(
      'error.nativeImportLimit',
    )
  })
})

describe('OpenCode native-to-shared mapping', () => {
  it('offers only supported local Prompt fields with escaped provenance pointers', () => {
    expect(
      openCodePromptReferences(
        parseNativeJsonc(
          JSON.stringify({
            agent: {
              'worker/~': { prompt: '{file:./role.md}' },
              mixed: { prompt: 'prefix {file:./role.md}' },
              environment: { prompt: '{env:ROLE}' },
              empty: { prompt: '{file:}' },
            },
            instructions: [
              './rules/*.md',
              '/selected/path',
              '~/rules.md',
              'https://example.test/rules',
              '{env:RULES}',
              42,
              '',
            ],
          }),
        ),
      ),
    ).toEqual([
      { path: '/agent/worker~1~0/prompt', reference: '{file:./role.md}', mode: 'replace' },
      { path: '/instructions/0', reference: './rules/*.md', mode: 'append' },
      { path: '/instructions/1', reference: '/selected/path', mode: 'append' },
      { path: '/instructions/2', reference: '~/rules.md', mode: 'append' },
    ])
  })
  it('maps explicitly selected files to replacement and shared ordered append bindings without expanding nested macros', () => {
    const data = parseNativeJsonc(
      JSON.stringify({
        agent: {
          'worker/~': { prompt: '{file:./role.md}' },
          other: { prompt: 'Inline role' },
          unresolved: { prompt: '{file:/never-read}' },
        },
        instructions: ['./first.md', './unselected.md', './third.md'],
      }),
    )
    const selected = new Map([
      ['/agent/worker~1~0/prompt', '\uFEFF  Role {file:/never-read} {env:NEVER_READ}\r\n'],
      ['/instructions/2', 'Third\r\n'],
      ['/instructions/0', '\uFEFFFirst\n'],
    ])
    const result = planOpenCodeImport(data, 'opencode', randomUUID(), selected)
    const bindings = result.additions.agents.map((agent) =>
      agent.promptBindings.map((binding) => ({
        mode: binding.mode,
        content: result.additions.prompts.find((prompt) => prompt.id === binding.assetId)!
          .versions[0]!.content,
      })),
    )
    const appended = [
      { mode: 'append', content: '\uFEFFFirst\n' },
      { mode: 'append', content: 'Third\r\n' },
    ]
    expect(bindings).toEqual([
      [{ mode: 'replace', content: 'Role {file:/never-read} {env:NEVER_READ}' }, ...appended],
      [{ mode: 'replace', content: 'Inline role' }, ...appended],
      appended,
    ])
    expect(result.additions.agents.every((agent) => !agent.enabled)).toBe(true)
    expect(result.additions.prompts).toHaveLength(4)
    for (const path of selected.keys()) {
      expect(result.mappings).toContainEqual(
        expect.objectContaining({ path, collection: 'prompts', field: 'versions[0].content' }),
      )
      expect(result.diagnostics).toContainEqual({ path, code: 'review-prompt-selection' })
    }
    expect(result.diagnostics).toContainEqual({
      path: '/agent/unresolved/prompt',
      code: 'unresolved-reference',
    })
    expect(result.diagnostics).toContainEqual({ path: '/instructions/1', code: 'unconverted' })
  })
  it.each(['', ' \r\n', 'a'.repeat(100_001)])(
    'retains empty or oversized selected content as unmapped data (%#)',
    (content) => {
      const data = parseNativeJsonc(
        '{"agent":{"worker":{"prompt":"{file:role.md}"}},"instructions":["rules.md"]}',
      )
      const paths = ['/agent/worker/prompt', '/instructions/0']
      const result = planOpenCodeImport(
        data,
        'opencode',
        randomUUID(),
        new Map(paths.map((path) => [path, content])),
      )
      expect(result.additions.prompts).toHaveLength(0)
      expect(result.additions.agents[0]!.promptBindings).toEqual([])
      for (const path of paths)
        expect(result.diagnostics).toContainEqual({ path, code: 'invalid-value' })
    },
  )
  it('diagnoses unrepresentable dictionary keys instead of silently stripping configured headers or environment values', () => {
    const result = plan(
      '{"provider":{"custom":{"npm":"@ai-sdk/openai-compatible","options":{"headers":{"__proto__":"private-header"}}}},"mcp":{"local":{"type":"local","command":["server"],"environment":{"__proto__":"private-env"}}}}',
    )
    expect(result.credentials).toHaveLength(0)
    expect(result.diagnostics).toEqual(
      expect.arrayContaining([
        { path: '/provider/custom/options/headers/__proto__', code: 'invalid-value' },
        { path: '/mcp/local/environment/__proto__', code: 'invalid-value' },
      ]),
    )
    expect(result.mappings.map((entry) => entry.path)).not.toContain(
      '/mcp/local/environment/__proto__',
    )
  })
  it('does not label invalid values or unresolved OAuth scopes as successfully mapped', () => {
    const result = plan(
      JSON.stringify({
        provider: { custom: { npm: '@ai-sdk/google', name: false } },
        mcp: {
          remote: {
            type: 'remote',
            url: 'https://example.test/mcp',
            enabled: 'false',
            oauth: { scope: '{env:MCP_SCOPE}', clientSecret: 'unconverted-oauth-secret' },
          },
        },
        agent: { worker: { description: 42 } },
      }),
    )
    expect(result.additions.mcpServers[0]).toMatchObject({
      enabled: false,
      auth: { kind: 'oauth', scopes: [] },
    })
    expect(result.diagnostics).toEqual(
      expect.arrayContaining([
        { path: '/mcp/remote/enabled', code: 'invalid-value' },
        { path: '/mcp/remote/oauth/scope', code: 'unresolved-reference' },
        { path: '/mcp/remote/oauth/clientSecret', code: 'unconverted' },
        { path: '/provider/custom/name', code: 'unconverted' },
        { path: '/agent/worker/description', code: 'unconverted' },
      ]),
    )
    expect(result.mappings.map((entry) => entry.path)).not.toContain('/mcp/remote/enabled')
    expect(result.mappings.map((entry) => entry.path)).not.toContain('/mcp/remote/oauth/scope')
    expect(JSON.stringify(result)).not.toContain('unconverted-oauth-secret')
  })
  it('maps SDK protocols, route overrides, inline prompts and policies into disabled drafts', () => {
    const result = plan(
      JSON.stringify({
        provider: {
          custom: {
            npm: '@ai-sdk/openai-compatible',
            name: 'Local',
            options: { baseURL: 'https://example.test/v1', apiKey: 'synthetic-key' },
            models: {
              alias: {
                id: 'api-model',
                name: 'My model',
                limit: { context: 1000 },
                cost: { input: 0 },
              },
            },
          },
        },
        model: 'custom/alias',
        agent: {
          worker: {
            prompt: 'A shared role 中文',
            temperature: 0.4,
            top_p: 0.8,
            permission: 'deny',
          },
        },
        plugin: ['./never-execute.js'],
        instructions: ['do-not-read.md'],
      }),
    )
    expect(result.additions.connections[0]).toMatchObject({
      protocol: 'openai-chat-completions',
      baseUrl: 'https://example.test/v1',
      auth: { kind: 'bearer', secret: { kind: 'credential' } },
    })
    expect(result.additions.models).toHaveLength(2)
    expect(result.additions.models[1]).toMatchObject({
      modelId: 'api-model',
      parameters: { temperature: 0.4, topP: 0.8 },
    })
    expect(result.additions.agents[0]).toMatchObject({
      enabled: false,
      modelProfileId: result.additions.models[1]!.id,
      execution: { cwd: '', approval: 'deny' },
      engineOptions: { kind: 'opencode', agent: 'worker' },
    })
    expect(result.additions.prompts[0]!.versions[0]!.content).toBe('A shared role 中文')
    expect(result.additions.agents[0]!.promptBindings[0]).toMatchObject({
      assetId: result.additions.prompts[0]!.id,
      mode: 'replace',
    })
    expect(result.credentials[0]!.value).toBe('synthetic-key')
    expect(JSON.stringify(result.additions)).not.toContain('synthetic-key')
    expect(result.diagnostics.map((item) => item.path)).toEqual(
      expect.arrayContaining([
        '/provider/custom/models/alias/limit/context',
        '/provider/custom/models/alias/cost/input',
        '/plugin/0',
        '/instructions/0',
      ]),
    )
    // Mapping the model's object key must not consume its unconverted children.
    expect(result.mappings).toContainEqual(
      expect.objectContaining({ path: '/provider/custom/models/alias/id', field: 'modelId' }),
    )
  })
  it('keeps literal headers and environment values in the vault and exact env macros as references', () => {
    const result = plan(
      JSON.stringify({
        provider: {
          anthropic: {
            npm: '@ai-sdk/anthropic',
            options: {
              apiKey: '{env:MODEL_KEY}',
              baseURL: '{env:MODEL_URL}',
              headers: { 'X-Tenant': 'secret-tenant' },
            },
          },
        },
        model: 'anthropic/native-model',
        mcp: {
          local: {
            type: 'local',
            command: ['node', '/opt/mcp/server.js'],
            cwd: './relative',
            environment: { TOKEN: 'secret-mcp', FROM_ENV: '{env:OTHER_KEY}', EMPTY: '' },
            timeout: 5000,
            enabled: false,
          },
          remote: {
            type: 'remote',
            url: 'https://mcp.example.test/mcp',
            oauth: false,
            headers: { Authorization: 'Bearer secret-remote' },
          },
        },
      }),
    )
    expect(result.credentials.map((item) => item.value)).toEqual([
      'secret-tenant',
      'secret-mcp',
      'Bearer secret-remote',
    ])
    expect(result.additions.connections[0]).toMatchObject({
      baseUrl: '',
      auth: {
        kind: 'api-key',
        header: 'x-api-key',
        secret: { kind: 'environment', name: 'MODEL_KEY' },
      },
    })
    expect(result.additions.mcpServers[0]).toMatchObject({
      transport: 'stdio',
      enabled: false,
      command: 'node',
      args: ['/opt/mcp/server.js'],
      cwd: '',
      environment: { EMPTY: '' },
      envRefs: { FROM_ENV: { kind: 'environment', name: 'OTHER_KEY' } },
      timeoutMs: 5000,
    })
    expect(result.additions.mcpServers[1]).toMatchObject({
      transport: 'streamable-http',
      auth: { kind: 'none' },
    })
    expect(result.diagnostics).toContainEqual({
      path: '/mcp/local/cwd',
      code: 'unresolved-reference',
    })
    expect(JSON.stringify(result.additions)).not.toContain('secret-')
  })
  it('retains custom SDKs and model overrides for review without guessing compatible routes', () => {
    const result = plan(
      JSON.stringify({
        provider: {
          custom: {
            npm: 'my-unknown-sdk',
            options: { apiKey: 'raw-secret' },
            models: { model: { headers: { Authorization: 'raw-secret' } } },
          },
        },
        model: 'custom/model',
        permission: { bash: 'allow' },
      }),
    )
    expect(result.additions.connections[0]!.protocol).toBeNull()
    expect(result.additions.models[0]!.connectionId).toBeNull()
    expect(result.credentials).toHaveLength(0)
    expect(result.additions.agents[0]!.execution.approval).toBe('ask')
    expect(result.diagnostics).toContainEqual({ path: '/permission', code: 'review-policy' })
    expect(result.diagnostics).toContainEqual({
      path: '/provider/custom/options/apiKey',
      code: 'unconverted',
    })
    expect(JSON.stringify(result)).not.toContain('raw-secret')
  })
  it('does not persist macro bodies, recognized credential argv or URL-embedded credentials', () => {
    const result = plan(
      JSON.stringify({
        provider: {
          remote: {
            npm: '@ai-sdk/openai',
            options: { apiKey: '{file:/secret}', baseURL: 'https://user:password@example.test' },
          },
        },
        mcp: {
          local: { type: 'local', command: ['server', '--api-key', 'private-argument'] },
          remote: { type: 'remote', url: 'https://example.test/?key=private-query' },
        },
        agent: { worker: { prompt: '{file:/private-prompt}' } },
      }),
    )
    expect(result.additions.mcpServers).toHaveLength(0)
    expect(result.additions.prompts).toHaveLength(0)
    expect(result.credentials).toHaveLength(0)
    expect(JSON.stringify(result)).not.toMatch(
      /private-argument|private-query|private-prompt|user:password/,
    )
  })
  it('escapes provenance pointers and never drops unconverted siblings behind a model key mapping', () => {
    const result = plan(
      '{"provider":{"a/b~c":{"npm":"@ai-sdk/google","models":{"m":{"future":{"private":"kept"}}}}},"future":{"token":"kept"}}',
    )
    expect(result.diagnostics).toContainEqual({
      path: '/provider/a~1b~0c/models/m/future/private',
      code: 'unconverted',
    })
    expect(result.diagnostics).toContainEqual({ path: '/future/token', code: 'unconverted' })
  })
})
