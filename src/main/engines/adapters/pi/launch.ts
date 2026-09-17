import { constants } from 'node:fs'
import { createHash } from 'node:crypto'
import { lstat, open, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import type { RunInputStore } from '../../run-input-store'
import { prepareRunLaunch } from '../../run-launch'
import { captureCommand } from '../../process/capture-command'
import type { SecretReference } from '../../../../shared/engines/schema'
import { RuntimeFailure } from '../../runtime'
import { piContract } from './configuration'

/** Pi owns a writable home. Its launch controls are copied once and checked, never silently reset. */
export async function verifyPiHome(
  store: RunInputStore,
  id: string,
  initialize = false,
): Promise<void> {
  const paths = store.paths(id)
  const home = join(paths.state, 'pi')
  try {
    if (!(await lstat(home)).isDirectory()) throw new Error('Invalid Pi home')
    const templates = new Map<string, Buffer>()
    const digest = createHash('sha256')
    for (const name of ['models.json', 'settings.json', 'auth.json', 'trust.json']) {
      const bytes = await readFile(join(paths.inputs, 'pi-home', name))
      templates.set(name, bytes)
      digest.update(name).update(bytes)
    }
    const marker = join(home, '.agentmatrix-inputs')
    const stamp = digest.digest('hex') + '\n'
    const initialized = await lstat(marker).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== 'ENOENT') throw error
      return null
    })
    if (
      initialized &&
      (!initialized.isFile() ||
        initialized.size !== stamp.length ||
        (await readFile(marker, 'utf8')) !== stamp)
    )
      throw new Error('Invalid Pi initialization marker')
    if (!initialized && !initialize) throw new Error('Uninitialized Pi home')
    for (const [name, expected] of templates) {
      const target = join(home, name)
      if (initialize && !initialized) {
        const file = await open(target, 'wx', 0o600).catch((error: NodeJS.ErrnoException) => {
          if (error.code !== 'EEXIST') throw error
          return null
        })
        if (file) {
          try {
            await file.writeFile(expected)
            await file.sync()
          } finally {
            await file.close()
          }
        }
      }
      const file = await open(
        target,
        constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
      )
      try {
        const stat = await file.stat()
        if (!stat.isFile() || stat.size > 4_194_304) throw new Error('Invalid Pi configuration')
        const bytes = Buffer.alloc(stat.size + 1)
        let offset = 0
        while (offset < bytes.length) {
          const { bytesRead } = await file.read(bytes, offset, bytes.length - offset, offset)
          if (!bytesRead) break
          offset += bytesRead
        }
        const after = await file.stat()
        if (
          offset !== stat.size ||
          after.size !== stat.size ||
          after.mtimeMs !== stat.mtimeMs ||
          after.ctimeMs !== stat.ctimeMs
        )
          throw new Error('Pi configuration changed while reading')
        if (
          !isDeepStrictEqual(
            JSON.parse(bytes.subarray(0, offset).toString('utf8')),
            JSON.parse(expected.toString('utf8')),
          )
        )
          throw new Error('Pi configuration changed')
      } finally {
        await file.close()
      }
    }
    // These files would introduce uncaptured native instructions even with extension discovery disabled.
    for (const name of [
      'SYSTEM.md',
      'APPEND_SYSTEM.md',
      'AGENTS.override.md',
      'AGENTS.md',
      'AGENTS.MD',
      'CLAUDE.md',
      'CLAUDE.MD',
    ]) {
      const file = await lstat(join(home, name)).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== 'ENOENT') throw error
        return null
      })
      if (file) throw new Error('Unexpected Pi instruction source')
    }
    if (!initialized) {
      const file = await open(marker, 'wx', 0o600)
      try {
        await file.writeFile(stamp)
        await file.sync()
      } finally {
        await file.close()
      }
    }
  } catch {
    throw new RuntimeFailure('configuration', 'pi.native-home')
  }
}

export async function preparePiLaunch(
  store: RunInputStore,
  id: string,
  resolveSecret: (reference: SecretReference) => Promise<string>,
  environment: NodeJS.ProcessEnv,
  signal: AbortSignal,
) {
  const prepared = await prepareRunLaunch(store, id, resolveSecret, environment)
  const { manifest, launch } = prepared
  if (
    manifest.adapter.id !== piContract.id ||
    manifest.adapter.version !== piContract.version ||
    manifest.installation.kind !== 'pi' ||
    manifest.installation.version !== piContract.engineVersion ||
    manifest.launch.mode !== 'pi-rpc'
  )
    throw new RuntimeFailure('unsupported', 'installation.version')
  await verifyPiHome(store, id, true)
  const version = (
    await captureCommand(
      { ...launch, args: [...manifest.installation.prefixArgs, '--version'] },
      signal,
    )
  ).trim()
  if (version !== piContract.engineVersion)
    throw new RuntimeFailure('configuration', 'installation.version')
  await store.verifyForReuse(id)
  if (signal.aborted) throw new RuntimeFailure('process-exit')
  return prepared
}
