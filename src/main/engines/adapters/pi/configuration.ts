import { createHash } from 'node:crypto'
import { realpath } from 'node:fs/promises'
import { join } from 'node:path'
import { parseDocument } from 'yaml'
import { z } from 'zod'
import { appError } from '../../../../shared/errors'
import type { SecretReference } from '../../../../shared/engines/schema'
import type {
  ResolvedAgentConfiguration,
  ResolvedSkill,
} from '../../../../shared/engines/resolution'
import type { GeneratedInputs, RunPaths } from '../../../../shared/engines/run-inputs'

export const piContract = { id: 'pi-rpc', version: '1', engineVersion: '0.85.1' } as const
export interface PiPlanContext {
  sources: GeneratedInputs['externalSources']
  readSkillEntry(skill: ResolvedSkill): Promise<string>
}
export const piApis = {
  'openai-chat-completions': 'openai-completions',
  'openai-responses': 'openai-responses',
  'anthropic-messages': 'anthropic-messages',
  gemini: 'google-generative-ai',
} as const
const unsupported = (feature: string): never => {
  throw appError('error.piConfiguration', { feature })
}
const skillMetadata = z.object({
  name: z
    .string()
    .min(1)
    .max(64)
    .regex(/^[a-z0-9]+(-[a-z0-9]+)*$/),
  description: z.string().trim().min(1).max(1024),
})
function skillName(content: string): string | null {
  if (!content.startsWith('---')) return null
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(content.slice(0, 65_536))
  if (!match) return unsupported('skill.frontmatter')
  try {
    const parsed = parseDocument(match[1]!, {
      uniqueKeys: true,
      stringKeys: true,
      prettyErrors: false,
    })
    if (parsed.errors.length || parsed.warnings.length) return unsupported('skill.frontmatter')
    return skillMetadata.parse(parsed.toJS({ maxAliasCount: 0 })).name
  } catch {
    return unsupported('skill.frontmatter')
  }
}
/** Pi templates interpret !commands and $variables. Ordinary values must remain literal. */
export function piLiteral(value: string): string {
  const escaped = value.replaceAll('$', () => '$$')
  return escaped.startsWith('!') ? `$${escaped}` : escaped
}
export function piThinking(
  configuration: Pick<ResolvedAgentConfiguration, 'agent' | 'model'>,
): string {
  const engine = configuration.agent.engineOptions
  const requested = engine?.kind === 'pi' ? engine.thinkingLevel : undefined
  const shared = configuration.model.parameters.reasoning
  if (requested && shared && requested !== shared) return unsupported('model.reasoning-conflict')
  const selected = requested || shared || 'off'
  if (!['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'].includes(selected))
    return unsupported('model.thinkingLevel')
  return selected
}

