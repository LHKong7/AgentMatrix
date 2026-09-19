import { engineContracts, openCodeProviders } from '../../../../shared/engines/contracts'
import { assertEngineConfiguration } from '../../../../shared/engines/validation'
import { createHash } from 'node:crypto'
import { isAbsolute, join } from 'node:path'
import { parseDocument } from 'yaml'
import { z } from 'zod'
import { appError } from '../../../../shared/errors'
import { planOpenCodePlugins } from './plugins'
import { planOpenCodeSkillObservation } from './skills'
import type { SecretReference } from '../../../../shared/engines/schema'
import type {
  ResolvedAgentConfiguration,
  ResolvedSkill,
} from '../../../../shared/engines/resolution'
import type { GeneratedInputs, RunPaths } from '../../../../shared/engines/run-inputs'

export const openCodeContract = engineContracts.opencode
export interface OpenCodePlanContext {
  configHome: string
  sources: GeneratedInputs['externalSources']
  readSkillEntry(skill: ResolvedSkill): Promise<string>
}
class NativeExpression {
  constructor(readonly value: string) {}
}
type NativeValue =
  | string
  | number
  | boolean
  | null
  | undefined
  | NativeExpression
  | NativeValue[]
  | { [key: string]: NativeValue }

// OpenCode expands macros before parsing JSON. Only adapter-created expressions may expand.
function nativeJson(value: NativeValue): string {
  if (value instanceof NativeExpression) return JSON.stringify(value.value)
  if (typeof value === 'string') return JSON.stringify(value).replaceAll('{', '\\u007b')
  if (Array.isArray(value)) return `[${value.map(nativeJson).join(',')}]`
  if (value !== null && typeof value === 'object')
    return `{${Object.entries(value)
      .filter(([, item]) => item !== undefined)
      .map(([key, item]) => `${JSON.stringify(key)}:${nativeJson(item)}`)
      .join(',')}}`
  return JSON.stringify(value)
}
const unsupported = (feature: string): never => {
  throw appError('error.openCodeConfiguration', { feature })
}
const skillMetadata = z.object({
  name: z
    .string()
    .min(1)
    .max(64)
    .regex(/^[a-z0-9]+(-[a-z0-9]+)*$/),
  description: z.string().min(1).max(1024),
})
function skillName(content: string): string | null {
  if (!content.startsWith('---')) return null
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(content.slice(0, 65_536))
  if (!match) return unsupported('skill.frontmatter')
  try {
    const document = parseDocument(match[1]!, {
      prettyErrors: false,
      uniqueKeys: true,
      stringKeys: true,
    })
    if (document.errors.length || document.warnings.length) return unsupported('skill.frontmatter')
    return skillMetadata.parse(document.toJS({ maxAliasCount: 0 })).name
  } catch {
    return unsupported('skill.frontmatter')
  }
}
function markdownSkillName(id: string): string {
  const prefix =
    id
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '')
      .slice(0, 45)
      .replace(/-$/g, '') || 'skill'
  return `${prefix}-${createHash('sha256').update(id).digest('hex').slice(0, 10)}`
}

