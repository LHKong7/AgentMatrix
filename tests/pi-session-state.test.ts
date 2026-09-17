import { randomUUID } from 'node:crypto'
import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rename,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { rememberPiSession, restorePiSession } from '../src/main/engines/adapters/pi/session-state'

const roots: string[] = []
async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'agentmatrix-pi-session-')))
  roots.push(root)
  const paths = { root, state: join(root, 'state'), inputs: join(root, 'inputs') }
  const directory = join(paths.state, 'sessions')
  await mkdir(directory, { recursive: true })
  const manifest = { digest: 'a'.repeat(64), cwd: join(root, 'project') }
  const id = randomUUID(),
    sessionPath = join(directory, 'conversation.jsonl')
  const referencePath = join(paths.state, 'pi-session.json')
  const header = { type: 'session', version: 3, id, cwd: manifest.cwd }
  await writeFile(sessionPath, JSON.stringify(header) + '\n' + 'x'.repeat(100_000))
  await rememberPiSession(paths, manifest, id, sessionPath)
  return { paths, manifest, id, sessionPath, referencePath, header, directory }
}
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})
describe('Pi native session identity', () => {
  it('restores only the captured native conversation and never overwrites its reference', async () => {
    const f = await fixture()
    expect(await restorePiSession(f.paths, f.manifest, f.id)).toMatchObject({
      sessionPath: f.sessionPath,
      reference: { nativeSessionId: f.id, snapshotDigest: f.manifest.digest },
    })
    const before = await readFile(f.referencePath)
    await expect(
      rememberPiSession(f.paths, f.manifest, randomUUID(), f.sessionPath),
    ).rejects.toMatchObject({ code: 'configuration' })
    expect(await readFile(f.referencePath)).toEqual(before)
    await expect(restorePiSession(f.paths, f.manifest, randomUUID())).rejects.toMatchObject({
      code: 'configuration',
    })
    await expect(
      restorePiSession(f.paths, { ...f.manifest, digest: 'b'.repeat(64) }, f.id),
    ).rejects.toMatchObject({ code: 'configuration' })
  })
  it.each(['id', 'cwd'] as const)('rejects a native header with a different %s', async (field) => {
    const f = await fixture()
    await writeFile(
      f.sessionPath,
      JSON.stringify({ ...f.header, [field]: field === 'id' ? randomUUID() : '/other' }) + '\n',
    )
    await expect(restorePiSession(f.paths, f.manifest, f.id)).rejects.toMatchObject({
      code: 'configuration',
    })
  })
  it.each(['missing', 'truncated', 'oversize', 'invalid-utf8'] as const)(
    'rejects a %s native header',
    async (kind) => {
      const f = await fixture()
      if (kind === 'missing') await rm(f.sessionPath)
      else
        await writeFile(
          f.sessionPath,
          kind === 'truncated'
            ? JSON.stringify(f.header)
            : kind === 'oversize'
              ? ' '.repeat(65_537) + JSON.stringify(f.header) + '\n'
              : Buffer.from([255, 10]),
        )
      await expect(restorePiSession(f.paths, f.manifest, f.id)).rejects.toMatchObject({
        code: 'configuration',
      })
    },
  )
  it('rejects path traversal and oversized reference files', async () => {
    const f = await fixture()
    const reference = JSON.parse(await readFile(f.referencePath, 'utf8'))
    await writeFile(
      f.referencePath,
      JSON.stringify({ ...reference, file: '../conversation.jsonl' }),
    )
    await expect(restorePiSession(f.paths, f.manifest, f.id)).rejects.toMatchObject({
      code: 'configuration',
    })
    await writeFile(f.referencePath, ' '.repeat(65_537))
    await expect(restorePiSession(f.paths, f.manifest, f.id)).rejects.toMatchObject({
      code: 'configuration',
    })
  })
  it.skipIf(process.platform === 'win32').each(['reference', 'session', 'directory'] as const)(
    'rejects a symlinked %s',
    async (kind) => {
      const f = await fixture()
      const path =
        kind === 'reference' ? f.referencePath : kind === 'session' ? f.sessionPath : f.directory
      await rename(path, path + '.original')
      await symlink(path + '.original', path)
      await expect(restorePiSession(f.paths, f.manifest, f.id)).rejects.toMatchObject({
        code: 'configuration',
      })
    },
  )
})
