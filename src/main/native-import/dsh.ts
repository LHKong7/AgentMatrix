import { credentialInputSchema } from '../../shared/credentials'
import { appError } from '../../shared/errors'
import { piApis } from '../../shared/engines/contracts'
import { importedProviderBaseUrl } from '../../shared/engines/provider-endpoint'
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
import { promptAssetSchema, type EngineWorkspace } from '../../shared/engines/workspace'
import type { ImportCollection, NativeImportRecord } from '../../shared/engines/native-import'
import { childPointer as at } from './jsonc'
import {
  dshSections,
  field,
  located,
  origin,
  type DshImportDocuments,
  type Located,
} from './dsh-layers'
import { dshLeafPaths, dshObject, ImportExpression } from './dsh-yaml'
import { parsePiSecretValue } from './pi-values'
import type { NativeImportPlan } from './plan'
import { adoptNativeConnections, type NativeProviderSource } from './adoption'

function validateCredentials(files: DshImportDocuments) {
  const value = files['.credentials.yaml']
  if (value === undefined) return
  const strings = (input: unknown) =>
    input !== null &&
    typeof input === 'object' &&
    !Array.isArray(input) &&
    Object.values(input).every((item) => typeof item === 'string' && item.length > 0)
  if (
    !dshObject(value) ||
    value.version !== 1 ||
    Object.keys(value).some((key) => !['version', 'refs', 'records'].includes(key)) ||
    (value.refs !== undefined &&
      (!dshObject(value.refs) ||
        !strings(value.refs) ||
        Object.keys(value.refs).some((key) => !environmentName.safeParse(key).success))) ||
    (value.records !== undefined && !dshObject(value.records))
  )
    throw appError('error.nativeImportYaml')
  if (dshObject(value.records))
    for (const [key, record] of Object.entries(value.records)) {
      if (!/^[a-z0-9]+(?:-[a-z0-9]+)*\/[a-z0-9]+(?:-[a-z0-9]+)*$/.test(key) || !dshObject(record))
        throw appError('error.nativeImportYaml')
      if (record.kind === 'api-key') {
        if (
          Object.keys(record).some((key) => !['kind', 'key', 'env'].includes(key)) ||
          (record.key !== undefined && (typeof record.key !== 'string' || !record.key.length)) ||
          (record.env !== undefined &&
            (!strings(record.env) ||
              Object.keys(record.env as object).some(
                (key) => !environmentName.safeParse(key).success,
              )))
        )
          throw appError('error.nativeImportYaml')
      } else if (
        record.kind !== 'grant' ||
        record.payload === undefined ||
        Object.keys(record).some((key) => !['kind', 'payload'].includes(key))
      )
        throw appError('error.nativeImportYaml')
    }
}

const label = (value: string) => value.trim().slice(0, 80) || 'Imported DSH configuration'
const string = (input: Located, max = 4000) =>
  typeof input.value === 'string' && input.value.length <= max ? input.value : undefined
