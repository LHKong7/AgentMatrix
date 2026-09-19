import { z } from 'zod'
import { credentialInputSchema } from '../../shared/credentials'
import { openCodeProviders } from '../../shared/engines/contracts'
import {
  agentProfileSchema,
  environmentName,
  headerName,
  modelConnectionSchema,
  modelProfileSchema,
  type ModelConnection,
  type ModelProfile,
  type SecretReference,
} from '../../shared/engines/schema'
import {
  mcpDefinitionSchema,
  promptAssetSchema,
  type EngineWorkspace,
} from '../../shared/engines/workspace'
import type { ImportCollection, NativeImportRecord } from '../../shared/engines/native-import'
import {
  childPointer as at,
  isObject,
  nativeLeafPaths,
  type JsonObject,
  type JsonValue,
} from './jsonc'

import type { NativeImportPlan } from './plan'
const text = (value: JsonValue | undefined, max = 100_000) =>
  typeof value === 'string' && value.length <= max ? value : undefined
const reference = (value: string) => /\{(?:env|file):[^}]*\}/.test(value)
const label = (value: string) => value.trim().slice(0, 80) || 'Imported configuration'

/** Explicit native-to-shared mappings; unknown data stays in the separately encrypted source. */
export function planOpenCodeImport(
  data: JsonObject,
  installationId: string,
  importId: string,
  promptFiles: ReadonlyMap<string, string> = new Map(),
): NativeImportPlan {
  const plan: NativeImportPlan = {
    additions: { connections: [], models: [], agents: [], prompts: [], mcpServers: [] },
    credentials: [],
    mappings: [],
    diagnostics: [],
  }
  let serial = 0
  const id = () => `import-${importId}-${++serial}`
  const handled = new Set<string>()
  const handledTrees = new Set<string>()
  const diagnostic = (path: string, code: NativeImportRecord['diagnostics'][number]['code']) => {
    plan.diagnostics.push({ path, code })
    handledTrees.add(path)
  }
  const mapped = (path: string, collection: ImportCollection, targetId: string, field: string) => {
    plan.mappings.push({ path, collection, id: targetId, field })
    handled.add(path)
  }
  const literal = (value: JsonValue | undefined, path: string, max = 100_000) => {
    const found = text(value, max)
    if (found === undefined) {
      if (value !== undefined) diagnostic(path, 'invalid-value')
      return undefined
    }
    if (reference(found)) {
      diagnostic(path, 'unresolved-reference')
      return undefined
    }
    return found
  }
  const secret = (
    value: JsonValue | undefined,
    path: string,
    name: string,
    kind: 'api-key' | 'bearer',
  ): SecretReference | null => {
    const found = text(value, 65_536)
    if (found === undefined) {
      if (value !== undefined) diagnostic(path, 'invalid-value')
      return null
    }
    const env = /^\{env:([A-Za-z_][A-Za-z0-9_]*)\}$/.exec(found)
    if (env) return { kind: 'environment', name: env[1]! }
    if (reference(found)) {
      diagnostic(path, 'unresolved-reference')
      return null
    }
    const credential = credentialInputSchema.safeParse({
      id: id(),
      name: label(name),
      kind,
      value: found,
      expectedRevision: null,
    })
    if (!credential.success) {
      diagnostic(path, 'invalid-value')
      return null
    }
    plan.credentials.push(credential.data)
    return { kind: 'credential', id: credential.data.id! }
  }
  const endpoint = (value: JsonValue | undefined, path: string) => {
    const found = literal(value, path, 4000)
    if (found === undefined) return ''
    try {
      const url = new URL(found)
      if (
        !['http:', 'https:'].includes(url.protocol) ||
        url.username ||
        url.password ||
        url.search ||
        url.hash
      )
        throw new Error()
      return found
    } catch {
      diagnostic(path, 'invalid-value')
      return ''
    }
  }
  const headerReferences = (
    value: JsonValue | undefined,
    path: string,
    collection: ImportCollection,
    targetId: string,
  ) => {
    const headers: Record<string, string> = Object.create(null)
    const secretHeaders: Record<string, SecretReference> = Object.create(null)
    if (value === undefined) return { headers, secretHeaders }
    if (!isObject(value)) {
      diagnostic(path, 'invalid-value')
      return { headers, secretHeaders }
    }
    const names = new Set<string>()
    for (const [name, entry] of Object.entries(value)) {
      const location = at(path, name)
      if (
        name === '__proto__' ||
        !headerName.safeParse(name).success ||
        names.has(name.toLowerCase())
      ) {
        diagnostic(location, 'invalid-value')
        continue
      }
      names.add(name.toLowerCase())
      if (entry === '') headers[name] = ''
      else {
        const ref = secret(entry, location, `Imported ${name}`, 'api-key')
        if (!ref) continue
        secretHeaders[name] = ref
      }
      mapped(location, collection, targetId, entry === '' ? 'headers' : 'secretHeaders')
    }
    return { headers, secretHeaders }
  }
  const providers = new Map<string, ModelConnection>()
  const routes = new Map<string, ModelProfile>()
  const ensureModel = (route: string, path: string): ModelProfile | null => {
    const existing = routes.get(route)
    if (existing) return existing
    const slash = route.indexOf('/')
    const provider = providers.get(route.slice(0, slash))
    if (slash < 1 || !provider || !route.slice(slash + 1).trim() || reference(route)) {
      diagnostic(path, reference(route) ? 'unresolved-reference' : 'invalid-value')
      return null
    }
    const model = modelProfileSchema.safeParse({
      id: id(),
      name: label(route),
      connectionId: provider.id,
      modelId: route.slice(slash + 1),
      parameters: {},
    })
    if (!model.success) {
      diagnostic(path, 'invalid-value')
      return null
    }
    plan.additions.models.push(model.data)
    routes.set(route, model.data)
    mapped(path, 'models', model.data.id, 'modelId')
    return model.data
  }
  if (isObject(data.provider))
    for (const [nativeId, native] of Object.entries(data.provider)) {
      const path = at('/provider', nativeId)
      if (!isObject(native)) {
        diagnostic(path, 'invalid-value')
        continue
      }
      const options = isObject(native.options)
        ? native.options
        : (Object.create(null) as JsonObject)
      const protocol =
        (Object.entries(openCodeProviders).find(
          ([, npm]) => npm === native.npm,
        )?.[0] as ModelConnection['protocol']) ?? null
      const connectionId = id()
      const connection: ModelConnection = {
        id: connectionId,
        name: label(text(native.name, 4000) ?? nativeId),
        protocol,
        baseUrl: endpoint(options.baseURL, `${path}/options/baseURL`),
        auth: { kind: 'unconfigured' },
        ...headerReferences(
          options.headers,
          `${path}/options/headers`,
          'connections',
          connectionId,
        ),
      }
      if (protocol) {
        const ref = secret(
          options.apiKey,
          `${path}/options/apiKey`,
          `${connection.name} key`,
          protocol.startsWith('openai-') ? 'bearer' : 'api-key',
        )
        if (ref) {
          connection.auth = protocol.startsWith('openai-')
            ? { kind: 'bearer', secret: ref }
            : {
                kind: 'api-key',
                header: protocol === 'gemini' ? 'x-goog-api-key' : 'x-api-key',
                secret: ref,
              }
          mapped(`${path}/options/apiKey`, 'connections', connectionId, 'auth')
        }
        mapped(`${path}/npm`, 'connections', connectionId, 'protocol')
      }
      const parsed = modelConnectionSchema.safeParse(connection)
      if (!parsed.success) {
        diagnostic(path, 'invalid-value')
        continue
      }
      plan.additions.connections.push(parsed.data)
      providers.set(nativeId, parsed.data)
      if (text(native.name, 4000) !== undefined)
        mapped(`${path}/name`, 'connections', connectionId, 'name')
      if (connection.baseUrl)
        mapped(`${path}/options/baseURL`, 'connections', connectionId, 'baseUrl')
      if (isObject(native.models))
        for (const [key, definition] of Object.entries(native.models)) {
          const location = at(`${path}/models`, key)
          if (!isObject(definition)) {
            diagnostic(location, 'invalid-value')
            continue
          }
          const modelId = literal(
            definition.id ?? key,
            definition.id === undefined ? location : `${location}/id`,
            200,
          )
          if (!modelId) {
            diagnostic(location, 'invalid-value')
            continue
          }
          const overrides = ['provider', 'options', 'headers', 'variants'].some(
            (field) => definition[field] !== undefined,
          )
          const parsedModel = modelProfileSchema.safeParse({
            id: id(),
            name: label(text(definition.name, 4000) ?? key),
            connectionId: overrides ? null : connectionId,
            modelId,
            parameters: {},
          })
          if (!parsedModel.success) {
            diagnostic(location, 'invalid-value')
            continue
          }
          const model = parsedModel.data
          plan.additions.models.push(model)
          routes.set(`${nativeId}/${key}`, model)
          mapped(
            definition.id === undefined ? location : `${location}/id`,
            'models',
            model.id,
            'modelId',
          )
          if (text(definition.name, 4000) !== undefined)
            mapped(`${location}/name`, 'models', model.id, 'name')
          if (overrides) diagnostic(location, 'invalid-value')
        }
    }
  const mcpIds: string[] = []
  if (isObject(data.mcp))
    for (const [name, native] of Object.entries(data.mcp)) {
      const path = at('/mcp', name)
      if (!isObject(native)) {
        diagnostic(path, 'invalid-value')
        continue
      }
      const targetId = id()
      const base = {
        id: targetId,
        name: label(name),
        description: '',
        enabled: native.enabled === undefined || native.enabled === true,
      }
      let candidate: unknown
      const timeout =
        typeof native.timeout === 'number' && native.timeout >= 1000 && native.timeout <= 300_000
          ? native.timeout
          : undefined
      if (native.type === 'local') {
        if (
          !Array.isArray(native.command) ||
          !native.command.length ||
          native.command.some((value) => typeof value !== 'string' || reference(value))
        ) {
          diagnostic(`${path}/command`, 'unresolved-reference')
          continue
        }
        // Shared argv has no secret-reference syntax. Keep recognizable credential arguments
        // encrypted for review instead of copying them into the ordinary workspace.
        if (
          native.command.some(
            (value) =>
              typeof value === 'string' &&
              /(?:api[-_]?key|token|secret|password|authorization|bearer\s)|:\/\/[^/\s]+@/i.test(
                value,
              ),
          )
        ) {
          diagnostic(`${path}/command`, 'invalid-value')
          continue
        }
        const environment: Record<string, string> = Object.create(null)
        const envRefs: Record<string, SecretReference> = Object.create(null)
        if (isObject(native.environment))
          for (const [key, value] of Object.entries(native.environment)) {
            const location = at(`${path}/environment`, key)
            if (key === '__proto__' || !environmentName.safeParse(key).success) {
              diagnostic(location, 'invalid-value')
              continue
            }
            if (value === '') environment[key] = ''
            else {
              const ref = secret(value, location, `Imported ${name} ${key}`, 'api-key')
              if (!ref) continue
              envRefs[key] = ref
            }
            mapped(location, 'mcpServers', targetId, value === '' ? 'environment' : 'envRefs')
          }
        const cwd = literal(native.cwd, `${path}/cwd`, 4000) ?? ''
        // Native relative cwd depends on the future workspace; retain it for explicit review.
        const absoluteCwd = cwd && /^(\/|[A-Za-z]:[\\/]|\\\\)/.test(cwd) ? cwd : ''
        if (cwd && !absoluteCwd) diagnostic(`${path}/cwd`, 'unresolved-reference')
        candidate = {
          ...base,
          transport: 'stdio',
          command: native.command[0],
          args: native.command.slice(1),
          cwd: absoluteCwd,
          environment,
          envRefs,
          ...(timeout === undefined ? {} : { timeoutMs: timeout }),
        }
        mapped(`${path}/command`, 'mcpServers', targetId, 'command,args')
        handledTrees.add(`${path}/command`)
        if (absoluteCwd) mapped(`${path}/cwd`, 'mcpServers', targetId, 'cwd')
      } else if (native.type === 'remote') {
        const url = endpoint(native.url, `${path}/url`)
        if (!url) continue
        const oauth = isObject(native.oauth) ? native.oauth : null
        const scope = literal(oauth?.scope, `${path}/oauth/scope`, 4000)
        const scopes = scope?.split(/\s+/).filter(Boolean) ?? []
        candidate = {
          ...base,
          transport: 'streamable-http',
          url,
          ...headerReferences(native.headers, `${path}/headers`, 'mcpServers', targetId),
          auth:
            native.oauth === false ? { kind: 'none' } : { kind: 'oauth', owner: 'engine', scopes },
          ...(timeout === undefined ? {} : { timeoutMs: timeout }),
        }
        mapped(`${path}/url`, 'mcpServers', targetId, 'url')
        if (native.oauth === false) mapped(`${path}/oauth`, 'mcpServers', targetId, 'auth')
        else if (scope !== undefined)
          mapped(`${path}/oauth/scope`, 'mcpServers', targetId, 'auth.scopes')
      } else {
        diagnostic(`${path}/type`, 'invalid-value')
        continue
      }
      const parsed = mcpDefinitionSchema.safeParse(candidate)
      if (!parsed.success) {
        diagnostic(path, 'invalid-value')
        continue
      }
      plan.additions.mcpServers.push(parsed.data)
      mcpIds.push(targetId)
      mapped(`${path}/type`, 'mcpServers', targetId, 'transport')
      if (typeof native.enabled === 'boolean')
        mapped(`${path}/enabled`, 'mcpServers', targetId, 'enabled')
      else if (native.enabled !== undefined) diagnostic(`${path}/enabled`, 'invalid-value')
      if (timeout !== undefined) mapped(`${path}/timeout`, 'mcpServers', targetId, 'timeoutMs')
    }
  const nativeAgents =
    isObject(data.agent) && Object.keys(data.agent).length
      ? Object.entries(data.agent)
      : ([['build', {} as JsonObject]] as const)
  const instructions: EngineWorkspace['agents'][number]['promptBindings'] = []
  if (Array.isArray(data.instructions))
    for (const [index] of data.instructions.entries()) {
      const path = `/instructions/${index}`
      const content = promptFiles.get(path)
      if (content === undefined) continue
      const asset = promptAssetSchema.safeParse({
        id: id(),
        name: label(`Imported instruction ${index + 1}`),
        description: '',
        enabled: true,
        purpose: 'system-template',
        currentVersion: 1,
        versions: [{ version: 1, content }],
      })
      if (!asset.success || !content.trim()) {
        diagnostic(path, 'invalid-value')
        continue
      }
      plan.additions.prompts.push(asset.data)
      instructions.push({ assetId: asset.data.id, selection: { follow: 'latest' }, mode: 'append' })
      mapped(path, 'prompts', asset.data.id, 'versions[0].content')
      // This is the user's selected file, not a reconstruction of cwd/glob/global native discovery.
      diagnostic(path, 'review-prompt-selection')
    }
  for (const [name, value] of nativeAgents) {
    const path = at('/agent', name)
    if (!isObject(value)) {
      diagnostic(path, 'invalid-value')
      continue
    }
    const targetId = id()
    const route = literal(
      value.model ?? data.model,
      value.model === undefined ? '/model' : `${path}/model`,
      4000,
    )
    let model = route
      ? ensureModel(route, value.model === undefined ? '/model' : `${path}/model`)
      : null
    if (model && (value.temperature !== undefined || value.top_p !== undefined)) {
      const parameters = z
        .object({
          temperature: z.number().min(0).max(2).optional(),
          topP: z.number().min(0).max(1).optional(),
        })
        .strict()
        .safeParse({ temperature: value.temperature, topP: value.top_p })
      if (parameters.success) {
        model = { ...model, id: id(), name: label(`${name} model`), parameters: parameters.data }
        plan.additions.models.push(model)
        if (value.temperature !== undefined)
          mapped(`${path}/temperature`, 'models', model.id, 'parameters.temperature')
        if (value.top_p !== undefined)
          mapped(`${path}/top_p`, 'models', model.id, 'parameters.topP')
      } else diagnostic(path, 'invalid-value')
    }
    const promptBindings: EngineWorkspace['agents'][number]['promptBindings'] = []
    const selectedPrompt = promptFiles.get(`${path}/prompt`)
    const prompt =
      selectedPrompt === undefined ? literal(value.prompt, `${path}/prompt`) : selectedPrompt.trim()
    if (prompt?.trim()) {
      const assetResult = promptAssetSchema.safeParse({
        id: id(),
        name: label(`${name} prompt`),
        description: '',
        enabled: true,
        purpose: 'role',
        currentVersion: 1,
        versions: [{ version: 1, content: prompt }],
      })
      if (assetResult.success) {
        const asset = assetResult.data
        plan.additions.prompts.push(asset)
        promptBindings.push({ assetId: asset.id, selection: { follow: 'latest' }, mode: 'replace' })
        mapped(`${path}/prompt`, 'prompts', asset.id, 'versions[0].content')
        if (selectedPrompt !== undefined) diagnostic(`${path}/prompt`, 'review-prompt-selection')
      } else diagnostic(`${path}/prompt`, 'invalid-value')
    } else if (selectedPrompt !== undefined) diagnostic(`${path}/prompt`, 'invalid-value')
    promptBindings.push(...instructions)
    const policy = value.permission ?? data.permission
    const approval = policy === 'allow' ? 'unrestricted' : policy === 'deny' ? 'deny' : 'ask'
    if (policy !== undefined) {
      const policyPath = value.permission === undefined ? '/permission' : `${path}/permission`
      if (typeof policy === 'string' && ['allow', 'deny', 'ask'].includes(policy))
        mapped(policyPath, 'agents', targetId, 'execution.approval')
      else diagnostic(policyPath, 'review-policy')
    }
    const parsed = agentProfileSchema.safeParse({
      id: targetId,
      name: label(name),
      description: text(value.description, 500) ?? '',
      enabled: false,
      engineInstallationId: installationId,
      modelProfileId: model?.id ?? null,
      promptBindings,
      mcpServerIds: mcpIds,
      skillBindings: [],
      bundleIds: [],
      nativePluginIds: [],
      engineOptions: { kind: 'opencode', agent: name },
      execution: { cwd: '', approval },
    })
    if (!parsed.success) {
      diagnostic(path, 'invalid-value')
      continue
    }
    plan.additions.agents.push(parsed.data)
    if (model)
      mapped(
        value.model === undefined ? '/model' : `${path}/model`,
        'agents',
        targetId,
        'modelProfileId',
      )
    if (text(value.description, 500) !== undefined)
      mapped(`${path}/description`, 'agents', targetId, 'description')
    if (value.mode !== undefined) diagnostic(`${path}/mode`, 'review-policy')
    if (value.disable !== undefined) diagnostic(`${path}/disable`, 'review-policy')
  }
  // Mapping an object key (for example a model ID) does not consume its unknown children.
  for (const path of nativeLeafPaths(data))
    if (
      !handled.has(path) &&
      ![...handledTrees].some((prefix) => path === prefix || path.startsWith(`${prefix}/`))
    )
      diagnostic(path, 'unconverted')
  const retainedIds = new Set(
    Object.values(plan.additions)
      .flat()
      .map((entry) => entry.id),
  )
  plan.mappings = plan.mappings.filter((mapping) => retainedIds.has(mapping.id))
  const usedCredentials = new Set<string>()
  const visit = (value: unknown) => {
    if (!value || typeof value !== 'object') return
    if (
      'kind' in value &&
      value.kind === 'credential' &&
      'id' in value &&
      typeof value.id === 'string'
    )
      usedCredentials.add(value.id)
    for (const child of Object.values(value)) visit(child)
  }
  visit(plan.additions)
  plan.credentials = plan.credentials.filter((credential) => usedCredentials.has(credential.id!))
  return plan
}
