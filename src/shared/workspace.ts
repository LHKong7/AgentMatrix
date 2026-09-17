import { z } from 'zod'

const id = z.string().regex(/^[a-zA-Z0-9_-]{1,100}$/, 'ID 只能包含字母、数字、下划线和连字符')
const name = z.string().trim().min(1, '名称不能为空').max(80)
const description = z.string().max(500)
const ids = z
  .array(id)
  .max(200)
  .refine((items) => new Set(items).size === items.length, '引用不能重复')
const httpUrl = z.url().refine((value) => /^https?:\/\//.test(value), '仅支持 HTTP / HTTPS 地址')

export const agentSchema = z
  .object({
    id,
    name,
    description,
    enabled: z.boolean(),
    provider: z.enum(['openai-compatible', 'anthropic', 'ollama']),
    model: z.string().trim().max(100),
    baseUrl: z.union([z.literal(''), httpUrl]),
    systemPrompt: z.string().max(100_000),
    temperature: z.number().min(0).max(2),
    mcpServerIds: ids,
    skillIds: ids,
    pluginIds: ids,
  })
  .strict()

const resourceFields = { id, name, description, enabled: z.boolean() }

export const mcpServerSchema = z.discriminatedUnion('transport', [
  z
    .object({
      ...resourceFields,
      transport: z.literal('stdio'),
      command: z.string().trim().min(1).max(1000),
      args: z.array(z.string().max(4000)).max(100),
      // Values name environment variables; credentials are not stored in this workspace.
      envRefs: z.record(
        z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/),
        z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/),
      ),
    })
    .strict(),
  z
    .object({
      ...resourceFields,
      transport: z.literal('streamable-http'),
      url: httpUrl,
      bearerTokenEnv: z.string().regex(/^$|^[A-Za-z_][A-Za-z0-9_]*$/),
    })
    .strict(),
])

export const skillSchema = z
  .object({
    ...resourceFields,
    instructions: z.string().min(1, '请填写 Skill 指令').max(100_000),
    sourcePath: z.string().max(2000),
  })
  .strict()

export const pluginSchema = z
  .object({
    ...resourceFields,
    version: z.string().regex(/^\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?$/, '版本格式应为 1.0.0'),
    mcpServerIds: ids,
    skillIds: ids,
  })
  .strict()

export const workspaceSchema = z
  .object({
    schemaVersion: z.literal(1),
    revision: z.number().int().nonnegative(),
    agents: z.array(agentSchema).max(200),
    mcpServers: z.array(mcpServerSchema).max(200),
    skills: z.array(skillSchema).max(200),
    plugins: z.array(pluginSchema).max(200),
  })
  .strict()
  .superRefine((workspace, ctx) => {
    for (const key of ['agents', 'mcpServers', 'skills', 'plugins'] as const) {
      const allIds = workspace[key].map((entry) => entry.id)
      if (new Set(allIds).size !== allIds.length) {
        ctx.addIssue({ code: 'custom', path: [key], message: 'ID 不能重复' })
      }
    }
    const checkRefs = (refs: string[], available: { id: string }[], path: (string | number)[]) => {
      if (refs.some((ref) => !available.some((entry) => entry.id === ref))) {
        ctx.addIssue({ code: 'custom', path, message: '引用的资源不存在' })
      }
    }
    workspace.agents.forEach((agent, index) => {
      checkRefs(agent.mcpServerIds, workspace.mcpServers, ['agents', index, 'mcpServerIds'])
      checkRefs(agent.skillIds, workspace.skills, ['agents', index, 'skillIds'])
      checkRefs(agent.pluginIds, workspace.plugins, ['agents', index, 'pluginIds'])
    })
    workspace.plugins.forEach((plugin, index) => {
      checkRefs(plugin.mcpServerIds, workspace.mcpServers, ['plugins', index, 'mcpServerIds'])
      checkRefs(plugin.skillIds, workspace.skills, ['plugins', index, 'skillIds'])
    })
  })

