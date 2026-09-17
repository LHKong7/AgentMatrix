import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { z } from 'zod'
import type { RunInputManifest, RunPaths } from '../../../../shared/engines/run-inputs'
import type { PiClient } from '../../pi/client'
import { RuntimeFailure } from '../../runtime'
import { piApis, piThinking } from './configuration'

export const piStateSchema = z.looseObject({
  model: z.looseObject({
    id: z.string(),
    provider: z.string(),
    api: z.string(),
    baseUrl: z.string(),
  }),
  thinkingLevel: z.string(),
  sessionId: z.string().min(1).max(1000),
  sessionFile: z.string().min(1),
  isStreaming: z.boolean(),
  isCompacting: z.boolean(),
  pendingMessageCount: z.number().int().nonnegative(),
  autoCompactionEnabled: z.boolean(),
})
/** A correct model name alone is insufficient: native API, endpoint, thinking, and Skill discovery must agree. */
export async function verifyPiReadback(
  client: PiClient,
  manifest: RunInputManifest,
  paths: RunPaths,
) {
  try {
    const state = piStateSchema.parse(await client.request({ type: 'get_state' }))
    const api = piApis[manifest.connection.protocol as keyof typeof piApis]
    if (
      state.model.id !== manifest.model.modelId ||
      state.model.provider !== `agentmatrix-${manifest.connection.id}` ||
      state.model.api !== api ||
      state.model.baseUrl !== manifest.connection.baseUrl ||
      state.thinkingLevel !== piThinking(manifest) ||
      state.isStreaming ||
      state.isCompacting ||
      state.pendingMessageCount !== 0 ||
      state.autoCompactionEnabled
    )
      throw new Error('Unexpected native state')
    const commands = z
      .object({ commands: z.array(z.looseObject({ name: z.string(), source: z.string() })) })
      .parse(await client.request({ type: 'get_commands' }))
    const mappings = z
      .object({ skills: z.array(z.object({ name: z.string() })) })
      .parse(JSON.parse(await readFile(join(paths.inputs, 'pi-mappings.json'), 'utf8')))
    const expected = mappings.skills.map((skill) => `skill:${skill.name}`).sort()
    const observed = commands.commands
      .filter((command) => command.source === 'skill')
      .map((command) => command.name)
      .sort()
    if (
      expected.length !== observed.length ||
      expected.some((name, index) => name !== observed[index])
    )
      throw new Error('Unexpected native Skills')
    return state
  } catch {
    throw new RuntimeFailure('configuration', 'pi.native-readback')
  }
}
