import { createHash, randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'
import { mkdtemp, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { setTimeout as pause } from 'node:timers/promises'
import { satisfies, validRange } from 'semver'
import { z } from 'zod'
import type { ResolvedAgentConfiguration } from '../../../../shared/engines/resolution'
import {
  externalFileSchema,
  type GeneratedInputs,
  type RunInputManifest,
  type RunPaths,
} from '../../../../shared/engines/run-inputs'
import { appError } from '../../../../shared/errors'
import { inspectFile } from '../../installed-plugin-files'
import { RuntimeFailure } from '../../runtime'
import type { DshRow } from './composition'
import { dshPluginInspectionSchema, inspectDshPlugin } from './plugin-inspection'
import monitorSource from './plugin-monitor.mjs?raw'

export const dshPluginFrameworkVersions = {
  '@deepseek-ai/dsh': '0.1.5-rc.2',
  '@deepseek-ai/dsh-app-boot': '0.1.5-rc.2',
  '@deepseek-ai/dsh-acp': '0.1.5-rc.2',
  '@deepseek-ai/cordis': '4.0.2',
  '@deepseek-ai/cordis-plugin-loader': '1.0.3',
  '@deepseek-ai/cordis-plugin-include': '1.0.7',
} as const
const frameworkSchema = z
  .array(
    z
      .object({
        name: z.string(),
        version: z.string(),
        files: z.array(externalFileSchema).length(2),
      })
      .strict(),
  )
  .length(6)
const bindingSchema = z
  .object({ id: z.string(), rowId: z.string(), inspection: dshPluginInspectionSchema })
  .strict()
const planSchema = z
  .object({
    identity: z.string(),
    bindings: z.array(bindingSchema).min(1).max(200),
    framework: frameworkSchema,
  })
  .strict()
const planPath = 'plugins/dsh-bindings.json'
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex')

export async function inspectDshPluginFramework(executable: string) {
  try {
    const require = createRequire(await realpath(executable))
    const result: z.infer<typeof frameworkSchema> = []
    for (const [name, version] of Object.entries(dshPluginFrameworkVersions)) {
      const path =
        name === '@deepseek-ai/dsh'
          ? join(await realpath(executable), '../../package.json')
          : require.resolve(`${name}/package.json`)
      const manifest = await inspectFile(path, 256 * 1024, true)
      const pkg = z
        .object({ name: z.string(), version: z.string() })
        .parse(JSON.parse(manifest.content!.toString('utf8')))
      if (pkg.name !== name || pkg.version !== version)
        throw new Error('Unverified framework version')
      const entry = await inspectFile(
        name === '@deepseek-ai/dsh' ? executable : require.resolve(name),
        20_000_000,
        false,
      )
      result.push({
        name,
        version,
        files: [
          { ...manifest.observation, exists: true },
          { ...entry.observation, exists: true },
        ],
      })
    }
    return result
  } catch {
    throw appError('error.dshPluginFramework')
  }
}
export async function planDshPlugins(
  configuration: ResolvedAgentConfiguration,
  paths: RunPaths,
  generated: GeneratedInputs,
  rows: DshRow[],
) {
  if (!configuration.nativePlugins.length) return
  const framework = await inspectDshPluginFramework(configuration.installation.executable)
  const bindings: z.infer<typeof bindingSchema>[] = []
  const selected: DshRow[] = []
  const ids = new Set([...rows.map((row) => row.id), 'agentmatrix-plugins'])
  for (const plugin of configuration.nativePlugins) {
    if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,99}$/.test(plugin.nativeId) || ids.has(plugin.nativeId))
      throw appError('error.dshPluginId')
    ids.add(plugin.nativeId)
    const inspection = await inspectDshPlugin(plugin.path)
    if (inspection.packageVersion && inspection.packageVersion !== plugin.version)
      throw appError('error.pluginVersion')
    for (const [name, version] of Object.entries(dshPluginFrameworkVersions)) {
      const range = inspection.peerDependencies[name]
      if (range !== undefined && (!validRange(range) || !satisfies(version, range)))
        throw appError('error.dshPluginRange')
    }
    bindings.push({ id: plugin.id, rowId: plugin.nativeId, inspection })
    selected.push({
      id: plugin.nativeId,
      name: pathToFileURL(inspection.entry.resolvedPath).href,
      config: plugin.options?.config ?? {},
    })
    generated.externalSources.files.push(inspection.entry, ...inspection.metadata)
  }
  const identity = hash({ plugins: configuration.nativePlugins, bindings, framework })
  rows.push(...selected, {
    id: 'agentmatrix-plugins',
    name: pathToFileURL(join(paths.inputs, 'plugins/dsh-monitor.mjs')).href,
    config: { identity, rows: structuredClone(selected) },
  })
  generated.files.push(
    { path: planPath, content: JSON.stringify({ identity, bindings, framework }) + '\n' },
    { path: 'plugins/dsh-monitor.mjs', content: monitorSource },
  )
  generated.externalSources.files.push(...framework.flatMap((component) => component.files))
  // The native dependencies and dynamic resources are not a captured package installation.
  generated.externalSources.coverage = 'partial'
}
const receiptSchema = z
  .object({
    nonce: z.uuid(),
    challenge: z.uuid(),
    pid: z.number().int().positive(),
    identity: z.string(),
    cwd: z.string(),
    ready: z.boolean(),
    healthy: z.boolean(),
    session: z.object({ id: z.uuid(), cwd: z.string() }).strict().nullable(),
    plugins: z
      .array(z.object({ id: z.string(), uid: z.number().int().positive().nullable() }).strict())
      .max(200),
  })
  .strict()