/** Plans native files only. Source/readback checks and a runtime handshake still gate execution. */
export async function planOpenCode(
  configuration: ResolvedAgentConfiguration,
  paths: RunPaths,
  context: OpenCodePlanContext,
): Promise<GeneratedInputs> {
  assertEngineConfiguration(configuration, { expectedEngine: 'opencode' })
  const { installation, agent, connection, model } = configuration
  if (!isAbsolute(context.configHome)) return unsupported('native.configHome')
  if (agent.engineOptions && agent.engineOptions.kind !== 'opencode')
    return unsupported('engineOptions')
  const protocol = connection.protocol
  const npm =
    protocol && Object.hasOwn(openCodeProviders, protocol)
      ? openCodeProviders[protocol as keyof typeof openCodeProviders]
      : null
  if (!npm || !connection.baseUrl || !model.modelId)
    return unsupported(`connection.protocol:${protocol}`)
  const providerId = `agentmatrix-${connection.id}`
  const modelRoute = `${providerId}/selected`
  const agentName = agent.engineOptions?.agent ?? 'build'
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,99}$/.test(agentName)) return unsupported('engineOptions.agent')
  const generated: GeneratedInputs = {
    adapter: { id: openCodeContract.id, version: openCodeContract.version },
    launch: {
      mode: 'acp',
      args: [...installation.prefixArgs, 'acp'],
      environment: {
        OPENCODE_CONFIG: { kind: 'input-file', path: 'opencode.json' },
        OPENCODE_DISABLE_AUTOUPDATE: { kind: 'literal', value: 'true' },
        XDG_CONFIG_HOME: { kind: 'literal', value: context.configHome },
        XDG_DATA_HOME: { kind: 'state-directory', path: 'data' },
        XDG_CACHE_HOME: { kind: 'state-directory', path: 'cache' },
        XDG_STATE_HOME: { kind: 'state-directory', path: 'native' },
        TMPDIR: { kind: 'state-directory', path: 'tmp' },
        TMP: { kind: 'state-directory', path: 'tmp' },
        TEMP: { kind: 'state-directory', path: 'tmp' },
      },
    },
    promptPaths: {},
    skillPaths: {},
    files: [],
    externalSources: structuredClone(context.sources),
  }
  let secretIndex = 0
  const secret = (reference: SecretReference | null, prefix = ''): NativeExpression => {
    if (!reference) return unsupported('secret.reference')
    const name = `AGENT_MATRIX_SECRET_${++secretIndex}`
    generated.launch.environment[name] = { kind: 'secret', reference, encoding: 'json-string' }
    return new NativeExpression(`${prefix}{env:${name}}`)
  }
  const headers = (
    ordinary: Record<string, string>,
    references: Record<string, SecretReference>,
  ): Record<string, NativeValue> => {
    if (Object.values(ordinary).some((value) => /[\r\n\0]/.test(value)))
      return unsupported('headers.value')
    return {
      ...ordinary,
      ...Object.fromEntries(
        Object.entries(references).map(([name, reference]) => [name, secret(reference)]),
      ),
    }
  }
  const providerHeaders = headers(connection.headers, connection.secretHeaders)
  let apiKey: NativeExpression | undefined
  const auth = connection.auth
  if (protocol === 'openai-chat-completions') {
    if (auth.kind === 'bearer') apiKey = secret(auth.secret)
    else if (auth.kind === 'api-key') providerHeaders[auth.header] = secret(auth.secret)
    else if (auth.kind !== 'none') return unsupported(`connection.auth:${auth.kind}`)
  } else if (protocol === 'openai-responses' && auth.kind === 'bearer') apiKey = secret(auth.secret)
  else if (
    auth.kind === 'api-key' &&
    ((protocol === 'anthropic-messages' && auth.header.toLowerCase() === 'x-api-key') ||
      (protocol === 'gemini' && auth.header.toLowerCase() === 'x-goog-api-key'))
  )
    apiKey = secret(auth.secret)
  else return unsupported(`connection.auth:${protocol}/${auth.kind}`)

  const nativeAgent: Record<string, NativeValue> = {
    model: modelRoute,
    mode: 'primary',
    permission: agent.execution.approval === 'unrestricted' ? 'allow' : agent.execution.approval,
    temperature: model.parameters.temperature,
    top_p: model.parameters.topP,
  }
  const instructions: string[] = []
  for (const prompt of configuration.prompts) {
    const path = `prompts/${prompt.assetId}.md`
    generated.promptPaths[prompt.assetId] = path
    if (prompt.mode === 'replace') {
      if (nativeAgent.prompt !== undefined || !prompt.content.trim())
        return unsupported('prompts.replace')
      nativeAgent.prompt = new NativeExpression(`{file:./${path}}`)
    } else instructions.push(join(paths.inputs, path))
  }
  const names = new Set<string>()
  const skillMappings: { assetId: string; name: string; path: string; wrapped: boolean }[] = []
  for (const skill of configuration.skills) {
    const content =
      skill.revision.kind === 'markdown'
        ? skill.revision.content
        : await context.readSkillEntry(skill)
    const named = skillName(content)
    if (!named && skill.revision.kind === 'directory') return unsupported('skill.frontmatter')
    const name = named ?? markdownSkillName(skill.assetId)
    if (names.has(name)) return unsupported(`skill.duplicate:${name}`)
    names.add(name)
    const nativePath = `skills/${name}`
    generated.skillPaths[skill.assetId] = named ? nativePath : `sources/skills/${skill.assetId}`
    if (!named)
      generated.files.push({
        path: `${nativePath}/SKILL.md`,
        content: `---\nname: ${name}\ndescription: ${JSON.stringify(skill.name)}\n---\n\n${content}`,
      })
    skillMappings.push({ assetId: skill.assetId, name, path: nativePath, wrapped: !named })
  }
  const mcp: Record<string, NativeValue> = {}
  for (const server of configuration.mcpServers) {
    if (server.transport === 'stdio') {
      if (
        [server.command, ...server.args, ...Object.values(server.environment)].some((value) =>
          value.includes('\0'),
        )
      )
        return unsupported('mcp.command')
      mcp[`agentmatrix-${server.id}`] = {
        type: 'local',
        command: [server.command, ...server.args],
        cwd: server.cwd || undefined,
        enabled: true,
        timeout: server.timeoutMs,
        environment: {
          ...server.environment,
          ...Object.fromEntries(
            Object.entries(server.envRefs).map(([name, reference]) => [name, secret(reference)]),
          ),
        },
      }
    } else {
      if (server.transport === 'legacy-sse') return unsupported('mcp.forced-sse')
      const remoteHeaders = headers(server.headers, server.secretHeaders)
      if (server.auth.kind === 'bearer')
        remoteHeaders.Authorization = secret(server.auth.secret, 'Bearer ')
      mcp[`agentmatrix-${server.id}`] = {
        type: 'remote',
        url: server.url,
        enabled: true,
        headers: remoteHeaders,
        timeout: server.timeoutMs,
        oauth:
          server.auth.kind === 'oauth'
            ? { scope: server.auth.scopes.join(' ') || undefined }
            : false,
      }
    }
  }
  planOpenCodeSkillObservation(
    skillMappings.map((skill) => skill.name),
    agentName,
    generated,
  )
  const plugins = await planOpenCodePlugins(configuration, paths, generated, agentName)
  const native = {
    $schema: 'https://opencode.ai/config.json',
    autoupdate: false,
    share: 'disabled',
    model: modelRoute,
    small_model: modelRoute,
    default_agent: agentName,
    plugin: plugins.length ? plugins : undefined,
    provider: {
      [providerId]: {
        name: connection.name,
        npm,
        options: { baseURL: connection.baseUrl, apiKey, headers: providerHeaders },
        models: {
          selected: {
            id: model.modelId,
            name: model.name,
            temperature: model.parameters.temperature === undefined ? undefined : true,
          },
        },
      },
    },
    agent: { [agentName]: nativeAgent },
    instructions,
    skills: configuration.skills.length ? { paths: [join(paths.inputs, 'skills')] } : undefined,
    mcp,
  }
  generated.files.push(
    { path: 'opencode.json', content: nativeJson(native) + '\n' },
    {
      path: 'opencode-mappings.json',
      content:
        JSON.stringify({ providerId, modelRoute, agentName, skills: skillMappings }, null, 2) +
        '\n',
    },
  )
  return generated
}
