import { describe, expect, it } from 'vitest'
import { openCodeWorkspace } from './helpers/opencode-fixture'
import { piWorkspace } from './helpers/pi-fixture'
import { dshWorkspace } from './helpers/dsh-fixture'
import {
  resolveAgentProfile,
  type ResolvedAgentConfiguration,
} from '../src/shared/engines/resolution'
import {
  engineConfigurationIssues,
  assertEngineConfiguration,
} from '../src/shared/engines/validation'
import { describeConfigurationCapabilities } from '../src/shared/engines/capabilities'
import { engineContracts, type SupportedEngine } from '../src/shared/engines/contracts'
import {
  capabilitySchema,
  isVerifiedCapability,
  type ModelProtocol,
} from '../src/shared/engines/schema'
import { catalogs, isMessageKey } from '../src/shared/i18n'

function configuration(kind: SupportedEngine = 'opencode'): ResolvedAgentConfiguration {
  const workspace = (
    kind === 'opencode' ? openCodeWorkspace : kind === 'pi' ? piWorkspace : dshWorkspace
  )('/fixture/agent', '/fixture/project')
  const result = resolveAgentProfile(workspace, 'reviewer')
  if (result.status !== 'resolved') throw new Error('Invalid fixture')
  return result.configuration
}
function setProtocol(value: ResolvedAgentConfiguration, protocol: ModelProtocol) {
  value.connection.protocol = protocol
  value.connection.headers = {}
  value.connection.auth =
    protocol === 'anthropic-messages' || protocol === 'gemini'
      ? {
          kind: 'api-key',
          header: protocol === 'gemini' ? 'x-goog-api-key' : 'x-api-key',
          secret: { kind: 'environment', name: 'KEY' },
        }
      : { kind: 'bearer', secret: { kind: 'environment', name: 'KEY' } }
}

