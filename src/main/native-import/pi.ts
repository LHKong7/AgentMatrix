import { credentialInputSchema } from '../../shared/credentials'
import { appError } from '../../shared/errors'
import { piApis } from '../../shared/engines/contracts'
import { importedProviderBaseUrl } from '../../shared/engines/provider-endpoint'
import type {
  ImportCollection,
  NativeImportRecord,
  PiImportKind,
} from '../../shared/engines/native-import'
import {
  agentProfileSchema,
  headerName,
  modelConnectionSchema,
  modelProfileSchema,
  type ModelConnection,
  type ModelProfile,
  type SecretReference,
} from '../../shared/engines/schema'
import { promptAssetSchema, type EngineWorkspace } from '../../shared/engines/workspace'
import {
  childPointer as at,
  isObject,
  nativeLeafPaths,
  type JsonObject,
  type JsonValue,
} from './jsonc'
import type { NativeImportPlan } from './plan'
import { adoptNativeConnections, type NativeProviderSource } from './adoption'
import { parsePiSecretValue } from './pi-values'

export type PiImportDocuments = Partial<Record<PiImportKind, JsonObject | string>>
const label = (value: string) => value.trim().slice(0, 80) || 'Imported Pi configuration'
const text = (value: JsonValue | undefined, max = 4000) =>
  typeof value === 'string' && value.length <= max ? value : undefined
const document = (value: JsonObject | string | undefined): JsonObject =>
  typeof value === 'object' && value !== null ? value : Object.create(null)

