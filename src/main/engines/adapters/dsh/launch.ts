import { constants } from 'node:fs'
import { lstat, mkdir, open, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import type { SecretReference } from '../../../../shared/engines/schema'
import type { RunInputStore } from '../../run-input-store'
import { prepareRunLaunch } from '../../run-launch'
import { RuntimeFailure } from '../../runtime'
import { captureCommand } from '../../process/capture-command'
import { dshContract, parseDshYaml } from './composition'

async function readControl(path: string): Promise<Buffer> {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  try {
    const before = await file.stat()
    if (!before.isFile() || before.size > 4_194_304) throw new Error('Invalid DSH control file')
    const bytes = Buffer.alloc(before.size + 1)
    let offset = 0
    while (offset < bytes.length) {
      const { bytesRead } = await file.read(bytes, offset, bytes.length - offset, offset)
      if (!bytesRead) break
      offset += bytesRead
    }
    const after = await file.stat()
    if (
      offset !== before.size ||
      after.size !== before.size ||
      after.mtimeMs !== before.mtimeMs ||
      after.ctimeMs !== before.ctimeMs
    )
      throw new Error('DSH control changed while reading')
    return bytes.subarray(0, offset)
  } finally {
    await file.close()
  }
}

/** Seed only application-owned profile files; changed native controls are never repaired silently. */
export async function verifyDshHome(
  store: RunInputStore,
  id: string,
  initialize = false,
): Promise<void> {
  try {
    const paths = store.paths(id)
    const marker = join(paths.state, 'dsh-profile-inputs')
    const stamp = (await store.read(id)).digest + '\n'
    const existing = await lstat(marker).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== 'ENOENT') throw error
      return null
    })
    if (existing && (!existing.isFile() || !(await readControl(marker)).equals(Buffer.from(stamp))))
      throw new Error('DSH profile marker changed')
    if (!existing && !initialize) throw new Error('Uninitialized DSH profile')
    const seed = initialize && !existing
    let directory = paths.state
    for (const part of ['dsh', 'profiles', 'agentmatrix']) {
      directory = join(directory, part)
      if (seed)
        await mkdir(directory, { mode: 0o700 }).catch((error: NodeJS.ErrnoException) => {
          if (error.code !== 'EEXIST') throw error
        })
      if (!(await lstat(directory)).isDirectory()) throw new Error('Invalid DSH profile directory')
    }
    for (const name of ['package.json', 'cordis.patch.yml']) {
      const expected = await readFile(join(paths.inputs, 'profile', name))
      const target = join(directory, name)
      if (seed) {
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
      if (!(await readControl(target)).equals(expected)) throw new Error('DSH profile changed')
    }
    for (const name of ['cordis.patch.yml', '.env', 'AGENTS.md']) {
      const path = join(paths.state, 'dsh', name)
      const exists = await lstat(path).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== 'ENOENT') throw error
        return null
      })
      if (exists) throw new Error('Unexpected DSH configuration layer')
    }
    if (!existing) {
      const file = await open(marker, 'wx', 0o600)
      try {
        await file.writeFile(stamp)
        await file.sync()
      } finally {
        await file.close()
      }
    }
  } catch {
    throw new RuntimeFailure('configuration', 'dsh.native-home', {
      check: 'dsh-controls',
      reason: 'changed',
      fields: [],
    })
  }
}

export async function prepareDshLaunch(
  store: RunInputStore,
  id: string,
  resolveSecret: (reference: SecretReference) => Promise<string>,
  environment: NodeJS.ProcessEnv,
  signal: AbortSignal,
) {
  const prepared = await prepareRunLaunch(store, id, resolveSecret, environment)
  const { manifest, launch } = prepared
  if (
    manifest.adapter.id !== dshContract.id ||
    manifest.adapter.version !== dshContract.version ||
    manifest.installation.kind !== 'deepseek-harness' ||
    manifest.installation.version !== dshContract.engineVersion ||
    manifest.launch.mode !== 'acp'
  )
    throw new RuntimeFailure('unsupported', 'installation.version')
  await verifyDshHome(store, id, true)
  if (
    (await captureCommand({ ...launch, args: ['--version'] }, signal)).trim() !==
    dshContract.engineVersion
  )
    throw new RuntimeFailure('configuration', 'installation.version', {
      check: 'installation',
      reason: 'mismatch',
      fields: ['installation'],
    })
  // Dumping composes tagged YAML without evaluating it or starting plugins. This verifies composition, not application.
  const dump = await captureCommand({ ...launch, args: [...launch.args, '--dump-config'] }, signal)
  try {
    const expected = parseDshYaml(
      await readFile(join(store.paths(id).inputs, 'profile/cordis.patch.yml'), 'utf8'),
    ) as { insert: unknown }[]
    if (!isDeepStrictEqual(parseDshYaml(dump), expected[0]?.insert))
      throw new RuntimeFailure('configuration', 'dsh.composition-readback', {
        check: 'dsh-composition',
        reason: 'mismatch',
        fields: [],
      })
  } catch (error) {
    if (error instanceof RuntimeFailure) throw error
    throw new RuntimeFailure('configuration', 'dsh.composition-readback', {
      check: 'dsh-composition',
      reason: 'unavailable',
      fields: [],
    })
  }
  await verifyDshHome(store, id)
  await store.verifyForReuse(id)
  if (signal.aborted) throw new RuntimeFailure('process-exit')
  return prepared
}