export type Agent = z.infer<typeof agentSchema>
export type McpServer = z.infer<typeof mcpServerSchema>
export type Skill = z.infer<typeof skillSchema>
export type Plugin = z.infer<typeof pluginSchema>
export type Workspace = z.infer<typeof workspaceSchema>
export type ResourceKind = 'mcpServers' | 'skills' | 'plugins'
export type Resource = McpServer | Skill | Plugin

export function createAgent(agentId: string): Agent {
  return {
    id: agentId,
    name: '新 Agent',
    description: '',
    enabled: true,
    provider: 'openai-compatible',
    model: '',
    baseUrl: '',
    temperature: 0.7,
    systemPrompt: '你是一位严谨、可靠的助手。请清晰地回答用户问题，在信息不足时主动澄清。',
    mcpServerIds: [],
    skillIds: [],
    pluginIds: [],
  }
}

export function createWorkspace(): Workspace {
  return {
    schemaVersion: 1,
    revision: 0,
    agents: [
      {
        ...createAgent('general-assistant'),
        name: '通用助手',
        description: '从一个想法开始，打造属于你的 Agent。',
      },
    ],
    mcpServers: [],
    skills: [],
    plugins: [],
  }
}

export function createResource(kind: ResourceKind, resourceId: string): Resource {
  const base = { id: resourceId, name: '', description: '', enabled: true }
  if (kind === 'mcpServers')
    return { ...base, transport: 'stdio', command: '', args: [], envRefs: {} }
  if (kind === 'skills') return { ...base, instructions: '', sourcePath: '' }
  return { ...base, version: '1.0.0', mcpServerIds: [], skillIds: [] }
}

/** Remove a resource and its references together, keeping the workspace valid. */
export function removeResource(
  workspace: Workspace,
  kind: ResourceKind,
  resourceId: string,
): Workspace {
  const next = structuredClone(workspace)
  const refKey = { mcpServers: 'mcpServerIds', skills: 'skillIds', plugins: 'pluginIds' }[kind] as
    'mcpServerIds' | 'skillIds' | 'pluginIds'
  if (kind === 'mcpServers')
    next.mcpServers = next.mcpServers.filter((entry) => entry.id !== resourceId)
  if (kind === 'skills') next.skills = next.skills.filter((entry) => entry.id !== resourceId)
  if (kind === 'plugins') next.plugins = next.plugins.filter((entry) => entry.id !== resourceId)
  next.agents.forEach((agent) => {
    agent[refKey] = agent[refKey].filter((ref) => ref !== resourceId)
  })
  if (refKey !== 'pluginIds') {
    next.plugins.forEach((plugin) => {
      plugin[refKey] = plugin[refKey].filter((ref) => ref !== resourceId)
    })
  }
  return next
}

/** A plugin contributes references; disabled resources are never effective. No code is executed. */
export function resolveResources(workspace: Workspace, agent: Agent) {
  if (!agent.enabled) return { mcpServers: [], skills: [], plugins: [] }
  const plugins = workspace.plugins.filter(
    (plugin) => plugin.enabled && agent.pluginIds.includes(plugin.id),
  )
  const mcpIds = new Set([
    ...agent.mcpServerIds,
    ...plugins.flatMap((plugin) => plugin.mcpServerIds),
  ])
  const skillIds = new Set([...agent.skillIds, ...plugins.flatMap((plugin) => plugin.skillIds)])
  return {
    plugins,
    mcpServers: workspace.mcpServers.filter((server) => server.enabled && mcpIds.has(server.id)),
    skills: workspace.skills.filter((skill) => skill.enabled && skillIds.has(skill.id)),
  }
}

export function formatError(error: unknown): string {
  if (error instanceof z.ZodError) {
    return error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('\n')
  }
  return error instanceof Error ? error.message : '操作失败，请重试。'
}
