import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { z } from 'zod'
import type { RunInputManifest, RunPaths } from '../../../../shared/engines/run-inputs'
import type { ProcessLaunch } from '../../process/managed-process'
import { captureCommand } from '../../process/capture-command'
import { RuntimeFailure } from '../../runtime'
import { capturedSkillSources, skillSourcesMatch } from '../../skill-readback'
import { configurationMismatch, openCodeMismatchFields } from './configuration-mismatch'
import { matchOpenCodeOverrideSources } from './override-sources'
export { configurationMismatch, openCodeMismatchFields } from './configuration-mismatch'

/** This preflight observes a separate native process, not the ACP instance's resource cache. */
export async function verifyOpenCodeSkillReadback(
  manifest: RunInputManifest,
  paths: RunPaths,
  launch: ProcessLaunch,
  signal: AbortSignal,
): Promise<void> {
  try {
    const expected = await capturedSkillSources(manifest, paths, 'opencode-mappings.json')
    if (!expected.length) return
    const native = z
      .array(z.object({ name: z.string().max(1000), location: z.string().max(4000) }))
      .max(10000)
      .parse(
        JSON.parse(
          await captureCommand(
            {
              ...launch,
              args: [...manifest.installation.prefixArgs, 'debug', 'skill'],
            },
            signal,
          ),
        ),
      )
    if (
      !skillSourcesMatch(
        expected,
        native.map((skill) => ({ name: skill.name, path: skill.location })),
        false,
      )
    )
      throw new RuntimeFailure('configuration', 'native.skill-source', {
        check: 'opencode-skills',
        reason: 'mismatch',
        fields: ['skills'],
      })
  } catch (error) {
    if (error instanceof RuntimeFailure && error.diagnostic) throw error
    if (signal.aborted) throw new RuntimeFailure('process-exit')
    throw new RuntimeFailure('configuration', 'native.skill-source', {
      check: 'opencode-skills',
      reason: 'unavailable',
      fields: ['skills'],
    })
  }
}

/** Compare in memory only: native config readback can include plaintext credentials. */
export async function verifyOpenCodeReadback(
  manifest: RunInputManifest,
  paths: RunPaths,
  launch: ProcessLaunch,
  signal: AbortSignal,
): Promise<void> {
  const prefix = manifest.installation.prefixArgs
  const version = (
    await captureCommand({ ...launch, args: [...prefix, '--version'] }, signal)
  ).trim()
  if (version !== manifest.installation.version)
    throw new RuntimeFailure('configuration', 'installation.version', {
      check: 'installation',
      reason: 'mismatch',
      fields: ['installation'],
    })
  try {
    const expected = await capturedOpenCodeConfiguration(manifest, paths, launch.environment)
    const actual: unknown = JSON.parse(
      await captureCommand({ ...launch, args: [...prefix, 'debug', 'config'] }, signal),
    )
    // The path is intentionally not copied from untrusted native objects into diagnostics.
    if (configurationMismatch(expected, actual) !== null)
      throw new RuntimeFailure('configuration', 'native.override', {
        check: 'opencode-config',
        reason: 'mismatch',
        fields: openCodeMismatchFields(expected, actual),
        sourceMatches: await matchOpenCodeOverrideSources(manifest, expected, actual, signal),
      })
  } catch (error) {
    if (error instanceof RuntimeFailure) throw error
    throw new RuntimeFailure('configuration', 'native.readback', {
      check: 'opencode-config',
      reason: 'unavailable',
      fields: [],
    })
  }
}

/** Resolve only captured generated inputs using the already prepared, JSON-encoded child environment. */
export async function capturedOpenCodeConfiguration(
  manifest: RunInputManifest,
  paths: RunPaths,
  environment: NodeJS.ProcessEnv,
): Promise<unknown> {
  let text = await readFile(join(paths.inputs, 'opencode.json'), 'utf8')
  text = text.replace(/\{env:([^}]+)\}/g, (_match, name: string) => {
    if (!Object.hasOwn(environment, name)) throw new RuntimeFailure('configuration')
    return environment[name]!
  })
  // Expand only known copied Prompt references; native/user files cannot be read here.
  for (const match of [...text.matchAll(/\{file:([^}]+)\}/g)]) {
    const path = match[1]!.replace(/^\.\//, '')
    if (!manifest.prompts.some((prompt) => prompt.path === path))
      throw new RuntimeFailure('configuration')
    const value = (await readFile(join(paths.inputs, path), 'utf8')).trim()
    text = text.replace(match[0], () => JSON.stringify(value).slice(1, -1))
  }
  return JSON.parse(text) as unknown
}
