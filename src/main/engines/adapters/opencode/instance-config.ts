import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { z } from 'zod'
import type {
  GeneratedInputs,
  RunInputManifest,
  RunPaths,
} from '../../../../shared/engines/run-inputs'
import { RuntimeFailure } from '../../runtime'
import {
  capturedOpenCodeConfiguration,
  configurationMismatch,
  openCodeMismatchFields,
} from './readback'
import { prepareOpenCodeInstanceHttp, type OpenCodeInstanceCheck } from './instance-http'
import { matchOpenCodeOverrideSources } from './override-sources'
import { openCodeSkillPlanPath, prepareOpenCodeSkillCheck } from './skills'

export const openCodeConfigPlanPath = 'observers/opencode-config.json'
const planSchema = z.object({ version: z.literal(1) }).strict()

export function planOpenCodeConfigurationObservation(generated: GeneratedInputs): void {
  generated.files.push({ path: openCodeConfigPlanPath, content: '{"version":1}\n' })
}

/** Configuration and Skills share one owned listener, secret and session-scoped read window. */
export async function prepareOpenCodeConfigurationAttachment(
  manifest: RunInputManifest,
  paths: RunPaths,
  environment: NodeJS.ProcessEnv,
) {
  let expected: unknown
  try {
    planSchema.parse(JSON.parse(await readFile(join(paths.inputs, openCodeConfigPlanPath), 'utf8')))
    expected = await capturedOpenCodeConfiguration(manifest, paths, environment)
  } catch {
    throw new RuntimeFailure('configuration', 'native.instance-config', {
      check: 'opencode-instance-config',
      reason: 'unavailable',
      fields: [],
    })
  }
  const config: OpenCodeInstanceCheck = {
    check: 'opencode-instance-config',
    fields: [],
    async observe(read) {
      const actual = z.record(z.string(), z.unknown()).parse(await read('/config'))
      if (configurationMismatch(expected, actual) !== null)
        throw new RuntimeFailure('configuration', 'native.instance-config', {
          check: 'opencode-instance-config',
          reason: 'mismatch',
          fields: openCodeMismatchFields(expected, actual),
          sourceMatches: await matchOpenCodeOverrideSources(manifest, expected, actual),
        })
    },
  }
  const skills = manifest.files.some((file) => file.path === openCodeSkillPlanPath)
    ? [await prepareOpenCodeSkillCheck(manifest, paths)]
    : []
  return prepareOpenCodeInstanceHttp(manifest.cwd, [config, ...skills])
}
