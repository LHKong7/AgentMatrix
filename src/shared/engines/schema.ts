import { z } from 'zod'

export const entityId = z.string().regex(/^[a-zA-Z0-9_-]{1,100}$/)
export const environmentName = z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/)
export const headerName = z.string().regex(/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/)
export const displayName = z.string().trim().min(1).max(80)
export const description = z.string().max(500)
export const absolutePath = z
  .string()
  .min(1)
  .max(4000)
  .refine((value) => /^(\/|[A-Za-z]:[\\/]|\\\\[^\\]+\\[^\\]+)/.test(value))
  .refine((value) => !value.includes('\0'))

export const engineKindSchema = z.enum([
  'opencode',
  'pi',
  'deepseek-harness',
  'claude-code',
  'codex',
  'gemini-cli',
  'cline',
  'goose',
  'openhands-sdk',
  'openhands-cli-legacy',
])
export const initialEngineKinds = ['opencode', 'pi', 'deepseek-harness'] as const
export type EngineKind = z.infer<typeof engineKindSchema>

export const runtimeModeSchema = z.enum([
  'acp',
  'pi-rpc',
  'dsh-sdk',
  'claude-stream-json',
  'codex-app-server',
  'openhands-sdk',
])
export const engineInstallationSchema = z
  .object({
    id: entityId,
    name: displayName,
    kind: engineKindSchema,
    executable: absolutePath,
    prefixArgs: z.array(z.string().max(4000)).max(100),
    platform: z.enum(['darwin', 'win32', 'linux']),
    version: z.string().min(1).max(100).nullable(),
    modes: z.array(runtimeModeSchema).max(10),
    probedAt: z.iso.datetime().nullable(),
  })
  .strict()
export type EngineInstallation = z.infer<typeof engineInstallationSchema>

export const modelProtocolSchema = z.enum([
  'openai-chat-completions',
  'openai-responses',
  'anthropic-messages',
  'gemini',
  'vertex',
  'deepseek-official',
])
export type ModelProtocol = z.infer<typeof modelProtocolSchema>

export const endpointSchema = z.url().refine((value) => {
  const url = new URL(value)
  return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password
})
export const secretReferenceSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('credential'), id: entityId }).strict(),
  z.object({ kind: z.literal('environment'), name: environmentName }).strict(),
])
export type SecretReference = z.infer<typeof secretReferenceSchema>

export const authenticationSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('unconfigured') }).strict(),
  z.object({ kind: z.literal('none') }).strict(),
  z
    .object({
      kind: z.literal('api-key'),
      header: headerName,
      secret: secretReferenceSchema.nullable(),
    })
    .strict(),
  z.object({ kind: z.literal('bearer'), secret: secretReferenceSchema.nullable() }).strict(),
  z.object({ kind: z.literal('engine-login') }).strict(),
  z
    .object({
      kind: z.literal('cloud-identity'),
      provider: z.enum(['aws', 'google', 'azure']),
      profile: z.string().max(200).optional(),
    })
    .strict(),
])

/** Draft connections deliberately preserve unresolved protocol/auth choices. */
export const modelConnectionSchema = z
  .object({
    id: entityId,
    name: displayName,
    protocol: modelProtocolSchema.nullable(),
    baseUrl: z.union([z.literal(''), endpointSchema]),
    auth: authenticationSchema,
    headers: z.record(headerName, z.string().max(8000)),
    secretHeaders: z.record(headerName, secretReferenceSchema),
    source: z
      .object({ legacyProvider: z.enum(['openai-compatible', 'anthropic', 'ollama']) })
      .strict()
      .optional(),
  })
  .strict()
  .superRefine((connection, context) => {
    const names = new Set<string>()
    const entries: [string, string][] = [
      ...Object.keys(connection.headers).map((key): [string, string] => ['headers', key]),
      ...Object.keys(connection.secretHeaders).map((key): [string, string] => [
        'secretHeaders',
        key,
      ]),
    ]
    if (connection.auth.kind === 'api-key') entries.push(['auth', connection.auth.header])
    if (connection.auth.kind === 'bearer') entries.push(['auth', 'Authorization'])
    for (const [field, key] of entries) {
      if (names.has(key.toLowerCase())) {
        context.addIssue({
          code: 'custom',
          path: [field],
          message: 'validation.headerConflict',
        })
      }
      names.add(key.toLowerCase())
    }
    for (const [key, value] of Object.entries(connection.headers)) {
      if (/[\r\n\0]/.test(value)) {
        context.addIssue({
          code: 'custom',
          path: ['headers', key],
          message: 'validation.headerValue',
        })
      }
    }
  })
