import { join } from 'node:path'
import { appError } from '../../shared/errors'
import type { SecretReference } from '../../shared/engines/schema'
import type { RunInputManifest } from '../../shared/engines/run-inputs'
import { RunInputStore } from './run-input-store'
import { baseProcessEnvironment, type ProcessLaunch } from './process/managed-process'

/** Reverify saved inputs and resolve only their explicit references immediately before launch. */
export async function prepareRunLaunch(
  store: RunInputStore,
  id: string,
  resolveSecret: (reference: SecretReference) => Promise<string>,
  sourceEnvironment: NodeJS.ProcessEnv,
): Promise<{ manifest: RunInputManifest; launch: ProcessLaunch }> {
  const manifest = await store.verifyForReuse(id)
  const environment = baseProcessEnvironment(sourceEnvironment)
  const paths = store.paths(id)
  const secrets = new Set<string>()
  const resolved = new Map<string, string>()
  for (const [name, value] of Object.entries(manifest.launch.environment)) {
    if (value.kind === 'literal') environment[name] = value.value
    else if (value.kind === 'input-file' || value.kind === 'input-directory')
      environment[name] = join(paths.inputs, value.path)
    else if (value.kind === 'state-directory') environment[name] = join(paths.state, value.path)
    else {
      const key = JSON.stringify(value.reference)
      let raw = resolved.get(key)
      if (raw === undefined) {
        raw = await resolveSecret(value.reference)
        if (!raw || raw.includes('\0')) throw appError('error.credentialMissing')
        resolved.set(key, raw)
      }
      // Protect native pre-JSON interpolation, including a secret containing another macro.
      const encoded =
        value.encoding === 'json-string'
          ? JSON.stringify(raw).slice(1, -1).replaceAll('{', '\\u007b')
          : raw
      if (manifest.launch.args.some((argument) => argument.includes(raw)))
        throw appError('error.runConfiguration')
      environment[name] = encoded
      secrets.add(raw)
      secrets.add(encoded)
    }
  }
  const redactions = [...secrets]
  if (
    redactions.length > 256 ||
    redactions.some((value) => value.length > 65_536) ||
    redactions.reduce((sum, value) => sum + value.length, 0) > 1_048_576
  )
    throw appError('error.runLimit')
  return {
    manifest,
    launch: {
      executable: manifest.installation.executable,
      args: [...manifest.launch.args],
      cwd: manifest.cwd,
      environment,
      secrets: redactions,
    },
  }
}
