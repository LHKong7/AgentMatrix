import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { z } from 'zod'
import type {
  GeneratedInputs,
  RunInputManifest,
  RunPaths,
} from '../../../../shared/engines/run-inputs'
import type { McpObservation } from '../../../../shared/engines/mcp-observation'
import { RuntimeFailure } from '../../runtime'
import { DshExpression, parseDshYaml, type DshRow } from './composition'
import { inspectDshPluginFramework, prepareDshRowAttachment } from './plugins'
import monitorSource from './plugin-monitor.mjs?raw'

export const dshMcpPlanPath = 'observers/dsh-mcp.json'
export const dshMcpRowId = (id: string) =>
  `agentmatrix-mcp-am-${createHash('sha256').update(id).digest('hex').slice(0, 20)}`
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const planSchema = z
  .object({
    identity: z.string().regex(/^[a-f0-9]{64}$/),
    frameworkDigest: z.string().regex(/^[a-f0-9]{64}$/),
    rowIds: z.array(z.string()).min(1).max(200),
  })
  .strict()

export async function planDshMcpObservation(
  executable: string,
  selected: DshRow[],
  paths: RunPaths,
  generated: GeneratedInputs,
  rows: DshRow[],
) {
  if (!selected.length) return
  const framework = await inspectDshPluginFramework(executable)
  const plan = {
    identity: hash(selected),
    frameworkDigest: hash(framework),
    rowIds: selected.map((row) => row.id),
  }
  rows.push({
    id: 'agentmatrix-mcp-observer',
    name: pathToFileURL(join(paths.inputs, 'observers/dsh-mcp.mjs')).href,
    config: {
      identity: plan.identity,
      rowsJson: JSON.stringify(selected, (_key, value) =>
        value instanceof DshExpression ? { __jsExpr: value.source } : value,
      ),
    },
  })
  generated.externalSources.files.push(...framework.flatMap((component) => component.files))
  generated.files.push(
    { path: dshMcpPlanPath, content: JSON.stringify(plan) + '\n' },
    {
      path: 'observers/dsh-mcp.mjs',
      content: monitorSource.replaceAll('AGENT_MATRIX_DSH_PLUGIN_', 'AGENT_MATRIX_DSH_MCP_'),
    },
  )
}

/** Native async MCP apply must complete under failOnStartupError, with the same active Loader rows. */
export async function prepareDshMcpAttachment(manifest: RunInputManifest, paths: RunPaths) {
  const fail = (): never => {
    throw new RuntimeFailure('configuration', 'dsh.mcp-startup', {
      check: 'dsh-mcp',
      reason: 'unavailable',
      fields: ['mcp'],
    })
  }
  let plan: z.infer<typeof planSchema>
  try {
    plan = planSchema.parse(JSON.parse(await readFile(join(paths.inputs, dshMcpPlanPath), 'utf8')))
    if (
      hash(await inspectDshPluginFramework(manifest.installation.executable)) !==
      plan.frameworkDigest
    )
      return fail()
    const patches = z
      .array(z.object({ insert: z.array(z.looseObject({ id: z.string() })) }))
      .parse(parseDshYaml(await readFile(join(paths.inputs, 'profile/cordis.patch.yml'), 'utf8')))
    const rows = patches.flatMap((patch) => patch.insert)
    const ids = manifest.mcpServers.map((server) => dshMcpRowId(server.id))
    const selected = ids.map((id) => {
      const matches = rows.filter((row) => row.id === id)
      if (matches.length !== 1) return fail()
      const row = matches[0]!
      z.object({
        failOnStartupError: z.literal(true),
        reconnect: z.object({ enabled: z.literal(false) }),
      }).parse(row.config)
      return row
    })
    if (JSON.stringify(ids) !== JSON.stringify(plan.rowIds) || hash(selected) !== plan.identity)
      return fail()
  } catch {
    return fail()
  }
  const attachment = await prepareDshRowAttachment(
    manifest,
    paths,
    plan.identity,
    plan.rowIds,
    'MCP',
  )
  return {
    ...attachment,
    async observe(
      pid: number | undefined,
      signal: AbortSignal,
      sessionId: string,
    ): Promise<McpObservation> {
      await attachment.verify(pid, signal, sessionId)
      return {
        source: 'dsh-mcp-startup',
        checkedAt: new Date().toISOString(),
        statuses: plan.rowIds.map(() => 'startup-complete'),
      }
    },
  }
}