export type ModelConnection = z.infer<typeof modelConnectionSchema>

export const modelProfileSchema = z
  .object({
    id: entityId,
    name: displayName,
    connectionId: entityId.nullable(),
    modelId: z.string().trim().max(200),
    parameters: z
      .object({
        temperature: z.number().min(0).max(2).optional(),
        topP: z.number().min(0).max(1).optional(),
        reasoning: z.string().min(1).max(100).optional(),
      })
      .strict(),
  })
  .strict()
export type ModelProfile = z.infer<typeof modelProfileSchema>

export const versionSelectionSchema = z.discriminatedUnion('follow', [
  z.object({ follow: z.literal('latest') }).strict(),
  z.object({ follow: z.literal('pinned'), version: z.number().int().positive() }).strict(),
])
export const promptBindingSchema = z
  .object({
    assetId: entityId,
    selection: versionSelectionSchema,
    mode: z.enum(['append', 'replace', 'project-rule']).nullable(),
  })
  .strict()
export const skillBindingSchema = z
  .object({ assetId: entityId, selection: versionSelectionSchema })
  .strict()

export const referenceIds = z
  .array(entityId)
  .max(200)
  .refine((values) => new Set(values).size === values.length)

export const engineOptionsSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('opencode'), agent: z.string().min(1).max(100) }).strict(),
  z.object({ kind: z.literal('pi'), thinkingLevel: z.string().max(100).optional() }).strict(),
  z
    .object({
      kind: z.literal('deepseek-harness'),
      profileTemplate: z.enum(['acp', 'sdk', 'sdk-minimal']),
      patchReload: z.literal('startup'),
    })
    .strict(),
])

export const agentProfileSchema = z
  .object({
    id: entityId,
    name: displayName,
    description,
    enabled: z.boolean(),
    engineInstallationId: entityId.nullable(),
    modelProfileId: entityId.nullable(),
    promptBindings: z.array(promptBindingSchema).max(200),
    mcpServerIds: referenceIds,
    skillBindings: z.array(skillBindingSchema).max(200),
    bundleIds: referenceIds,
    nativePluginIds: referenceIds,
    engineOptions: engineOptionsSchema.nullable(),
    execution: z
      .object({
        cwd: z.union([z.literal(''), absolutePath]),
        approval: z.enum(['ask', 'deny', 'unrestricted']),
        timeoutMs: z.number().int().min(1000).max(86_400_000).optional(),
      })
      .strict(),
  })
  .strict()
export type AgentProfile = z.infer<typeof agentProfileSchema>

export const capabilitySchema = z
  .object({
    feature: z.string().min(1).max(100),
    mechanism: z.enum(['native', 'adapter', 'extension-required', 'unsupported', 'unknown']),
    verification: z.enum(['untested', 'passed', 'failed']),
    availability: z.enum([
      'ready',
      'missing-dependency',
      'missing-credential',
      'blocked',
      'unknown',
    ]),
    reason: z.string().max(2000),
    installationId: entityId,
    engineVersion: z.string().min(1).max(100),
    mode: runtimeModeSchema,
    profileDigest: z.string().regex(/^[a-f0-9]{64}$/),
    evidence: z.array(
      z.object({ source: z.string().max(4000), checkedAt: z.iso.datetime() }).strict(),
    ),
  })
  .strict()
export type Capability = z.infer<typeof capabilitySchema>

/** Evidence about a prior binary or configuration never authorizes a new run. */
export function isVerifiedCapability(
  capability: Capability,
  current: Pick<Capability, 'installationId' | 'engineVersion' | 'mode' | 'profileDigest'>,
): boolean {
  return (
    capability.verification === 'passed' &&
    capability.availability === 'ready' &&
    capability.mechanism !== 'unsupported' &&
    capability.mechanism !== 'unknown' &&
    capability.evidence.length > 0 &&
    capability.installationId === current.installationId &&
    capability.engineVersion === current.engineVersion &&
    capability.mode === current.mode &&
    capability.profileDigest === current.profileDigest
  )
}