export function planDshImport(
  files: DshImportDocuments,
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
  let serial = 0
  const id = () => `import-${importId}-${++serial}`
  const handled = new Set<string>(),
    diagnosed = new Set<string>()
  const diagnostic = (path: string, code: NativeImportRecord['diagnostics'][number]['code']) => {
    if (!path || plan.diagnostics.some((entry) => entry.path === path && entry.code === code))
      return
    plan.diagnostics.push({ path, code })
    diagnosed.add(path)
  }
  const mapped = (input: Located, collection: ImportCollection, targetId: string, name: string) => {
    const path = origin(input)
    if (!path) return
    plan.mappings.push({ path, collection, id: targetId, field: name })
    handled.add(path)
  }
  const sections = dshSections(files, diagnostic)
  validateCredentials(files)
  const credentials = files['.credentials.yaml']
  if (credentials !== undefined && !dshObject(credentials)) throw appError('error.nativeImportYaml')
  const credentialDocument = located(credentials ?? Object.create(null), '/.credentials.yaml')
  const validCredentials = credentials === undefined || credentials.version === 1
  if (!validCredentials) diagnostic('/.credentials.yaml', 'invalid-value')
  const refs = field(credentialDocument, 'refs'),
    records = field(credentialDocument, 'records')
  const secretCache = new Map<string, SecretReference>()
  const literalSecret = (input: Located, name: string): SecretReference | null => {
    const path = origin(input)
    if (secretCache.has(path)) return secretCache.get(path)!
    if (input.value instanceof ImportExpression) {
      // A deliberately narrow inert grammar. No general JavaScript parser/evaluator or file reads.
      const match =
        /^\s*process\.env(?:\.([A-Za-z_][A-Za-z0-9_]*)|\[(?:"([A-Za-z_][A-Za-z0-9_]*)"|'([A-Za-z_][A-Za-z0-9_]*)')\])\s*$/.exec(
          input.value.source,
        )
      if (match) return { kind: 'environment', name: (match[1] ?? match[2] ?? match[3])! }
      diagnostic(path, 'unresolved-reference')
      return null
    }
    const result = credentialInputSchema.safeParse({
      id: id(),
      name: label(name),
      kind: 'api-key',
      value: input.value,
      expectedRevision: null,
    })
    if (!result.success) {
      diagnostic(path, 'invalid-value')
      return null
    }
    plan.credentials.push(result.data)
    const reference: SecretReference = { kind: 'credential', id: result.data.id! }
    secretCache.set(path, reference)
    return reference
  }
  const routeModels = new Map<string, ModelProfile>(),
    routes = new Map<string, { connection: ModelConnection; input: Located; native: boolean }>()
  const routeKey = (provider: string, model: string) => JSON.stringify([provider, model])
  const addRoute = (provider: string, input: Located, native: boolean) => {
    if (!dshObject(input.value)) {
      diagnostic(origin(input), 'invalid-value')
      return
    }
    if (routes.has(provider)) throw appError('error.invalidData')
    const targetId = id(),
      api = field(input, 'api'),
      endpoint = field(input, 'baseURL')
    const protocol: ModelConnection['protocol'] = native
      ? 'deepseek-official'
      : ((Object.entries(piApis).find(
          ([, apiName]) => apiName === api.value,
        )?.[0] as ModelConnection['protocol']) ?? null)
    let baseUrl = ''
    if (endpoint.value !== null) {
      try {
        const raw = string(endpoint),
          url = new URL(raw ?? '')
        if (
          !['http:', 'https:'].includes(url.protocol) ||
          url.username ||
          url.password ||
          url.search ||
          url.hash
        )
          throw new Error()
        baseUrl = importedProviderBaseUrl(protocol, raw!, 'deepseek-harness')
      } catch {
        diagnostic(
          origin(endpoint),
          endpoint.value instanceof ImportExpression ? 'unresolved-reference' : 'invalid-value',
        )
      }
    }
    const candidate: ModelConnection = {
      id: targetId,
      name: label(string(field(input, 'displayName')) ?? provider),
      protocol,
      baseUrl,
      auth: { kind: 'unconfigured' },
      headers: Object.create(null),
      secretHeaders: Object.create(null),
    }
    let key = field(input, 'apiKeyEnv')
    // This documented native default is a reference, never a read of the importing process.
    if (native && key.value === null) key = located('DEEPSEEK_API_KEY', '')
    const keyName = string(key, 200)
    let secret: SecretReference | null = null,
      credentialSource: Located | null = null
    if (key.value !== null) {
      if (!keyName || !environmentName.safeParse(keyName).success)
        diagnostic(origin(key), 'invalid-value')
      else if (validCredentials && dshObject(refs.value) && Object.hasOwn(refs.value, keyName)) {
        credentialSource = field(refs, keyName)
        secret = literalSecret(credentialSource, `${provider} key`)
        // Managed output intentionally captures the selected stored value, not ambient precedence.
        diagnostic(origin(key) || origin(credentialSource), 'review-precedence')
      } else secret = { kind: 'environment', name: keyName }
    } else if (validCredentials) {
      const stored = field(records, `llm-pi-ai/${provider}`)
      if (dshObject(stored.value) && stored.value.kind === 'grant') {
        candidate.auth = { kind: 'engine-login' }
        diagnostic(origin(stored), 'unconverted')
      } else if (dshObject(stored.value) && stored.value.kind === 'api-key') {
        const storedKey = field(stored, 'key'),
          parsed = typeof storedKey.value === 'string' ? parsePiSecretValue(storedKey.value) : null
        if (parsed?.kind === 'literal' && stored.value.env === undefined) {
          credentialSource = storedKey
          secret = literalSecret({ ...storedKey, value: parsed.value }, `${provider} key`)
        } else diagnostic(origin(stored), 'unresolved-reference')
      }
    }
    if (secret && protocol) {
      candidate.auth =
        protocol === 'deepseek-official' || protocol.startsWith('openai-')
          ? { kind: 'bearer', secret }
          : {
              kind: 'api-key',
              header: protocol === 'gemini' ? 'x-goog-api-key' : 'x-api-key',
              secret,
            }
      mapped(key, 'connections', targetId, 'auth')
      if (credentialSource) mapped(credentialSource, 'connections', targetId, 'auth')
    }
    const headers = field(input, 'headers'),
      names = new Set<string>()
    if (dshObject(headers.value))
      for (const name of Object.keys(headers.value)) {
        const header = field(headers, name)
        if (
          native ||
          name === '__proto__' ||
          !headerName.safeParse(name).success ||
          names.has(name.toLowerCase())
        ) {
          diagnostic(origin(header), 'invalid-value')
          continue
        }
        names.add(name.toLowerCase())
        const ref = literalSecret(header, `${provider} ${name}`)
        if (ref) {
          candidate.secretHeaders[name] = ref
          mapped(header, 'connections', targetId, 'secretHeaders')
        }
      }
    const parsed = modelConnectionSchema.safeParse(candidate)
    if (!parsed.success) {
      diagnostic(origin(input), 'invalid-value')
      return
    }
    plan.additions.connections.push(parsed.data)
    nativeProviders.set(parsed.data.id, { nativeId: provider, path: origin(input) })
    routes.set(provider, { connection: parsed.data, input, native })
    if (!native && protocol) mapped(api, 'connections', targetId, 'protocol')
    if (baseUrl) mapped(endpoint, 'connections', targetId, 'baseUrl')
    if (string(field(input, 'displayName')))
      mapped(field(input, 'displayName'), 'connections', targetId, 'name')
  }
  const generic = sections.get('llm-pi-ai'),
    native = sections.get('llm-deepseek')
  if (generic) {
    const providers = field(generic, 'providers')
    if (dshObject(providers.value))
      for (const provider of Object.keys(providers.value))
        addRoute(provider, field(providers, provider), false)
  }
  if (native) addRoute('deepseek-official', native, true)
  const defaults = sections.get('agent-default-model')
  const selectedProvider = defaults && string(field(defaults, 'provider')),
    selectedId = defaults && string(field(defaults, 'model'), 200)
  const addModel = (provider: string, input: Located, fromDefault = false) => {
    const route = routes.get(provider)!,
      modelId = fromDefault ? field(input, 'model') : field(input, 'id'),
      value = string(modelId, 200)
    if (!value?.trim()) {
      diagnostic(origin(modelId), 'invalid-value')
      return
    }
    const key = routeKey(provider, value)
    if (routeModels.has(key)) {
      if (fromDefault) return
      throw appError('error.invalidData')
    }
    let reasoning = field(route.input, route.native ? 'reasoningEffort' : 'reasoning')
    if (
      defaults &&
      provider === selectedProvider &&
      value === selectedId &&
      field(defaults, 'reasoningEffort').value !== null
    )
      reasoning = field(defaults, 'reasoningEffort')
    if (route.native && field(route.input, 'thinking').value === 'disabled')
      reasoning = { ...field(route.input, 'thinking'), value: 'off' }
    const parameters: ModelProfile['parameters'] = {}
    if (reasoning.value !== null) {
      if (
        typeof reasoning.value === 'string' &&
        ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'].includes(reasoning.value)
      )
        parameters.reasoning = reasoning.value as NonNullable<
          ModelProfile['parameters']['reasoning']
        >
      else diagnostic(origin(reasoning), 'invalid-value')
    } else if (route.native) parameters.reasoning = 'high'
    const overrides = field(route.input, 'modelOverrides')
    const blocked =
      field(route.input, 'compat').value !== null ||
      (dshObject(overrides.value) && Object.hasOwn(overrides.value, value)) ||
      (!fromDefault &&
        ['compat', 'reasoningEfforts', 'api', 'baseURL', 'headers'].some(
          (name) => field(input, name).value !== null,
        ))
    const model = modelProfileSchema.parse({
      id: id(),
      name: label(string(field(input, 'name')) ?? value),
      modelId: value,
      connectionId: blocked ? null : route.connection.id,
      parameters,
    })
    plan.additions.models.push(model)
    routeModels.set(key, model)
    mapped(modelId, 'models', model.id, 'modelId')
    if (parameters.reasoning) mapped(reasoning, 'models', model.id, 'parameters.reasoning')
    if (string(field(input, 'name'))) mapped(field(input, 'name'), 'models', model.id, 'name')
  }
  for (const [provider, route] of routes) {
    const models = field(route.input, 'models')
    if (Array.isArray(models.value))
      models.value.forEach((value, index) => {
        // Preserve the source path for every model leaf in a replaced array.
        const prefix = `/${index}`
        addModel(provider, {
          value,
          origins: new Map(
            [...models.origins]
              .filter(([path]) => path === prefix || path.startsWith(prefix + '/'))
              .map(([path, source]) => [path.slice(prefix.length), source]),
          ),
        })
      })
  }
  if (defaults && selectedProvider && selectedId && routes.has(selectedProvider))
    addModel(selectedProvider, defaults, true)
  const selected =
    selectedProvider && selectedId
      ? routeModels.get(routeKey(selectedProvider, selectedId))
      : undefined
  const prompts: { id: string; position: 'prefix' | 'suffix' }[] = []
  const prompt = sections.get('system-prompt')
  if (prompt)
    for (const position of ['prefix', 'suffix'] as const) {
      const source = field(prompt, position === 'prefix' ? 'personaPrefix' : 'personaSuffix'),
        content = string(source, 100_000)
      if (source.value === null || content === '') continue
      if (!content?.trim() || /\{\{/.test(content)) {
        diagnostic(
          origin(source),
          content?.includes('{{') || source.value instanceof ImportExpression
            ? 'unresolved-reference'
            : 'invalid-value',
        )
        continue
      }
      const asset = promptAssetSchema.parse({
        id: id(),
        name: `DSH persona ${position}`,
        description: '',
        enabled: true,
        purpose: 'system-template',
        currentVersion: 1,
        versions: [{ version: 1, content }],
      })
      plan.additions.prompts.push(asset)
      prompts.push({ id: asset.id, position })
      mapped(source, 'prompts', asset.id, 'versions[0].content')
    }
  const promptBindings: EngineWorkspace['agents'][number]['promptBindings'] =
    prompts.length === 1
      ? [{ assetId: prompts[0]!.id, selection: { follow: 'latest' }, mode: 'append' }]
      : []
  if (prompts.length > 1 && prompt) diagnostic(origin(prompt), 'review-policy')
  const agent = agentProfileSchema.parse({
    id: id(),
    name: 'Imported DSH profile',
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
      kind: 'deepseek-harness',
      profileTemplate: 'acp',
      patchReload: 'startup',
      ...(prompts.length === 1 ? { appendPosition: prompts[0]!.position } : {}),
    },
    execution: { cwd: '', approval: 'ask' },
  })
  plan.additions.agents.push(agent)
  if (selected && defaults)
    for (const name of ['provider', 'model'])
      mapped(field(defaults, name), 'agents', agent.id, 'modelProfileId')
  for (const [kind, value] of Object.entries(files))
    for (const path of dshLeafPaths(value, at('', kind)))
      if (
        !handled.has(path) &&
        ![...diagnosed].some((parent) => path === parent || path.startsWith(parent + '/'))
      )
        diagnostic(path, 'unconverted')
  const retained = new Set(
    Object.values(plan.additions)
      .flat()
      .map((entry) => entry.id),
  )
  plan.mappings = plan.mappings.filter((entry) => retained.has(entry.id))
  const used = new Set<string>()
  for (const connection of plan.additions.connections)
    for (const reference of [
      ...Object.values(connection.secretHeaders),
      ...('secret' in connection.auth ? [connection.auth.secret] : []),
    ])
      if (reference?.kind === 'credential') used.add(reference.id)
  plan.credentials = plan.credentials.filter((entry) => used.has(entry.id!))
  adoptNativeConnections(plan, {
    engine: 'deepseek-harness',
    installationId,
    importId,
    sources: nativeProviders,
  })
  return plan
}
