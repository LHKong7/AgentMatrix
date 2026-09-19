import { createHash, randomUUID } from 'node:crypto'
import { mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { setTimeout as pause } from 'node:timers/promises'
import { pathToFileURL } from 'node:url'
import { z } from 'zod'
import type {
  GeneratedInputs,
  RunInputManifest,
  RunPaths,
} from '../../../../shared/engines/run-inputs'
import { capturedSkillSources, skillSourcesMatch } from '../../skill-readback'
import { inspectFile } from '../../installed-plugin-files'
import { RuntimeFailure } from '../../runtime'
import type { DshRow } from './composition'
import monitorSource from './skill-monitor.mjs?raw'

export const dshSkillPlanPath = 'observers/dsh-skills.json'
const identityOf = (names: string[]) =>
  createHash('sha256').update(JSON.stringify(names)).digest('hex')
const planSchema = z
  .object({ identity: z.string(), names: z.array(z.string()).min(1).max(1000) })
  .strict()

export function planDshSkillObservation(
  names: string[],
  paths: RunPaths,
  generated: GeneratedInputs,
  rows: DshRow[],
) {
  if (!names.length) return
  const plan = { identity: identityOf(names), names }
  rows.push({
    id: 'agentmatrix-skill-sources',
    name: pathToFileURL(join(paths.inputs, 'observers/dsh-skills.mjs')).href,
    config: plan,
  })
  generated.files.push(
    { path: dshSkillPlanPath, content: JSON.stringify(plan) + '\n' },
    { path: 'observers/dsh-skills.mjs', content: monitorSource },
  )
}

const receiptSchema = z
  .object({
    nonce: z.uuid(),
    challenge: z.uuid(),
    pid: z.number().int().positive(),
    identity: z.string(),
    cwd: z.string(),
    ready: z.boolean(),
    session: z.object({ id: z.uuid(), cwd: z.string() }).strict().nullable(),
    sources: z
      .array(
        z
          .object({
            name: z.string().max(64),
            path: z.string().max(4000),
            provider: z.string().max(1000),
            source: z.string().max(1000),
          })
          .strict(),
      )
      .max(1000)
      .nullable(),
  })
  .strict()

/** Legacy captures have no observer and must never gain a source-verification receipt. */
export async function prepareDshSkillAttachment(manifest: RunInputManifest, paths: RunPaths) {
  const fail = (reason: 'mismatch' | 'unavailable' = 'unavailable'): never => {
    throw new RuntimeFailure('configuration', 'dsh.skill-source', {
      check: 'dsh-skills',
      reason,
      fields: ['skills'],
    })
  }
  let expected, plan
  try {
    expected = await capturedSkillSources(manifest, paths, 'dsh-mappings.json')
    plan = planSchema.parse(
      JSON.parse(await readFile(join(paths.inputs, dshSkillPlanPath), 'utf8')),
    )
    const names = expected.map((skill) => skill.name)
    if (plan.identity !== identityOf(names) || JSON.stringify(plan.names) !== JSON.stringify(names))
      return fail()
  } catch {
    return fail()
  }
  const directory = await mkdtemp(join(paths.state, 'dsh-skill-attachment-'))
  const nonce = randomUUID()
  return {
    environment: {
      AGENT_MATRIX_DSH_SKILL_NONCE: nonce,
      AGENT_MATRIX_DSH_SKILL_RECEIPTS: directory,
    },
    async verify(pid: number | undefined, signal: AbortSignal, sessionId: string) {
      const deadline = Date.now() + 30_000
      try {
        if (!pid) return fail()
        for (;;) {
          if (signal.aborted) throw new RuntimeFailure('process-exit')
          if (Date.now() >= deadline) return fail()
          const challenge = randomUUID(),
            target = join(directory, `${challenge}.json`),
            request = join(directory, 'request.json')
          await writeFile(`${request}.tmp`, JSON.stringify({ nonce, challenge, sessionId }), {
            mode: 0o600,
          })
          await rename(`${request}.tmp`, request)
          let receipt: z.infer<typeof receiptSchema> | undefined
          while (!receipt) {
            if (signal.aborted) throw new RuntimeFailure('process-exit')
            if (Date.now() >= deadline) return fail()
            try {
              const file = await inspectFile(target, 4_194_304, true)
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
            receipt.identity !== plan.identity ||
            receipt.cwd !== manifest.cwd
          )
            return fail()
          if (!receipt.ready) {
            await pause(30, undefined, { signal })
            continue
          }
          if (
            receipt.session?.id !== sessionId ||
            receipt.session.cwd !== manifest.cwd ||
            !receipt.sources
          )
            return fail()
          if (
            receipt.sources.some(
              (skill) => skill.provider !== 'filesystem' || skill.source !== 'custom',
            ) ||
            !skillSourcesMatch(expected, receipt.sources, true)
          )
            return fail('mismatch')
          return
        }
      } catch (error) {
        if (signal.aborted) throw new RuntimeFailure('process-exit')
        if (error instanceof RuntimeFailure) throw error
        return fail()
      }
    },
    cleanup: () => rm(directory, { recursive: true, force: true }),
  }
}
