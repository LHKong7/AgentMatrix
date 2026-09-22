import { readFile, realpath } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'
import { z } from 'zod'
import { entityId } from '../../shared/engines/schema'
import {
  inputFileSchema,
  type RunInputManifest,
  type RunPaths,
} from '../../shared/engines/run-inputs'

const mappingSchema = z.object({
  skills: z
    .array(
      z.object({
        assetId: entityId,
        name: z
          .string()
          .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/)
          .max(64),
        path: inputFileSchema.shape.path,
      }),
    )
    .max(1000),
})
export interface CapturedSkillSource {
  assetId: string
  name: string
  inputPath: string
  paths: string[]
}

/** Read only verified adapter input files; native-reported paths are never opened. */
export async function capturedSkillSources(
  manifest: RunInputManifest,
  paths: RunPaths,
  mappingFile: 'opencode-mappings.json' | 'pi-mappings.json' | 'dsh-mappings.json',
): Promise<CapturedSkillSource[]> {
  if (!manifest.files.some((file) => file.path === mappingFile))
    throw new Error('Skill mapping missing')
  const { skills } = mappingSchema.parse(
    JSON.parse(await readFile(join(paths.inputs, mappingFile), 'utf8')),
  )
  if (
    skills.length !== manifest.skills.length ||
    new Set(skills.map((skill) => skill.assetId)).size !== skills.length ||
    new Set(skills.map((skill) => skill.name)).size !== skills.length
  )
    throw new Error('Skill mapping identities differ')
  const result: CapturedSkillSource[] = []
  for (const skill of skills) {
    const entry = `${skill.path}/SKILL.md`
    if (
      !manifest.skills.some((item) => item.assetId === skill.assetId) ||
      !manifest.files.some((file) => file.path === entry)
    )
      throw new Error('Skill input missing')
    const selected = join(paths.inputs, entry)
    result.push({
      assetId: skill.assetId,
      name: skill.name,
      inputPath: entry,
      paths: [selected, await realpath(selected)],
    })
  }
  return result
}

export function skillSourcesMatch(
  expected: CapturedSkillSource[],
  observed: { name: string; path: string }[],
  exclusive: boolean,
): boolean {
  if (exclusive && expected.length !== observed.length) return false
  return expected.every((skill) => {
    const matches = observed.filter((item) => item.name === skill.name)
    const path = matches[0]?.path
    return matches.length === 1 && Boolean(path && isAbsolute(path) && skill.paths.includes(path))
  })
}