export async function prepareDshPluginAttachment(manifest: RunInputManifest, paths: RunPaths) {
  if (!manifest.nativePlugins.length) return null
  const fail = (): never => {
    throw new RuntimeFailure('configuration', 'dsh.plugins')
  }
  let plan: z.infer<typeof planSchema>
  try {
    plan = planSchema.parse(JSON.parse(await readFile(join(paths.inputs, planPath), 'utf8')))
    const framework = await inspectDshPluginFramework(manifest.installation.executable)
    const bindings = []
    for (const plugin of manifest.nativePlugins)
      bindings.push({
        id: plugin.id,
        rowId: plugin.nativeId,
        inspection: await inspectDshPlugin(plugin.path),
      })
    if (plan.identity !== hash({ plugins: manifest.nativePlugins, bindings, framework }))
      return fail()
  } catch {
    return fail()
  }
  return prepareDshRowAttachment(
    manifest,
    paths,
    plan.identity,
    plan.bindings.map((binding) => binding.rowId),
    'PLUGIN',
  )
}

/** Fresh challenge receipts for active native Loader rows, shared by plugins and MCP components. */
export async function prepareDshRowAttachment(
  manifest: RunInputManifest,
  paths: RunPaths,
  identity: string,
  rowIds: string[],
  channel: 'PLUGIN' | 'MCP',
) {
  const field = channel === 'MCP' ? 'dsh.mcp-startup' : 'dsh.plugins'
  const fail = (): never => {
    throw new RuntimeFailure(
      'configuration',
      field,
      channel === 'MCP' ? { check: 'dsh-mcp', reason: 'unavailable', fields: ['mcp'] } : undefined,
    )
  }
  const directory = await mkdtemp(join(paths.state, `dsh-${channel.toLowerCase()}-attachment-`))
  const nonce = randomUUID()
  return {
    environment: {
      [`AGENT_MATRIX_DSH_${channel}_NONCE`]: nonce,
      [`AGENT_MATRIX_DSH_${channel}_RECEIPTS`]: directory,
    },
    async verify(
      pid: number | undefined,
      signal: AbortSignal,
      sessionId: string | null,
      waitForBoot = false,
    ) {
      const deadline = Date.now() + 30_000
      try {
        if (!pid) return fail()
        for (;;) {
          if (signal.aborted) throw new RuntimeFailure('process-exit')
          if (Date.now() >= deadline) {
            if (channel === 'MCP') return fail()
            throw new RuntimeFailure('timeout', field)
          }
          const challenge = randomUUID(),
            target = join(directory, `${challenge}.json`)
          const request = join(directory, 'request.json')
          await writeFile(`${request}.tmp`, JSON.stringify({ nonce, challenge, sessionId }), {
            mode: 0o600,
          })
          await rename(`${request}.tmp`, request)
          let receipt: z.infer<typeof receiptSchema> | undefined
          while (!receipt) {
            if (signal.aborted) throw new RuntimeFailure('process-exit')
            if (Date.now() >= deadline) {
              if (channel === 'MCP') return fail()
              throw new RuntimeFailure('timeout', field)
            }
            try {
              const file = await inspectFile(target, 128 * 1024, true)
              receipt = receiptSchema.parse(JSON.parse(file.content!.toString('utf8')))
            } catch (error) {
              if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
            }
            if (!receipt) await pause(20, undefined, { signal })
          }
          await rm(target)
          if (
            receipt.nonce !== nonce ||
            receipt.challenge !== challenge ||
            receipt.pid !== pid ||
            receipt.identity !== identity ||
            receipt.cwd !== manifest.cwd
          )
            return fail()
          if (!receipt.ready && waitForBoot) {
            await pause(30, undefined, { signal })
            continue
          }
          if (
            !receipt.ready ||
            !receipt.healthy ||
            receipt.plugins.length !== rowIds.length ||
            receipt.plugins.some((plugin, index) => plugin.id !== rowIds[index] || !plugin.uid) ||
            new Set(receipt.plugins.map((plugin) => plugin.uid)).size !== receipt.plugins.length ||
            (sessionId === null
              ? receipt.session !== null
              : receipt.session?.id !== sessionId || receipt.session.cwd !== manifest.cwd)
          )
            return fail()
          return
        }
      } catch (error) {
        if (error instanceof RuntimeFailure) throw error
        if (signal.aborted) throw new RuntimeFailure('process-exit')
        return fail()
      }
    },
    cleanup: () => rm(directory, { recursive: true, force: true }),
  }
}
