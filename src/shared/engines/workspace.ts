import { z } from 'zod'
import {
  absolutePath,
  agentProfileSchema,
  description,
  displayName,
  endpointSchema,
  engineInstallationSchema,
  entityId,
  environmentName,
  headerName,
  modelConnectionSchema,
  modelProfileSchema,
  promptBindingSchema,
  referenceIds,
  secretReferenceSchema,
  skillBindingSchema,
} from './schema'

const resourceFields = { id: entityId, name: displayName, description, enabled: z.boolean() }
const version = z.number().int().positive()
const digest = z.string().regex(/^[a-f0-9]{64}$/)
export const assetRelativePath = z
  .string()
  .min(1)
  .max(2000)
  .refine(
    (value) =>
      !/[\\:\0]/.test(value) &&
      value.split('/').every((part) => part !== '' && part !== '.' && part !== '..'),
  )

export const promptAssetSchema = z
  .object({
    ...resourceFields,
    purpose: z.enum([
      'unspecified',
      'role',
      'project-rule',
      'system-template',
      'compaction-template',
    ]),
    currentVersion: version,
    versions: z
      .array(z.object({ version, content: z.string().max(100_000) }).strict())
      .min(1)
      .max(1000),
  })
  .strict()

const fileManifest = z
  .object({
    path: assetRelativePath,
    sha256: digest,
    bytes: z.number().int().nonnegative().max(20_000_000),
    executable: z.boolean(),
  })
  .strict()
export const skillVersionSchema = z.discriminatedUnion('kind', [
  z
    .object({ version, kind: z.literal('markdown'), content: z.string().min(1).max(100_000) })
    .strict(),
  z
    .object({
      version,
      kind: z.literal('directory'),
      digest,
      files: z.array(fileManifest).min(1).max(1000),
    })
    .strict()
    .superRefine((asset, context) => {
      if (!asset.files.some((file) => file.path === 'SKILL.md')) {
        context.addIssue({ code: 'custom', path: ['files'], message: 'validation.skillEntry' })
      }
      const paths = asset.files.map((file) => file.path.toLowerCase())
      if (new Set(paths).size !== paths.length) {
        context.addIssue({ code: 'custom', path: ['files'], message: 'validation.assetPaths' })
      }
    }),
])
export const skillAssetSchema = z
  .object({
    ...resourceFields,
    sourcePath: z.string().max(4000),
    currentVersion: version,
    versions: z.array(skillVersionSchema).min(1).max(1000),
  })
  .strict()

export const mcpAuthenticationSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('none') }).strict(),
  z.object({ kind: z.literal('bearer'), secret: secretReferenceSchema.nullable() }).strict(),
  z
    .object({
      kind: z.literal('oauth'),
      owner: z.literal('engine'),
      scopes: z.array(z.string().min(1).max(200)).max(100),
    })
    .strict(),
])
const remoteMcp = {
  ...resourceFields,
  url: endpointSchema,
  headers: z.record(
    headerName,
    z
      .string()
      .max(8000)
      .refine((value) => !/[\r\n\0]/.test(value)),
  ),
  secretHeaders: z.record(headerName, secretReferenceSchema),
  auth: mcpAuthenticationSchema,
  timeoutMs: z.number().int().min(1000).max(300_000).optional(),
}
export const mcpDefinitionSchema = z
  .discriminatedUnion('transport', [
    z
      .object({
        ...resourceFields,
        transport: z.literal('stdio'),
        command: z.string().trim().min(1).max(4000),
        args: z.array(z.string().max(4000)).max(100),
        cwd: z.union([z.literal(''), absolutePath]),
        environment: z.record(environmentName, z.string().max(8000)),
        envRefs: z.record(environmentName, secretReferenceSchema),
        timeoutMs: z.number().int().min(1000).max(300_000).optional(),
      })
      .strict(),
    z.object({ ...remoteMcp, transport: z.literal('streamable-http') }).strict(),
    z.object({ ...remoteMcp, transport: z.literal('legacy-sse') }).strict(),
  ])
  .superRefine((server, context) => {
    if (server.transport === 'stdio') {
      for (const key of Object.keys(server.environment)) {
        if (key in server.envRefs)
          context.addIssue({
            code: 'custom',
            path: ['environment', key],
            message: 'validation.environmentConflict',
          })
      }
      return
    }
    const headers = [...Object.keys(server.headers), ...Object.keys(server.secretHeaders)]
    if (server.auth.kind === 'bearer') headers.push('Authorization')
    const normalized = headers.map((key) => key.toLowerCase())
    if (new Set(normalized).size !== normalized.length) {
      context.addIssue({ code: 'custom', path: ['headers'], message: 'validation.headerConflict' })
    }
  })

export const capabilityBundleSchema = z
  .object({
    ...resourceFields,
    version: z.string().regex(/^\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?$/),
    promptBindings: z.array(promptBindingSchema).max(200),
    mcpServerIds: referenceIds,
    skillBindings: z.array(skillBindingSchema).max(200),
  })
  .strict()

