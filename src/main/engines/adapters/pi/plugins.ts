import { createHash, randomUUID } from 'node:crypto'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { z } from 'zod'
import type {
  GeneratedInputs,
  RunInputManifest,
  RunPaths,
} from '../../../../shared/engines/run-inputs'
import type { ResolvedAgentConfiguration } from '../../../../shared/engines/resolution'
import { appError } from '../../../../shared/errors'
import { inspectFile } from '../../installed-plugin-files'
import { pluginEngineRangeStatus } from '../../plugin-engine-range'
import type { PiClient } from '../../pi/client'
import { RuntimeFailure } from '../../runtime'
import { inspectPiPlugin, piPluginInspectionSchema } from './plugin-inspection'
import bridgeSource from './plugin-bridge.mjs?raw'

const bindingSchema = z
  .object({
    id: z.string(),
    identity: z.string().regex(/^[a-f0-9]{64}$/),
    inspection: piPluginInspectionSchema,
    entries: z
      .array(z.object({ path: z.string(), command: z.string(), entry: z.string() }).strict())
      .min(1)
      .max(100),
  })
  .strict()
const planSchema = z.array(bindingSchema).max(200)
const planPath = 'plugins/pi-bindings.json'
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex')

export async function planPiPlugins(
  configuration: ResolvedAgentConfiguration,
  paths: RunPaths,
  generated: GeneratedInputs,
) {
  if (!configuration.nativePlugins.length) return
  const bindings: z.infer<typeof planSchema> = []
  const seen = new Set<string>()
  for (const plugin of configuration.nativePlugins) {
    const inspection = await inspectPiPlugin(plugin.path)
    if (inspection.packageVersion && inspection.packageVersion !== plugin.version)
      throw appError('error.pluginVersion')
    if (
      inspection.engineRanges.some(
        (range) => pluginEngineRangeStatus(range, configuration.installation) !== 'matched',
      )
    )
      throw appError('error.piPluginRange')
    const identity = digest({ plugin, inspection })
    const entries: z.infer<typeof bindingSchema>['entries'] = []
    for (const [index, entry] of inspection.entries.entries()) {
      if (seen.has(entry.resolvedPath)) throw appError('error.pluginDuplicate')
      seen.add(entry.resolvedPath)
      const path = `plugins/pi-${bindings.length + 1}-${index + 1}.ts`
      const item = {
        path,
        entry: entry.resolvedPath,
        command: `agentmatrix-witness-${bindings.length + 1}-${index + 1}`,
      }
      entries.push(item)
      generated.files.push({
        path,
        content: [
          `import factory from ${JSON.stringify(entry.resolvedPath)};`,
          `import { activate } from './pi-bridge.js';`,
          `export default async function (api) { return activate(factory, api, ${JSON.stringify({ ...item, identity })}); }`,
          '',
        ].join('\n'),
      })
      generated.launch.args.push('--extension', join(paths.inputs, path))
    }
    generated.externalSources.files.push(...inspection.entries, inspection.packageFile)
    bindings.push({ id: plugin.id, identity, inspection, entries })
  }
  generated.files.push(
    { path: planPath, content: JSON.stringify(bindings) + '\n' },
    { path: 'plugins/pi-bridge.js', content: bridgeSource },
  )
  generated.externalSources.coverage = 'partial'
}

const commandSchema = z.object({
  commands: z.array(
    z.object({ name: z.string(), source: z.string(), description: z.string().optional() }),
  ),
})
const receiptSchema = z
  .object({
    nonce: z.uuid(),
    token: z.uuid(),
    pid: z.number().int().positive(),
    identity: z.string(),
    entry: z.string(),
    initialized: z.literal(true),
    failed: z.literal(false),
    handled: z.number().int().nonnegative().safe(),
    session: z
      .object({
        id: z.string(),
        file: z.string(),
        cwd: z.string(),
        ready: z.literal(true),
        shutdown: z.literal(false),
      })
      .strict(),
  })
  .strict()
export interface PiPluginSession {
  sessionId: string
  sessionFile: string
}

export async function preparePiPluginAttachment(manifest: RunInputManifest, paths: RunPaths) {
  if (!manifest.nativePlugins.length) return null
  const fail = (): never => {
    throw new RuntimeFailure('configuration', 'pi.plugins')
  }
  let bindings: z.infer<typeof planSchema>
  try {
    bindings = planSchema.parse(JSON.parse(await readFile(join(paths.inputs, planPath), 'utf8')))
    if (bindings.length !== manifest.nativePlugins.length) return fail()
    for (const [index, plugin] of manifest.nativePlugins.entries()) {
      const inspection = await inspectPiPlugin(plugin.path)
      if (
        bindings[index]!.id !== plugin.id ||
        bindings[index]!.identity !== digest({ plugin, inspection })
      )
        return fail()
    }
  } catch {
    return fail()
  }
  const nonce = randomUUID()
  const directory = await mkdtemp(join(paths.state, 'pi-plugin-attachment-'))
  return {
    environment: {
      AGENT_MATRIX_PI_PLUGIN_NONCE: nonce,
      AGENT_MATRIX_PI_PLUGIN_RECEIPTS: directory,
    },
    async verify(
      client: Pick<PiClient, 'request'>,
      pid: number | undefined,
      session: PiPluginSession,
    ) {
      try {
        const { commands } = commandSchema.parse(await client.request({ type: 'get_commands' }))
        let handled = 0
        for (const binding of bindings)
          for (const entry of binding.entries) {
            const witnesses = commands.filter(
              (command) => command.source === 'extension' && command.name === entry.command,
            )
            if (witnesses.length !== 1) return fail()
            const match = /^AgentMatrix extension instance ([a-f0-9-]{36}):([a-f0-9-]{36})$/.exec(
              witnesses[0]!.description ?? '',
            )
            if (!match || match[1] !== nonce) return fail()
            const file = await inspectFile(join(directory, `${match[2]}.json`), 64 * 1024, true)
            const receipt = receiptSchema.parse(JSON.parse(file.content!.toString('utf8')))
            if (
              receipt.nonce !== nonce ||
              receipt.token !== match[2] ||
              receipt.pid !== pid ||
              receipt.identity !== binding.identity ||
              receipt.entry !== entry.entry ||
              receipt.session.id !== session.sessionId ||
              receipt.session.file !== session.sessionFile ||
              receipt.session.cwd !== manifest.cwd
            )
              return fail()
            handled += receipt.handled
          }
        return handled
      } catch {
        return fail()
      }
    },
    cleanup: () => rm(directory, { recursive: true, force: true }),
  }
}