/** Produce immutable inputs; the separate launcher verifies native state before using them. */
export async function planPi(
  configuration: ResolvedAgentConfiguration,
  paths: RunPaths,
  context: PiPlanContext,
): Promise<GeneratedInputs> {
  const { installation, agent, connection, model } = configuration
  if (
    installation.kind !== 'pi' ||
    installation.version !== piContract.engineVersion ||
    !installation.modes.includes('pi-rpc')
  )
    return unsupported('installation.version')
  if (agent.engineOptions && agent.engineOptions.kind !== 'pi') return unsupported('engineOptions')
  if (configuration.mcpServers.length) return unsupported('mcp.extension-required')
  if (configuration.nativePlugins.length) return unsupported('nativePlugins.activation')
  if (agent.execution.approval === 'ask') return unsupported('execution.universal-approval')
  if (
    !connection.protocol ||
    !(connection.protocol in piApis) ||
    !connection.baseUrl ||
    !model.modelId
  )
    return unsupported('connection.protocol')
  const api = piApis[connection.protocol as keyof typeof piApis]
  const auth = connection.auth
  if (!(
    (['openai-completions', 'openai-responses'].includes(api) && auth.kind === 'bearer') ||
    (auth.kind === 'api-key' &&
      ((api === 'anthropic-messages' && auth.header.toLowerCase() === 'x-api-key') ||
        (api === 'google-generative-ai' && auth.header.toLowerCase() === 'x-goog-api-key')))
  ))
    return unsupported(`connection.auth:${connection.protocol}/${auth.kind}`)
  if (auth.kind !== 'bearer' && auth.kind !== 'api-key') return unsupported('connection.auth')
  const hasSampling =
    model.parameters.temperature !== undefined || model.parameters.topP !== undefined
  if (hasSampling && !['openai-completions', 'openai-responses'].includes(api))
    return unsupported('model.sampling-for-api')
  const thinking = piThinking(configuration)
  const providerId = `agentmatrix-${connection.id}`
  const projectTrust = agent.engineOptions?.projectTrust ?? 'deny'
  const contextFiles = agent.engineOptions?.contextFiles ?? 'inherit'
  const generated: GeneratedInputs = {
    adapter: { id: piContract.id, version: piContract.version },
    launch: {
      mode: 'pi-rpc',
      args: [
        ...installation.prefixArgs,
        '--mode',
        'rpc',
        '--offline',
        '--no-extensions',
        '--no-skills',
        '--no-prompt-templates',
        '--no-themes',
        projectTrust === 'trust-once' ? '--approve' : '--no-approve',
        '--provider',
        providerId,
        '--model',
        model.modelId,
        '--thinking',
        thinking,
        '--session-dir',
        join(paths.state, 'sessions'),
        ...(contextFiles === 'ignore' ? ['--no-context-files'] : []),
        ...(agent.execution.approval === 'deny' ? ['--no-tools'] : []),
      ],
      environment: {
        PI_CODING_AGENT_DIR: { kind: 'state-directory', path: 'pi' },
        PI_CODING_AGENT_SESSION_DIR: { kind: 'state-directory', path: 'sessions' },
        TMPDIR: { kind: 'state-directory', path: 'tmp' },
        TMP: { kind: 'state-directory', path: 'tmp' },
        TEMP: { kind: 'state-directory', path: 'tmp' },
      },
    },
    files: [],
    promptPaths: {},
    skillPaths: {},
    externalSources: context.sources,
  }
  let secretIndex = 0
  const secret = (reference: SecretReference | null) => {
    if (!reference) return unsupported('secret.reference')
    const name = `AGENT_MATRIX_SECRET_${++secretIndex}`
    generated.launch.environment[name] = { kind: 'secret', reference, encoding: 'raw' }
    return `$${name}`
  }
  const apiKey = secret(auth.secret)
  const headers = Object.fromEntries(
    Object.entries(connection.headers).map(([name, value]) => [name, piLiteral(value)]),
  )
  for (const [name, reference] of Object.entries(connection.secretHeaders))
    headers[name] = secret(reference)
  const nativeModel = {
    id: model.modelId,
    name: model.name,
    reasoning: thinking !== 'off',
    input: ['text'],
    ...(hasSampling
      ? {
          samplingParams: {
            temperature: model.parameters.temperature,
            top_p: model.parameters.topP,
          },
        }
      : {}),
  }
  const models = {
    providers: {
      [providerId]: { api, baseUrl: connection.baseUrl, apiKey, headers, models: [nativeModel] },
    },
  }
  const settings = {
    defaultProvider: providerId,
    defaultModel: model.modelId,
    defaultThinkingLevel: thinking,
    compaction: { enabled: false },
    retry: { enabled: false },
    enableSkillCommands: true,
  }
  for (const [name, value] of Object.entries({
    'models.json': models,
    'settings.json': settings,
    'auth.json': {},
    'trust.json': { version: 1, decisions: {} },
  }))
    generated.files.push({
      path: `pi-home/${name}`,
      content: JSON.stringify(value, null, 2) + '\n',
    })

  // Explicit append flags suppress Pi's APPEND_SYSTEM.md discovery. Preserve a trusted project append first.
  const projectAppend = join(await realpath(agent.execution.cwd), '.pi', 'APPEND_SYSTEM.md')
  if (
    configuration.prompts.some((prompt) => prompt.mode !== 'replace') &&
    projectTrust === 'trust-once' &&
    context.sources.files.some((file) => file.path === projectAppend && file.exists)
  )
    generated.launch.args.push('--append-system-prompt', projectAppend)
  let replacement = false
  for (const prompt of configuration.prompts) {
    const path = `prompts/${prompt.assetId}.md`
    generated.promptPaths[prompt.assetId] = path
    if (!prompt.content.trim()) return unsupported('prompts.empty')
    if (prompt.mode === 'replace') {
      if (replacement) return unsupported('prompts.replace')
      replacement = true
    }
    generated.launch.args.push(
      prompt.mode === 'replace' ? '--system-prompt' : '--append-system-prompt',
      join(paths.inputs, path),
    )
  }
  const names = new Set<string>()
  const skills = []
  for (const skill of configuration.skills) {
    const content =
      skill.revision.kind === 'markdown'
        ? skill.revision.content
        : await context.readSkillEntry(skill)
    const named = skillName(content)
    if (!named && skill.revision.kind === 'directory') return unsupported('skill.frontmatter')
    const name =
      named ?? `skill-${createHash('sha256').update(skill.assetId).digest('hex').slice(0, 16)}`
    if (names.has(name)) return unsupported(`skill.duplicate:${name}`)
    names.add(name)
    const path = `skills/${name}`
    generated.skillPaths[skill.assetId] = named ? path : `sources/skills/${skill.assetId}`
    if (!named)
      generated.files.push({
        path: `${path}/SKILL.md`,
        content: `---\nname: ${name}\ndescription: ${JSON.stringify(skill.name)}\n---\n\n${content}`,
      })
    // Select the entry directly so ignore files or nested Skill directories cannot alter the chosen set.
    generated.launch.args.push('--skill', join(paths.inputs, path, 'SKILL.md'))
    skills.push({ assetId: skill.assetId, name, path, wrapped: !named })
  }
  generated.files.push({
    path: 'pi-mappings.json',
    content:
      JSON.stringify(
        {
          providerId,
          api,
          modelId: model.modelId,
          thinking,
          projectTrust,
          contextFiles,
          tools: agent.execution.approval === 'deny' ? 'none' : 'native',
          skills,
          promptSemantics:
            'Replacement changes the core prompt; Pi still adds append instructions, enabled context, Skills, and cwd.',
        },
        null,
        2,
      ) + '\n',
  })
  return generated
}