/** Maps only the explicitly selected files; never loads Pi, its credential backend or extensions. */
export function planPiImport(
  files: PiImportDocuments,
  installationId: string,
  importId: string,
): NativeImportPlan {
  const plan: NativeImportPlan = {
    additions: { connections: [], models: [], agents: [], prompts: [], mcpServers: [] },
    bindings: [],
    credentials: [],
    mappings: [],
    diagnostics: [],
  }
  const nativeProviders = new Map<string, NativeProviderSource>()
  const handled = new Set<string>(),
    trees = new Set<string>()
  let serial = 0
  const id = () => `import-${importId}-${++serial}`
  const diagnostic = (path: string, code: NativeImportRecord['diagnostics'][number]['code']) => {
    if (!plan.diagnostics.some((entry) => entry.path === path && entry.code === code))
      plan.diagnostics.push({ path, code })
    trees.add(path)
  }
  const mapped = (path: string, collection: ImportCollection, targetId: string, field: string) => {
    if (
      !plan.mappings.some(
        (entry) => entry.path === path && entry.id === targetId && entry.field === field,
      )
    )
      plan.mappings.push({ path, collection, id: targetId, field })
    handled.add(path)
  }
  const modelsDocument = document(files['models.json']),
    auth = document(files['auth.json']),
    settings = document(files['settings.json'])
  const refs = new Map<string, { ref: SecretReference; paths: string[] }>()
  const secret = (
    value: JsonValue | undefined,
    path: string,
    name: string,
    env: JsonObject,
    envPath: string,
  ) => {
    if (refs.has(path)) return refs.get(path)!
    if (typeof value !== 'string' || value.length > 65_536) {
      if (value !== undefined) diagnostic(path, 'invalid-value')
      return null
    }
    const parsed = parsePiSecretValue(value)
    if (parsed.kind === 'unresolved') {
      diagnostic(path, 'unresolved-reference')
      return null
    }
    const paths = [path]
    let literal: string
    if (parsed.kind === 'environment') {
      const override = env[parsed.name]
      if (override === undefined || override === '') {
        const result = { ref: { kind: 'environment' as const, name: parsed.name }, paths }
        refs.set(path, result)
        return result
      }
      if (typeof override !== 'string') {
        diagnostic(at(envPath, parsed.name), 'invalid-value')
        return null
      }
      // auth.json's explicit env dictionary is literal data, not the host environment or a second template.
      literal = override
      paths.push(at(envPath, parsed.name))
    } else literal = parsed.value
    const candidate = credentialInputSchema.safeParse({
      id: id(),
      name: label(name),
      kind: 'api-key',
      value: literal,
      expectedRevision: null,
    })
    if (!candidate.success) {
      diagnostic(path, 'invalid-value')
      return null
    }
    plan.credentials.push(candidate.data)
    const result = { ref: { kind: 'credential' as const, id: candidate.data.id! }, paths }
    refs.set(path, result)
    return result
  }
  const providers = isObject(modelsDocument.providers)
    ? modelsDocument.providers
    : (Object.create(null) as JsonObject)
  const connections = new Map<string, ModelConnection>()
  const routes = new Map<string, ModelProfile>()
  const route = (provider: string, model: string) => JSON.stringify([provider, model])
  const connection = (
    providerId: string,
    config: JsonObject,
    providerPath: string,
    definition?: JsonObject,
    modelPath?: string,
  ): ModelConnection | null => {
    const targetId = id()
    const apiPath = definition?.api === undefined ? `${providerPath}/api` : `${modelPath}/api`
    const api = definition?.api ?? config.api
    const protocol =
      (Object.entries(piApis).find(
        ([, native]) => native === api,
      )?.[0] as ModelConnection['protocol']) ?? null
    const endpointPath =
      definition?.baseUrl === undefined ? `${providerPath}/baseUrl` : `${modelPath}/baseUrl`
    const endpoint = definition?.baseUrl ?? config.baseUrl
    let baseUrl = ''
    if (endpoint !== undefined) {
      try {
        if (typeof endpoint !== 'string' || endpoint.length > 4000) throw new Error()
        const url = new URL(endpoint)
        if (
          !['http:', 'https:'].includes(url.protocol) ||
          url.username ||
          url.password ||
          url.search ||
          url.hash
        )
          throw new Error()
        baseUrl = importedProviderBaseUrl(protocol, endpoint, 'pi')
      } catch {
        diagnostic(endpointPath, 'invalid-value')
      }
    }
    const entryPath = at('/auth.json', providerId),
      stored = auth[providerId]
    const entry = isObject(stored) ? stored : null
    const env = isObject(entry?.env) ? entry.env : (Object.create(null) as JsonObject)
    const candidate: ModelConnection = {
      id: targetId,
      name: label(
        modelPath
          ? `${providerId} · ${text(definition?.name) ?? text(definition?.id) ?? 'model'}`
          : providerId,
      ),
      protocol,
      baseUrl,
      auth: { kind: 'unconfigured' },
      headers: Object.create(null),
      secretHeaders: Object.create(null),
    }
    if (entry?.type === 'oauth') {
      candidate.auth = { kind: 'engine-login' }
      diagnostic(entryPath, 'unconverted')
    } else if (protocol && config.oauth === undefined) {
      // Selected stored credentials take precedence; never silently fall back after an unresolved command/key.
      const validEnv =
        entry?.env === undefined ||
        (isObject(entry.env) &&
          Object.values(entry.env).every((value) => typeof value === 'string'))
      const supported = stored === undefined || (entry?.type === 'api_key' && validEnv)
      const keyPath = stored === undefined ? `${providerPath}/apiKey` : `${entryPath}/key`
      const key = stored === undefined ? config.apiKey : entry?.key
      const ref = supported
        ? secret(key, keyPath, `${providerId} key`, env, `${entryPath}/env`)
        : null
      if (!supported) diagnostic(entryPath, 'invalid-value')
      if (ref) {
        candidate.auth = protocol.startsWith('openai-')
          ? { kind: 'bearer', secret: ref.ref }
          : {
              kind: 'api-key',
              header: protocol === 'gemini' ? 'x-goog-api-key' : 'x-api-key',
              secret: ref.ref,
            }
        for (const path of ref.paths) mapped(path, 'connections', targetId, 'auth')
        if (stored !== undefined) mapped(`${entryPath}/type`, 'connections', targetId, 'auth')
      }
    }
    const headers = new Map<string, { value: JsonValue; path: string }>()
    for (const [values, path] of [
      [config.headers, `${providerPath}/headers`],
      [definition?.headers, `${modelPath}/headers`],
    ] as const) {
      if (values === undefined) continue
      if (!isObject(values)) {
        diagnostic(path, 'invalid-value')
        continue
      }
      for (const [name, value] of Object.entries(values))
        headers.set(name, { value, path: at(path, name) })
    }
    const names = new Set<string>()
    for (const [name, header] of headers) {
      if (
        name === '__proto__' ||
        !headerName.safeParse(name).success ||
        names.has(name.toLowerCase())
      ) {
        diagnostic(header.path, 'invalid-value')
        continue
      }
      names.add(name.toLowerCase())
      const ref = secret(
        header.value,
        header.path,
        `${providerId} ${name}`,
        env,
        `${entryPath}/env`,
      )
      if (ref) {
        candidate.secretHeaders[name] = ref.ref
        for (const path of ref.paths) mapped(path, 'connections', targetId, 'secretHeaders')
      }
    }
    if (config.authHeader !== undefined) {
      if (
        config.authHeader === false ||
        (config.authHeader === true && protocol?.startsWith('openai-'))
      )
        mapped(`${providerPath}/authHeader`, 'connections', targetId, 'auth')
      else {
        candidate.auth = { kind: 'unconfigured' }
        diagnostic(`${providerPath}/authHeader`, 'invalid-value')
      }
    }
    const parsed = modelConnectionSchema.safeParse(candidate)
    if (!parsed.success) {
      diagnostic(modelPath ?? providerPath, 'invalid-value')
      return null
    }
    plan.additions.connections.push(parsed.data)
    nativeProviders.set(parsed.data.id, { nativeId: providerId, path: providerPath })
    if (protocol) mapped(apiPath, 'connections', targetId, 'protocol')
    if (baseUrl) mapped(endpointPath, 'connections', targetId, 'baseUrl')
    return parsed.data
  }
  for (const [providerId, value] of Object.entries(providers)) {
    const path = at('/models.json/providers', providerId)
    if (!isObject(value)) {
      diagnostic(path, 'invalid-value')
      continue
    }
    const base = connection(providerId, value, path)
    if (base) connections.set(providerId, base)
    if (!Array.isArray(value.models)) continue
    const seen = new Set<string>()
    for (const [index, definition] of value.models.entries()) {
      const location = at(`${path}/models`, index)
      if (!isObject(definition) || !text(definition.id, 200)?.trim()) {
        diagnostic(location, 'invalid-value')
        continue
      }
      const modelId = definition.id as string
      if (seen.has(modelId)) throw appError('error.invalidData')
      seen.add(modelId)
      const scoped = ['api', 'baseUrl', 'headers'].some((key) => definition[key] !== undefined)
        ? connection(providerId, value, path, definition, location)
        : base
      const parameters: ModelProfile['parameters'] = {}
      const sampling = isObject(definition.samplingParams) ? definition.samplingParams : null
      const targetId = id()
      for (const [nativeKey, sharedKey, max] of [
        ['temperature', 'temperature', 2],
        ['top_p', 'topP', 1],
      ] as const) {
        const input = sampling?.[nativeKey]
        if (input === undefined) continue
        if (
          scoped?.protocol?.startsWith('openai-') &&
          typeof input === 'number' &&
          input >= 0 &&
          input <= max
        ) {
          parameters[sharedKey] = input
          mapped(
            `${location}/samplingParams/${nativeKey}`,
            'models',
            targetId,
            `parameters.${sharedKey}`,
          )
        } else diagnostic(`${location}/samplingParams/${nativeKey}`, 'invalid-value')
      }
      const overrides =
        isObject(value.modelOverrides) && value.modelOverrides[modelId] !== undefined
      const blocked =
        overrides ||
        value.compat !== undefined ||
        definition.compat !== undefined ||
        definition.thinkingLevelMap !== undefined
      const model = modelProfileSchema.parse({
        id: targetId,
        name: label(text(definition.name) ?? modelId),
        modelId,
        connectionId: blocked ? null : (scoped?.id ?? null),
        parameters,
      })
      plan.additions.models.push(model)
      routes.set(route(providerId, modelId), model)
      mapped(`${location}/id`, 'models', model.id, 'modelId')
      if (text(definition.name) !== undefined)
        mapped(`${location}/name`, 'models', model.id, 'name')
    }
  }
  const providerId = text(settings.defaultProvider),
    modelId = text(settings.defaultModel, 200)
  let selected = providerId && modelId ? routes.get(route(providerId, modelId)) : undefined
  if (!selected && providerId && modelId && connections.has(providerId)) {
    const provider = providers[providerId]
    const blocked =
      isObject(provider) &&
      (provider.compat !== undefined ||
        (isObject(provider.modelOverrides) && provider.modelOverrides[modelId] !== undefined))
    selected = modelProfileSchema.parse({
      id: id(),
      name: label(modelId),
      modelId,
      connectionId: blocked ? null : connections.get(providerId)!.id,
      parameters: {},
    })
    plan.additions.models.push(selected)
    mapped('/settings.json/defaultModel', 'models', selected.id, 'modelId')
  }
  const promptBindings: EngineWorkspace['agents'][number]['promptBindings'] = []
  for (const kind of ['SYSTEM.md', 'APPEND_SYSTEM.md'] as const) {
    const content = files[kind]
    if (content === undefined) continue
    const targetId = id()
    if (typeof content !== 'string' || !content.trim() || content.length > 100_000) {
      diagnostic(at('', kind), 'invalid-value')
      continue
    }
    const asset = promptAssetSchema.parse({
      id: targetId,
      name: `Pi ${kind}`,
      description: '',
      enabled: true,
      purpose: kind === 'SYSTEM.md' ? 'role' : 'system-template',
      currentVersion: 1,
      versions: [{ version: 1, content }],
    })
    plan.additions.prompts.push(asset)
    promptBindings.push({
      assetId: asset.id,
      selection: { follow: 'latest' },
      mode: kind === 'SYSTEM.md' ? 'replace' : 'append',
    })
    mapped(at('', kind), 'prompts', asset.id, 'versions[0].content')
  }
  const thinking = text(settings.defaultThinkingLevel, 100)
  const thinkingLevel =
    thinking && ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'].includes(thinking)
      ? thinking
      : undefined
  if (settings.defaultThinkingLevel !== undefined && !thinkingLevel)
    diagnostic('/settings.json/defaultThinkingLevel', 'invalid-value')
  const agent = agentProfileSchema.parse({
    id: id(),
    name: 'Imported Pi profile',
    description: '',
    enabled: false,
    engineInstallationId: installationId,
    modelProfileId: selected?.id ?? null,
    promptBindings,
    mcpServerIds: [],
    skillBindings: [],
    bundleIds: [],
    nativePluginIds: [],
    engineOptions: {
      kind: 'pi',
      projectTrust: 'deny',
      contextFiles: 'inherit',
      ...(thinkingLevel ? { thinkingLevel } : {}),
    },
    execution: { cwd: '', approval: 'ask' },
  })
  plan.additions.agents.push(agent)
  if (selected)
    for (const field of ['defaultProvider', 'defaultModel'])
      mapped(`/settings.json/${field}`, 'agents', agent.id, 'modelProfileId')
  if (thinkingLevel)
    mapped('/settings.json/defaultThinkingLevel', 'agents', agent.id, 'engineOptions.thinkingLevel')
  if (settings.defaultTools !== undefined)
    diagnostic('/settings.json/defaultTools', 'review-policy')
  for (const [kind, value] of Object.entries(files))
    for (const path of nativeLeafPaths(value, at('', kind)))
      if (
        !handled.has(path) &&
        ![...trees].some((prefix) => path === prefix || path.startsWith(`${prefix}/`))
      )
        diagnostic(path, 'unconverted')
  const retained = new Set(
    Object.values(plan.additions)
      .flat()
      .map((entry) => entry.id),
  )
  plan.mappings = plan.mappings.filter((mapping) => retained.has(mapping.id))
  const used = new Set<string>()
  const visit = (value: unknown) => {
    if (value === null || typeof value !== 'object') return
    if (
      'kind' in value &&
      value.kind === 'credential' &&
      'id' in value &&
      typeof value.id === 'string'
    )
      used.add(value.id)
    for (const child of Object.values(value)) visit(child)
  }
  visit(plan.additions)
  plan.credentials = plan.credentials.filter((entry) => used.has(entry.id!))
  adoptNativeConnections(plan, {
    engine: 'pi',
    installationId,
    importId,
    sources: nativeProviders,
  })
  return plan
}
