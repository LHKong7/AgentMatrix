import { piApis as apis } from '../../../../shared/engines/contracts'
import { planDshPlugins } from './plugins'
import { assertEngineConfiguration } from '../../../../shared/engines/validation'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { parseDocument } from 'yaml'
import { z } from 'zod'
import type {
  ResolvedAgentConfiguration,
  ResolvedSkill,
} from '../../../../shared/engines/resolution'
import type { GeneratedInputs, RunPaths } from '../../../../shared/engines/run-inputs'
import type { SecretReference } from '../../../../shared/engines/schema'
import {
  dshContract,
  DshExpression,
  dshUnsupported,
  writeDshYaml,
  type DshComposition,
  type DshRow,
} from './composition'

export interface DshPlanContext {
  composition: DshComposition
  readSkillEntry(skill: ResolvedSkill): Promise<string>
}
/** Application-owned component; prompt bytes are variable values, never JavaScript or native templates. */
const bridge = `exports.name = 'agentmatrix-managed';
exports.inject = ['systemPrompt', 'tools'];
exports.apply = async (ctx, config) => {
  ctx.systemPrompt.variable('agentmatrix_append', () => config.append);
  if (config.complete !== null) {
    ctx.systemPrompt.variable('agentmatrix_complete', () => config.complete);
    ctx.systemPrompt.section({ name: 'agentmatrix:complete', order: 0, complete: true, text: '{{agentmatrix_complete}}' });
  }
  if (config.approval === 'deny') ctx.tools.guard(() => 'Tool execution is disabled by the AgentMatrix profile.');
  if (config.approval === 'ask') ctx.on('tools/pre-execute', async (_exec, next) => {
    const decision = await next();
    return decision.kind === 'deny' ? decision : { kind: 'ask', reason: 'The AgentMatrix profile requires approval for this tool call.' };
  });
};
`
function nativeSkillName(text: string): string | null {
  if (!text.startsWith('---')) return null
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(text.slice(0, 65_536))
  if (!match) return dshUnsupported('skill.frontmatter')
  const doc = parseDocument(match[1]!, { uniqueKeys: true, stringKeys: true })
  if (doc.errors.length || doc.warnings.length) return dshUnsupported('skill.frontmatter')
  const value = z
    .object({
      name: z
        .string()
        .regex(/^[a-z0-9]+(-[a-z0-9]+)*$/)
        .max(64),
      description: z.string().trim().min(1).max(1024),
    })
    .safeParse(doc.toJS({ maxAliasCount: 0 }))
  return value.success ? value.data.name : dshUnsupported('skill.frontmatter')
}