describe('engine configuration constraints before native work', () => {
  it.each(['opencode', 'pi', 'deepseek-harness'] as const)(
    'accepts the verified baseline mapping for %s without claiming runtime verification',
    async (kind) => {
      const value = configuration(kind),
        report = await describeConfigurationCapabilities(value, value.installation.platform)
      expect(report.eligibleForStartupChecks).toBe(true)
      expect(report.issues).toEqual([])
      expect(report.capabilities).toHaveLength(12)
      for (const capability of report.capabilities) {
        expect(capability.verification).toBe('untested')
        expect(capability.evidence[0]!.kind).toBe('contract')
        expect(isVerifiedCapability(capability, capability)).toBe(false)
        expect(capability.mode).toBe(engineContracts[kind].mode)
        expect(isMessageKey(capability.reason)).toBe(true)
        const { requested, ...descriptor } = capability
        expect(typeof requested).toBe('boolean')
        expect(capabilitySchema.safeParse(descriptor).success).toBe(true)
      }
      const plugins = report.capabilities.find((row) => row.feature === 'plugins')!
      expect(plugins).toMatchObject({
        requested: false,
        mechanism: kind === 'deepseek-harness' ? 'unsupported' : 'adapter',
        availability: kind === 'deepseek-harness' ? 'blocked' : 'unknown',
      })
      expect(
        report.capabilities.find((row) => row.feature === 'authentication')!.availability,
      ).toBe('unknown')
    },
  )
  it.each(['opencode', 'pi', 'deepseek-harness'] as const)(
    'preserves protocol families and rejects unmapped routes for %s',
    (kind) => {
      for (const protocol of [
        'openai-chat-completions',
        'openai-responses',
        'anthropic-messages',
        'gemini',
        'vertex',
        'deepseek-official',
      ] as const) {
        const value = configuration(kind)
        setProtocol(value, protocol)
        const expected =
          protocol !== 'vertex' && (protocol !== 'deepseek-official' || kind === 'deepseek-harness')
        expect(engineConfigurationIssues(value).length === 0, `${kind}/${protocol}`).toBe(expected)
      }
    },
  )
  it.each(['opencode', 'pi', 'deepseek-harness'] as const)(
    'checks API-key header semantics and login strategies for %s',
    (kind) => {
      const value = configuration(kind)
      setProtocol(value, 'anthropic-messages')
      value.connection.auth = {
        kind: 'api-key',
        header: 'Authorization',
        secret: { kind: 'environment', name: 'KEY' },
      }
      expect(engineConfigurationIssues(value).map((issue) => issue.code)).toContain(
        'authentication',
      )
      for (const auth of [
        { kind: 'engine-login' },
        { kind: 'cloud-identity', provider: 'aws' },
        { kind: 'none' },
      ] as const) {
        value.connection.auth = auth
        expect(engineConfigurationIssues(value).map((issue) => issue.code)).toContain(
          'authentication',
        )
      }
      setProtocol(value, 'openai-chat-completions')
      value.connection.auth = { kind: 'none' }
      expect(engineConfigurationIssues(value).length === 0).toBe(kind === 'opencode')
    },
  )
  it('rejects wrong versions, modes, options, platforms, and later engines', () => {
    const value = configuration('pi')
    expect(engineConfigurationIssues(value, { expectedEngine: 'opencode' })[0]!.code).toBe(
      'installation-version',
    )
    value.installation.version = '999.0.0'
    expect(engineConfigurationIssues(value)[0]!.code).toBe('installation-version')
    value.installation.version = engineContracts.pi.engineVersion
    value.installation.modes = ['acp']
    expect(engineConfigurationIssues(value)[0]!.code).toBe('installation-version')
    value.installation.modes = ['pi-rpc']
    expect(engineConfigurationIssues(value, { platform: 'win32' })[0]!.code).toBe('platform')
    expect(engineConfigurationIssues(value, { platform: 'browser' })).toEqual([])
    value.agent.engineOptions = { kind: 'opencode', agent: 'build' }
    expect(engineConfigurationIssues(value)[0]!.code).toBe('native-options')
    value.installation.kind = 'claude-code'
    expect(engineConfigurationIssues(value)[0]!.code).toBe('unsupported-engine')
    expect(() => assertEngineConfiguration(value)).toThrow('runtimeUnsupported')
  })
  it('keeps Pi trust independent from approval, and MCP dependent on a verified extension', async () => {
    const value = configuration('pi')
    value.agent.engineOptions = { kind: 'pi', projectTrust: 'trust-once' }
    value.agent.execution.approval = 'ask'
    value.mcpServers = [
      {
        id: 'server',
        name: 'MCP',
        description: '',
        enabled: true,
        transport: 'stdio',
        command: 'node',
        args: [],
        cwd: '',
        environment: {},
        envRefs: {},
      },
    ]
    const before = structuredClone(value),
      report = await describeConfigurationCapabilities(value)
    expect(report.issues.map((issue) => issue.code)).toEqual([
      'universal-approval',
      'mcp-extension',
    ])
    expect(report.capabilities.find((row) => row.feature === 'mcp')).toMatchObject({
      mechanism: 'extension-required',
      availability: 'missing-dependency',
      verification: 'untested',
      requested: true,
    })
    expect(() => assertEngineConfiguration(value)).toThrow('execution.universal-approval')
    expect(value).toEqual(before)
    value.agent.execution.approval = 'deny'
    expect(engineConfigurationIssues(value).map((issue) => issue.code)).toEqual(['mcp-extension'])
  })
  it('checks sampling and conflicting or route-specific reasoning without dropping parameters', () => {
    const value = configuration('pi')
    value.model.parameters = { reasoning: 'high', temperature: 0.2 }
    value.agent.engineOptions = { kind: 'pi', thinkingLevel: 'low' }
    expect(engineConfigurationIssues(value)[0]!.code).toBe('reasoning-conflict')
    value.agent.engineOptions = { kind: 'pi' }
    expect(engineConfigurationIssues(value)).toEqual([])
    setProtocol(value, 'gemini')
    expect(engineConfigurationIssues(value)[0]!.code).toBe('sampling')
    value.model.parameters = { reasoning: 'invented-level' }
    expect(engineConfigurationIssues(value)[0]!.code).toBe('thinking-level')
    const dsh = configuration('deepseek-harness')
    dsh.model.parameters = { temperature: 0.2, reasoning: 'high' }
    expect(engineConfigurationIssues(dsh).map((issue) => issue.code)).toEqual([
      'sampling',
      'reasoning',
    ])
    setProtocol(dsh, 'deepseek-official')
    dsh.model.parameters = { reasoning: 'max' }
    expect(engineConfigurationIssues(dsh)).toEqual([])
  })
  it('reports all DSH composition constraints together and identifies affected MCP/Prompt bindings', () => {
    const value = configuration('deepseek-harness')
    value.installation.prefixArgs = ['--patch', 'unmanaged']
    value.agent.engineOptions = {
      kind: 'deepseek-harness',
      profileTemplate: 'sdk',
      patchReload: 'startup',
    }
    setProtocol(value, 'deepseek-official')
    value.connection.headers = { 'User-Agent': 'PRIVATE_HEADER' }
    value.prompts[0]!.content = ''
    value.mcpServers = [
      {
        id: 'server',
        name: 'MCP',
        description: '',
        enabled: true,
        transport: 'streamable-http',
        url: 'https://example.invalid',
        headers: {},
        secretHeaders: {},
        auth: { kind: 'oauth', owner: 'engine', scopes: [] },
      },
    ]
    expect(engineConfigurationIssues(value).map((issue) => issue.code)).toEqual([
      'prefix-arguments',
      'native-options',
      'reserved-header',
      'native-headers',
      'empty-prompt',
      'mcp-authentication',
    ])
    expect(
      engineConfigurationIssues(value).find((issue) => issue.code === 'empty-prompt')?.resourceId,
    ).toBe('role')
    expect(
      engineConfigurationIssues(value).find((issue) => issue.code === 'mcp-authentication')
        ?.resourceId,
    ).toBe('server')
  })
  it.each(['opencode', 'deepseek-harness'] as const)(
    'rejects forced SSE and null command arguments for %s',
    (kind) => {
      const value = configuration(kind)
      value.mcpServers = [
        {
          id: 'legacy',
          name: 'MCP',
          description: '',
          enabled: true,
          transport: 'legacy-sse',
          url: 'https://example.invalid',
          headers: {},
          secretHeaders: {},
          auth: { kind: 'none' },
        },
      ]
      expect(engineConfigurationIssues(value)[0]!.code).toBe('mcp-transport')
      value.mcpServers = [
        {
          id: 'local',
          name: 'MCP',
          description: '',
          enabled: true,
          transport: 'stdio',
          command: 'node',
          args: ['bad\0arg'],
          cwd: '',
          environment: {},
          envRefs: {},
        },
      ]
      expect(engineConfigurationIssues(value)[0]!.code).toBe('command-value')
    },
  )
  it('requires runtime plugin checks and blocks pure mode without deleting the binding', async () => {
    const value = configuration()
    value.nativePlugins = [
      {
        id: 'plugin',
        name: 'Plugin',
        engineInstallationId: 'oc',
        nativeId: 'plugin',
        version: '1.0.0',
        source: 'installed',
        path: '/fixture/plugin',
      },
    ]
    const report = await describeConfigurationCapabilities(value)
    expect(report.eligibleForStartupChecks).toBe(true)
    expect(report.capabilities.find((row) => row.feature === 'plugins')).toMatchObject({
      requested: true,
      mechanism: 'adapter',
      availability: 'unknown',
    })
    expect(value.nativePlugins).toHaveLength(1)
    value.installation.prefixArgs = ['--pure']
    expect(engineConfigurationIssues(value)).toContainEqual({
      code: 'plugins-pure-mode',
      field: 'plugins',
      nativeFeature: 'nativePlugins.pure-mode',
    })
  })
})

