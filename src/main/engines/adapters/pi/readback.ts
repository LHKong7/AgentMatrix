import { z } from 'zod'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { RunInputManifest, RunPaths } from '../../../../shared/engines/run-inputs'
import type { PiClient } from '../../pi/client'
import { RuntimeFailure } from '../../runtime'
import { piApis, piThinking } from './configuration'
import { capturedSkillSources, skillSourcesMatch } from '../../skill-readback'
import type {
  ConfigurationDiagnostic,
  ConfigurationField,
} from '../../../../shared/engines/configuration-report'

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
  let check: ConfigurationDiagnostic['check'] = 'pi-state'
  try {
    const state = piStateSchema.parse(await client.request({ type: 'get_state' }))
    const api = piApis[manifest.connection.protocol as keyof typeof piApis]
    // New captures record the SDK base; earlier captures keep their original literal mapping.
    const nativeBaseUrl =
      manifest.connection.protocol === 'anthropic-messages'
        ? (z
            .object({ nativeBaseUrl: z.string().optional() })
            .parse(JSON.parse(await readFile(join(paths.inputs, 'pi-mappings.json'), 'utf8')))
            .nativeBaseUrl ?? manifest.connection.baseUrl)
        : manifest.connection.baseUrl
    const fields: ConfigurationField[] = []
    if (
      state.model.provider !== `agentmatrix-${manifest.connection.id}` ||
      state.model.api !== api ||
      state.model.baseUrl !== nativeBaseUrl
    )
      fields.push('connection')
    if (state.model.id !== manifest.model.modelId) fields.push('model')
    if (state.thinkingLevel !== piThinking(manifest)) fields.push('reasoning')
    if (
      state.isStreaming ||
      state.isCompacting ||
      state.pendingMessageCount !== 0 ||
      state.autoCompactionEnabled
    )
      fields.push('engine-options')
    if (fields.length)
      throw new RuntimeFailure('configuration', 'pi.native-readback', {
        check,
        reason: 'mismatch',
        fields,
      })
    check = 'pi-skills'
    const commands = z
      .object({
        commands: z
          .array(
            z.object({ name: z.string(), source: z.string(), sourceInfo: z.unknown().optional() }),
          )
          .max(10000),
      })
      .parse(await client.request({ type: 'get_commands' }))
    const expected = (await capturedSkillSources(manifest, paths, 'pi-mappings.json')).map(
      (skill) => ({ ...skill, name: `skill:${skill.name}` }),
    )
    const observed = commands.commands
      .filter((command) => command.source === 'skill')
      .map((command) => ({
        name: command.name,
        path: z.object({ path: z.string().min(1).max(4000) }).parse(command.sourceInfo).path,
      }))
    if (
      !skillSourcesMatch(expected, observed, true) ||
      commands.commands.some(
        (command) =>
          command.source !== 'skill' && expected.some((skill) => skill.name === command.name),
      )
    )
      throw new RuntimeFailure('configuration', 'pi.native-readback', {
        check,
        reason: 'mismatch',
        fields: ['skills'],
      })
    return state
  } catch (error) {
    if (error instanceof RuntimeFailure) throw error
    throw new RuntimeFailure('configuration', 'pi.native-readback', {
      check,
      reason: 'unavailable',
      fields: check === 'pi-skills' ? ['skills'] : [],
    })
  }
}