export async function planDsh(
  configuration: ResolvedAgentConfiguration,
  paths: RunPaths,
  context: DshPlanContext,
): Promise<GeneratedInputs> {
  assertEngineConfiguration(configuration, { expectedEngine: 'deepseek-harness' })
  const { agent, model, connection } = configuration
  const native = connection.protocol === 'deepseek-official'
  if (
    [...Object.keys(connection.headers), ...Object.keys(connection.secretHeaders)].some(
      (name) => name.toLowerCase() === 'user-agent',
    )
  )
    return dshUnsupported('connection.reserved-header')
  if (
    !connection.protocol ||
    (!native && !(connection.protocol in apis)) ||
    !connection.baseUrl ||
    !model.modelId
  )
    return dshUnsupported('connection.protocol')
  const auth = connection.auth
  if (
    !(auth.kind === 'bearer' && (native || connection.protocol.startsWith('openai-'))) &&
    !(
      auth.kind === 'api-key' &&
      ((connection.protocol === 'anthropic-messages' &&
        auth.header.toLowerCase() === 'x-api-key') ||
        (connection.protocol === 'gemini' && auth.header.toLowerCase() === 'x-goog-api-key'))
    )
  )
    return dshUnsupported('connection.auth')
  if (auth.kind !== 'bearer' && auth.kind !== 'api-key') return dshUnsupported('connection.auth')
  if (
    native &&
    (Object.keys(connection.headers).length || Object.keys(connection.secretHeaders).length)
  )
    return dshUnsupported('connection.native-headers')
  const reasoning = model.parameters.reasoning ?? 'off'
  if (!['off', ...(native ? ['low', 'high', 'max'] : [])].includes(reasoning))
    return dshUnsupported('model.reasoning')
  const generated: GeneratedInputs = {
    adapter: { id: dshContract.id, version: dshContract.version },
    launch: {
      mode: 'acp',
      args: ['--profile', 'agentmatrix'],
      environment: {
        DSH_HOME: { kind: 'state-directory', path: 'dsh' },
        DSH_TELEMETRY_DISABLED: { kind: 'literal', value: '1' },
        DSH_PERMISSION_MODE: {
          kind: 'literal',
          value:
            agent.execution.approval === 'unrestricted' ? 'danger-full-access' : 'workspace-write',
        },
        TMPDIR: { kind: 'state-directory', path: 'tmp' },
        TMP: { kind: 'state-directory', path: 'tmp' },
        TEMP: { kind: 'state-directory', path: 'tmp' },
      },
    },
    files: [],
    promptPaths: {},
    skillPaths: {},
    externalSources: structuredClone(context.composition.sources),
  }
  let index = 0
  const secretName = (reference: SecretReference | null) => {
    if (!reference) return dshUnsupported('secret.reference')
    const name = `AGENT_MATRIX_SECRET_${++index}`
    generated.launch.environment[name] = { kind: 'secret', reference, encoding: 'raw' }
    return name
  }
  const secret = (reference: SecretReference | null, prefix = '') =>
    new DshExpression(
      `${JSON.stringify(prefix)} + process.env[${JSON.stringify(secretName(reference))}]`,
    )
  const provider = native ? 'deepseek-official' : `agentmatrix-${connection.id}`
  const key = secretName(auth.secret)
  const api = native ? 'openai-completions' : apis[connection.protocol as keyof typeof apis]
  const rows: DshRow[] = context.composition.rows.map((row) => ({
    ...row,
    name: pathToFileURL(
      context.composition.entries[row.name!] ?? dshUnsupported('composition.entry'),
    ).href,
  }))
  const set = (id: string, patch: Record<string, unknown>) => {
    const row = rows.find((value) => value.id === id)
    if (!row || !row.name) return dshUnsupported(`composition.row:${id}`)
    Object.assign(row, patch)
  }
  set('acp', { config: { provider, model: model.modelId } })
  set('agent-default-model', { config: { provider, model: model.modelId } })
  const providerConfig = {
    apiKeyEnv: key,
    baseURL: connection.baseUrl,
    models: [{ id: model.modelId }],
    retryPolicy: { mode: 'normal', maxRetries: 0 },
  }
  const headers: Record<string, unknown> = { ...connection.headers }
  for (const [name, reference] of Object.entries(connection.secretHeaders))
    headers[name] = secret(reference)
  set('llm-deepseek', {
    disabled: !native,
    ...(native
      ? {
          config: {
            ...providerConfig,
            thinking: reasoning === 'off' ? 'disabled' : 'enabled',
            reasoningEffort: reasoning,
          },
        }
      : {}),
  })
  set('llm-pi-ai', {
    disabled: native,
    ...(!native
      ? {
          config: {
            providers: { [provider]: { ...providerConfig, api, headers, reasoning: 'off' } },
          },
        }
      : {}),
  })
  set('settings', { config: { path: join(paths.inputs, 'control/settings.json'), watch: false } })
  set('credentials', {
    config: { path: join(paths.inputs, 'control/credentials.yaml'), watch: false },
  })
  set('session-telemetry-otel', { disabled: true })
  set('hmr', { disabled: true })
  set('sandbox-policy', {
    config: {
      mode: agent.execution.approval === 'unrestricted' ? 'danger-full-access' : 'workspace-write',
      workspaceRoot: agent.execution.cwd,
    },
  })
  set('approval', { config: { policy: agent.execution.approval === 'ask' ? 'ask' : 'never' } })
  set('permission', {
    config: {
      presets: {
        [`agentmatrix-${agent.execution.approval}`]: {
          sandbox:
            agent.execution.approval === 'unrestricted' ? 'danger-full-access' : 'workspace-write',
          approval: agent.execution.approval === 'ask' ? 'ask' : 'never',
          name: `AgentMatrix: ${agent.execution.approval}`,
        },
      },
    },
  })
  const replacement = configuration.prompts.filter((prompt) => prompt.mode === 'replace')
  if (replacement.length > 1) return dshUnsupported('prompts.replace')
  const append: string[] = []
  for (const prompt of configuration.prompts) {
    if (!prompt.content.trim()) return dshUnsupported('prompts.empty')
    generated.promptPaths[prompt.assetId] = `prompts/${prompt.assetId}.md`
    if (prompt.mode !== 'replace')
      append.push(
        prompt.mode === 'project-rule'
          ? `Project instructions for ${agent.execution.cwd}:\n${prompt.content}`
          : prompt.content,
      )
  }
  const suffix = append.join('\n\n')
  const appendPosition =
    agent.engineOptions?.kind === 'deepseek-harness'
      ? (agent.engineOptions.appendPosition ?? 'suffix')
      : 'suffix'
  const complete = replacement.length
    ? (appendPosition === 'prefix'
        ? [suffix, replacement[0]!.content]
        : [replacement[0]!.content, suffix]
      )
        .filter(Boolean)
        .join('\n\n')
    : null
  set('system-prompt', {
    config: {
      includeHarnessIdentity: true,
      includeRuntimeContext: true,
      personaPrefix:
        'You are a coding agent powered by the {{model}} model.' +
        (appendPosition === 'prefix' ? '\n\n{{agentmatrix_append}}' : ''),
      personaSuffix:
        'Your working directory is {{cwd}}.' +
        (appendPosition === 'suffix' ? '\n\n{{agentmatrix_append}}' : ''),
    },
  })
  rows.push({
    id: 'agentmatrix-managed',
    name: pathToFileURL(join(paths.inputs, 'managed.cjs')).href,
    config: { append: suffix, complete, approval: agent.execution.approval },
  })
  const names = new Set<string>(),
    skills = []
  for (const skill of configuration.skills) {
    const text =
      skill.revision.kind === 'markdown'
        ? skill.revision.content
        : await context.readSkillEntry(skill)
    const named = nativeSkillName(text)
    if (!named && skill.revision.kind === 'directory') return dshUnsupported('skill.frontmatter')
    const name =
      named ?? `skill-${createHash('sha256').update(skill.assetId).digest('hex').slice(0, 16)}`
    if (names.has(name)) return dshUnsupported('skill.duplicate')
    names.add(name)
    const path = `skills/${name}`
    generated.skillPaths[skill.assetId] = named ? path : `sources/skills/${skill.assetId}`
    if (!named)
      generated.files.push({
        path: `${path}/SKILL.md`,
        content: `---\nname: ${name}\ndescription: ${JSON.stringify(skill.name)}\n---\n\n${text}`,
      })
    skills.push({ assetId: skill.assetId, name, path })
  }
  set('skill-filesystem', {
    config: {
      includeDefaultRoots: false,
      customSkillDirs: skills.length ? [join(paths.inputs, 'skills')] : [],
      watch: false,
    },
  })
  const mcpMappings = []
  for (const server of configuration.mcpServers) {
    const serverName = `am-${createHash('sha256').update(server.id).digest('hex').slice(0, 20)}`
    const common = {
      serverName,
      toolCallTimeoutMs: server.timeoutMs ?? 60_000,
      failOnStartupError: true,
      reconnect: { enabled: false },
    }
    let config: Record<string, unknown>
    if (server.transport === 'stdio') {
      const env: Record<string, unknown> = { ...server.environment }
      for (const [name, reference] of Object.entries(server.envRefs)) env[name] = secret(reference)
      config = {
        ...common,
        transport: 'stdio',
        command: server.command,
        args: server.args,
        cwd: server.cwd || agent.execution.cwd,
        env,
      }
    } else if (server.transport === 'streamable-http' && server.auth.kind !== 'oauth') {
      const headers: Record<string, unknown> = { ...server.headers }
      for (const [name, reference] of Object.entries(server.secretHeaders))
        headers[name] = secret(reference)
      if (server.auth.kind === 'bearer')
        headers.Authorization = secret(server.auth.secret, 'Bearer ')
      config = { ...common, transport: 'streamable-http', url: server.url, headers }
    } else return dshUnsupported('mcp.transport-or-auth')
    rows.push({
      id: `agentmatrix-mcp-${serverName}`,
      name: pathToFileURL(
        context.composition.entries['@deepseek-ai/dsh-mcp-client'] ??
          dshUnsupported('composition.mcp'),
      ).href,
      config,
    })
    mcpMappings.push({ id: server.id, serverName, transport: server.transport })
  }
  await planDshPlugins(configuration, paths, generated, rows)
  generated.files.push(
    {
      path: 'profile/package.json',
      content:
        JSON.stringify(
          {
            name: 'agentmatrix-dsh-profile',
            private: true,
            dependencies: {},
            dsh: { profile: { bundles: [], patchReload: 'startup' } },
          },
          null,
          2,
        ) + '\n',
    },
    { path: 'profile/cordis.patch.yml', content: writeDshYaml([{ insert: rows }]) },
    { path: 'control/settings.json', content: '{}\n' },
    { path: 'control/credentials.yaml', content: 'version: 1\nrefs: {}\nrecords: {}\n' },
    { path: 'managed.cjs', content: bridge },
    {
      path: 'dsh-mappings.json',
      content:
        JSON.stringify(
          {
            provider,
            api,
            model: model.modelId,
            promptMode: complete === null ? `persona-${appendPosition}` : 'complete',
            appendPosition,
            skills,
            mcpServers: mcpMappings,
            components: context.composition.components,
            modelCapacity: 'native defaults; unverified',
            pricing: 'unknown',
          },
          null,
          2,
        ) + '\n',
    },
  )
  return generated
}