describe('capability evidence identity', () => {
  it('binds descriptors to exact resolved inputs and host context, including model routes and credential references', async () => {
    const baseline = configuration(),
      first = await describeConfigurationCapabilities(baseline, 'darwin')
    const edits = [
      (value: ResolvedAgentConfiguration) => {
        value.installation.executable = '/other/executable'
      },
      (value: ResolvedAgentConfiguration) => {
        value.installation.version = 'next-version'
      },
      (value: ResolvedAgentConfiguration) => {
        value.connection.baseUrl = 'https://another.invalid'
      },
      (value: ResolvedAgentConfiguration) => {
        value.model.modelId = 'another-model'
      },
      (value: ResolvedAgentConfiguration) => {
        value.connection.auth = {
          kind: 'bearer',
          secret: { kind: 'environment', name: 'OTHER_KEY' },
        }
      },
      (value: ResolvedAgentConfiguration) => {
        value.prompts[0]!.content = 'Different input bytes'
      },
    ]
    for (const edit of edits) {
      const next = structuredClone(baseline)
      edit(next)
      expect((await describeConfigurationCapabilities(next, 'darwin')).profileDigest).not.toBe(
        first.profileDigest,
      )
    }
    expect((await describeConfigurationCapabilities(baseline, 'browser')).profileDigest).not.toBe(
      first.profileDigest,
    )
    expect((await describeConfigurationCapabilities(baseline, 'darwin')).profileDigest).toBe(
      first.profileDigest,
    )
    expect(first.route).toEqual({
      connectionId: 'local',
      protocol: 'openai-chat-completions',
      modelId: 'fixture-model',
    })
  })
  it('captures the input before asynchronous hashing and omits private values from descriptors', async () => {
    const value = configuration()
    value.connection.baseUrl = 'https://example.invalid/PRIVATE_ENDPOINT'
    value.connection.headers['X-Secret'] = 'PRIVATE_HEADER'
    value.prompts[0]!.content = 'PRIVATE_PROMPT'
    const original = structuredClone(value),
      pending = describeConfigurationCapabilities(value)
    value.model.modelId = 'changed-after-call'
    const report = await pending
    expect(report.profileDigest).toBe(
      (await describeConfigurationCapabilities(original)).profileDigest,
    )
    for (const text of [
      'PRIVATE_ENDPOINT',
      'PRIVATE_HEADER',
      'PRIVATE_PROMPT',
      'PROBE_KEY',
      '/fixture/agent',
    ])
      expect(JSON.stringify(report)).not.toContain(text)
  })
  it('never treats documentary evidence as runtime verification and localizes every reported reason', async () => {
    const report = await describeConfigurationCapabilities(configuration())
    const row = report.capabilities[0]!
    expect(
      isVerifiedCapability({ ...row, verification: 'passed', availability: 'ready' }, row),
    ).toBe(false)
    for (const locale of ['en', 'zh-CN'] as const)
      for (const capability of report.capabilities) {
        expect(Object.hasOwn(catalogs[locale], capability.reason)).toBe(true)
      }
  })
})
