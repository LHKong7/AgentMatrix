import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { z } from 'zod'
import type {
  GeneratedInputs,
  RunInputManifest,
  RunPaths,
} from '../../../../shared/engines/run-inputs'
import { capturedSkillSources, skillSourcesMatch } from '../../skill-readback'
import { RuntimeFailure } from '../../runtime'
import { prepareOpenCodeInstanceHttp, type OpenCodeInstanceCheck } from './instance-http'

export const openCodeSkillPlanPath = 'observers/opencode-skills.json'
const identityOf = (names: string[], agentName: string) =>
  createHash('sha256').update(JSON.stringify({ names, agentName })).digest('hex')
const planSchema = z
  .object({
    identity: z.string(),
    names: z.array(z.string()).min(1).max(1000),
    agentName: z.string(),
  })
  .strict()

export function planOpenCodeSkillObservation(
  names: string[],
  agentName: string,
  generated: GeneratedInputs,
): void {
  if (!names.length) return
  generated.files.push({
    path: openCodeSkillPlanPath,
    content: JSON.stringify({ identity: identityOf(names, agentName), names, agentName }) + '\n',
  })
}

/** Validate the captured Skill plan before creating any listener credentials. */
export async function prepareOpenCodeSkillCheck(
  manifest: RunInputManifest,
  paths: RunPaths,
): Promise<OpenCodeInstanceCheck> {
  const fail = (reason: 'mismatch' | 'unavailable' = 'unavailable'): never => {
    throw new RuntimeFailure('configuration', 'native.instance-skills', {
      check: 'opencode-instance-skills',
      reason,
      fields: ['skills'],
    })
  }
  let expected: Awaited<ReturnType<typeof capturedSkillSources>>
  try {
    expected = await capturedSkillSources(manifest, paths, 'opencode-mappings.json')
    const plan = planSchema.parse(
      JSON.parse(await readFile(join(paths.inputs, openCodeSkillPlanPath), 'utf8')),
    )
    const names = expected.map((skill) => skill.name)
    const agentName =
      manifest.agent.engineOptions?.kind === 'opencode'
        ? manifest.agent.engineOptions.agent
        : 'build'
    if (
      plan.identity !== identityOf(names, agentName) ||
      plan.agentName !== agentName ||
      JSON.stringify(plan.names) !== JSON.stringify(names)
    )
      return fail()
  } catch {
    return fail()
  }
  const sourcesSchema = z
    .array(z.object({ name: z.string().max(1000), location: z.string().max(4000) }))
    .max(10000)
  return {
    check: 'opencode-instance-skills',
    fields: ['skills'],
    async observe(read) {
      const sources = sourcesSchema.parse(await read('/skill'))
      if (
        !skillSourcesMatch(
          expected,
          sources.map((skill) => ({ name: skill.name, path: skill.location })),
          false,
        )
      )
        return fail('mismatch')
    },
  }
}

/** Skill-only legacy captures keep their original observation contract. */
export async function prepareOpenCodeSkillAttachment(manifest: RunInputManifest, paths: RunPaths) {
  return prepareOpenCodeInstanceHttp(manifest.cwd, [
    await prepareOpenCodeSkillCheck(manifest, paths),
  ])
}
