import { createHash, randomUUID } from 'node:crypto'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { dirname, extname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { SessionConfigOption } from '@agentclientprotocol/sdk'
import { z } from 'zod'
import { appError } from '../../../../shared/errors'
import type { ResolvedAgentConfiguration } from '../../../../shared/engines/resolution'
import type {
  GeneratedInputs,
  RunInputManifest,
  RunPaths,
} from '../../../../shared/engines/run-inputs'
import { pluginInspectionSchema } from '../../../../shared/engines/plugin-inspection'
import { observeExternalFile } from '../../run-input-store'
import { RuntimeFailure } from '../../runtime'
import { pluginEngineRangeStatus } from '../../plugin-engine-range'
import { inspectOpenCodePlugin, pluginInspectionLimits } from './plugin-inspection'
import { inspectFile } from '../../installed-plugin-files'
import { pluginExportNames } from './plugin-exports'
import bridgeSource from './plugin-bridge.mjs?raw'
import { observePluginDependencies } from '../../plugin-dependencies'
import type { PluginConfiguration } from '../../../../shared/engines/plugin-options'

const bindingSchema = z
  .object({
    id: z.string(),
    nativeId: z.string(),
    identity: z.string().regex(/^[a-f0-9]{64}$/),
    exports: z.array(z.string()).min(1).max(200),
    inspection: pluginInspectionSchema.pick({
      selectedPath: true,
      resolvedPath: true,
      entryKind: true,
      entry: true,
      package: true,
    }),
  })
  .strict()
const planSchema = z.array(bindingSchema).max(200)
const planPath = 'plugins/opencode-bindings.json'
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex')

/** Only installed ESM entries are projected. Original modules execute in the native process. */
export async function planOpenCodePlugins(
  configuration: ResolvedAgentConfiguration,
  paths: RunPaths,
  generated: GeneratedInputs,
  agentName: string,
): Promise<(string | [string, PluginConfiguration])[]> {
  if (!configuration.nativePlugins.length) return []
  const bindings: z.infer<typeof planSchema> = []
  const specifiers: (string | [string, PluginConfiguration])[] = []
  const entries = new Set<string>()
  for (const plugin of configuration.nativePlugins) {
    const inspection = await inspectOpenCodePlugin(plugin.path)
    if (extname(inspection.entry.path) === '.cjs') throw appError('error.pluginExports')
    if (entries.has(inspection.entry.resolvedPath)) throw appError('error.pluginDuplicate')
    entries.add(inspection.entry.resolvedPath)
    if (inspection.package?.version && inspection.package.version !== plugin.version)
      throw appError('error.pluginVersion')
    if (
      !['matched', 'undeclared'].includes(
        pluginEngineRangeStatus(
          inspection.package?.engineRange ?? null,
          configuration.installation,
        ),
      )
    )
      throw appError('error.pluginRange')
    const entry = await inspectFile(inspection.entry.path, pluginInspectionLimits.entryBytes, true)
    if (JSON.stringify(entry.observation) !== JSON.stringify(inspection.entry))
      throw appError('error.pluginChanged')
    const exports = pluginExportNames(
      new TextDecoder('utf-8', { fatal: true }).decode(entry.content!),
    )
    const binding = {
      id: plugin.id,
      nativeId: plugin.nativeId,
      exports,
      inspection,
      identity: digest({ plugin, inspection, exports }),
    }
    bindings.push(binding)
    generated.externalSources.files.push({ ...inspection.entry, exists: true })
    if (inspection.package)
      generated.externalSources.files.push({ ...inspection.package.file, exists: true })
    else {
      // Record absence too: adding package.json can change native resolution on a later attachment.
      const packagePath =
        inspection.entryKind === 'file'
          ? join(dirname(inspection.selectedPath), 'package.json')
          : join(inspection.selectedPath, 'package.json')
      const observation = await observeExternalFile(packagePath)
      if (observation.exists) throw appError('error.pluginChanged')
      generated.externalSources.files.push(observation)
    }
    await observePluginDependencies(generated, plugin.id, [{ ...inspection.entry, exists: true }])
    const path = `plugins/binding-${bindings.length}.mjs`
    generated.files.push({
      path,
      content: [
        `import * as original from ${JSON.stringify(pathToFileURL(inspection.entry.resolvedPath).href)};`,
        `import { bind } from './bridge.mjs';`,
        `const projected = bind(original, ${JSON.stringify(binding)});`,
        ...exports.map(
          (name, index) =>
            `const e${index} = projected[${JSON.stringify(name)}]; export { e${index} as ${JSON.stringify(name)} };`,
        ),
        '',
      ].join('\n'),
    })
    const specifier = pathToFileURL(join(paths.inputs, path)).href
    specifiers.push(
      plugin.options?.kind === 'opencode'
        ? [specifier, structuredClone(plugin.options.config)]
        : specifier,
    )
  }
  generated.files.push(
    { path: planPath, content: JSON.stringify(bindings) + '\n' },
    { path: 'plugins/bridge.mjs', content: bridgeSource },
    {
      path: 'plugins/sentinel.mjs',
      content: `import { sentinel } from './bridge.mjs';\nexport default { id: 'agentmatrix-instance-witness', server(input) { return sentinel(input, ${JSON.stringify(agentName)}); } };\n`,
    },
  )
  specifiers.push(pathToFileURL(join(paths.inputs, 'plugins/sentinel.mjs')).href)
  // Entry/package observations do not establish complete transitive dependency coverage.
  generated.externalSources.coverage = 'partial'
  return specifiers
}

const receiptSchema = z
  .object({
    nonce: z.string().uuid(),
    token: z.string().uuid(),
    pid: z.number().int().positive(),
    cwd: z.string(),
    sentinel: z.literal(true),
    disposed: z.literal(false),
    bindings: z.record(
      z.string(),
      z
        .object({
          identity: z.string(),
          initializers: z
            .array(
              z
                .object({
                  initialized: z.literal(true),
                  configured: z.literal(true),
                  failed: z.literal(false),
                  disposed: z.literal(false),
                })
                .strict(),
            )
            .min(1)
            .max(200),
        })
        .strict(),
    ),
  })
  .strict()

/** Fresh per attachment, after debug readback. A previous process/instance cannot satisfy this gate. */
export async function prepareOpenCodePluginAttachment(manifest: RunInputManifest, paths: RunPaths) {
  if (!manifest.nativePlugins.length) return null
  const fail = (field = 'native.plugins'): never => {
    throw new RuntimeFailure('configuration', field)
  }
  let bindings: z.infer<typeof planSchema>
  try {
    bindings = planSchema.parse(JSON.parse(await readFile(join(paths.inputs, planPath), 'utf8')))
    if (bindings.length !== manifest.nativePlugins.length) return fail()
    for (const [index, plugin] of manifest.nativePlugins.entries()) {
      const binding = bindings[index]!
      const inspection = await inspectOpenCodePlugin(plugin.path)
      if (
        binding.id !== plugin.id ||
        binding.nativeId !== plugin.nativeId ||
        digest({ plugin, inspection, exports: binding.exports }) !== binding.identity
      )
        return fail()
    }
  } catch {
    return fail()
  }
  const nonce = randomUUID()
  const directory = await mkdtemp(join(paths.state, 'plugin-attachment-'))
  let token: string | null = null
  return {
    environment: { AGENT_MATRIX_PLUGIN_NONCE: nonce, AGENT_MATRIX_PLUGIN_RECEIPTS: directory },
    async verify(pid: number | undefined, choices?: SessionConfigOption[] | null) {
      try {
        if (choices) {
          const expected =
            manifest.agent.engineOptions?.kind === 'opencode'
              ? manifest.agent.engineOptions.agent
              : 'build'
          const mode = choices.find((choice) => choice.id === 'mode')
          if (mode?.type !== 'select' || mode.currentValue !== expected)
            return fail('native.plugins.mode')
          const options = mode.options.flatMap((option) =>
            'options' in option ? option.options : [option],
          )
          const description = options.find((option) => option.value === expected)?.description
          const matches = [
            ...(description ?? '').matchAll(
              /\[AgentMatrix plugin instance ([a-f0-9-]{36}):([a-f0-9-]{36})\]/g,
            ),
          ]
          if (matches.length !== 1 || matches[0]![1] !== nonce) return fail('native.plugins.marker')
          token = matches[0]![2]!
        }
        if (!token) return fail('native.plugins.marker')
        const file = await inspectFile(join(directory, `${token}.json`), 512 * 1024, true)
        const receipt = receiptSchema.parse(JSON.parse(file.content!.toString('utf8')))
        if (
          receipt.nonce !== nonce ||
          receipt.token !== token ||
          receipt.pid !== pid ||
          receipt.cwd !== manifest.cwd ||
          Object.keys(receipt.bindings).length !== bindings.length
        )
          return fail('native.plugins.attachment')
        for (const binding of bindings)
          if (receipt.bindings[binding.id]?.identity !== binding.identity)
            return fail('native.plugins.binding')
      } catch (error) {
        if (error instanceof RuntimeFailure) throw error
        return fail('native.plugins.receipt')
      }
    },
    cleanup: () => rm(directory, { recursive: true, force: true }),
  }
}