export const nativePluginSchema = z
  .object({
    id: entityId,
    name: displayName,
    engineInstallationId: entityId,
    nativeId: z.string().min(1).max(200),
    version: z.string().min(1).max(100),
    source: z.string().max(4000),
    path: absolutePath,
  })
  .strict()

export const engineWorkspaceSchema = z
  .object({
    schemaVersion: z.literal(2),
    revision: z.number().int().nonnegative(),
    installations: z.array(engineInstallationSchema).max(100),
    connections: z.array(modelConnectionSchema).max(200),
    models: z.array(modelProfileSchema).max(200),
    agents: z.array(agentProfileSchema).max(200),
    prompts: z.array(promptAssetSchema).max(200),
    mcpServers: z.array(mcpDefinitionSchema).max(200),
    skills: z.array(skillAssetSchema).max(200),
    bundles: z.array(capabilityBundleSchema).max(200),
    nativePlugins: z.array(nativePluginSchema).max(200),
  })
  .strict()
  .superRefine((workspace, context) => {
    const collections = [
      'installations',
      'connections',
      'models',
      'agents',
      'prompts',
      'mcpServers',
      'skills',
      'bundles',
      'nativePlugins',
    ] as const
    for (const key of collections) {
      const ids = workspace[key].map((item) => item.id)
      if (new Set(ids).size !== ids.length) {
        context.addIssue({ code: 'custom', path: [key], message: 'validation.duplicateIds' })
      }
    }
    const has = (items: { id: string }[], id: string | null, path: (string | number)[]) => {
      if (id !== null && !items.some((item) => item.id === id)) {
        context.addIssue({ code: 'custom', path, message: 'validation.missingRef' })
      }
    }
    for (const key of ['prompts', 'skills'] as const) {
      workspace[key].forEach((asset, index) => {
        const versions = asset.versions.map((item) => item.version)
        if (
          new Set(versions).size !== versions.length ||
          !versions.includes(asset.currentVersion)
        ) {
          context.addIssue({
            code: 'custom',
            path: [key, index, 'versions'],
            message: 'validation.assetVersion',
          })
        }
      })
    }
    const checkBinding = (
      binding: {
        assetId: string
        selection: { follow: 'latest' } | { follow: 'pinned'; version: number }
      },
      collection: 'prompts' | 'skills',
      path: (string | number)[],
    ) => {
      has(workspace[collection], binding.assetId, [...path, 'assetId'])
      const asset = workspace[collection].find((item) => item.id === binding.assetId)
      const selection = binding.selection
      if (
        asset &&
        selection.follow === 'pinned' &&
        !asset.versions.some((item) => item.version === selection.version)
      ) {
        context.addIssue({
          code: 'custom',
          path: [...path, 'selection'],
          message: 'validation.assetVersion',
        })
      }
    }
    workspace.models.forEach((model, i) =>
      has(workspace.connections, model.connectionId, ['models', i, 'connectionId']),
    )
    workspace.nativePlugins.forEach((plugin, i) =>
      has(workspace.installations, plugin.engineInstallationId, [
        'nativePlugins',
        i,
        'engineInstallationId',
      ]),
    )
    for (const collection of ['agents', 'bundles'] as const) {
      workspace[collection].forEach((item, i) => {
        item.mcpServerIds.forEach((id, j) =>
          has(workspace.mcpServers, id, [collection, i, 'mcpServerIds', j]),
        )
        item.promptBindings.forEach((binding, j) =>
          checkBinding(binding, 'prompts', [collection, i, 'promptBindings', j]),
        )
        item.skillBindings.forEach((binding, j) =>
          checkBinding(binding, 'skills', [collection, i, 'skillBindings', j]),
        )
      })
    }
    workspace.agents.forEach((agent, i) => {
      has(workspace.installations, agent.engineInstallationId, [
        'agents',
        i,
        'engineInstallationId',
      ])
      has(workspace.models, agent.modelProfileId, ['agents', i, 'modelProfileId'])
      agent.bundleIds.forEach((id, j) => has(workspace.bundles, id, ['agents', i, 'bundleIds', j]))
      agent.nativePluginIds.forEach((id, j) =>
        has(workspace.nativePlugins, id, ['agents', i, 'nativePluginIds', j]),
      )
    })
  })
export type EngineWorkspace = z.infer<typeof engineWorkspaceSchema>
export type PromptAsset = z.infer<typeof promptAssetSchema>
export type SkillAsset = z.infer<typeof skillAssetSchema>
export type SkillVersion = z.infer<typeof skillVersionSchema>
export type McpDefinition = z.infer<typeof mcpDefinitionSchema>
export type CapabilityBundle = z.infer<typeof capabilityBundleSchema>

export function createEngineWorkspace(): EngineWorkspace {
  return {
    schemaVersion: 2,
    revision: 0,
    installations: [],
    connections: [],
    models: [],
    agents: [],
    prompts: [],
    mcpServers: [],
    skills: [],
    bundles: [],
    nativePlugins: [],
  }
}
