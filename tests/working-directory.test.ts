import { mkdtemp, mkdir, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { resolveWorkingDirectory } from '../src/main/sessions/working-directory'

const roots: string[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})
describe('working directory selection', () => {
  it('rejects missing directories, regular files, and invalid host paths', async () => {
    const root = await mkdtemp(join(tmpdir(), 'agentmatrix-directory-'))
    roots.push(root)
    const file = join(root, 'file.txt')
    await writeFile(file, 'not a directory')
    for (const path of [undefined, '', './project', file, join(root, 'missing'), `${root}\0`])
      await expect(resolveWorkingDirectory(path)).rejects.toThrow('error.runtimeCwd')
    if (process.platform !== 'win32')
      await expect(resolveWorkingDirectory('C:\\project')).rejects.toThrow('error.runtimeCwd')
  })
  it.skipIf(process.platform === 'win32')(
    'resolves directory links and preserves Unicode and spaces',
    async () => {
      const root = await mkdtemp(join(tmpdir(), 'agentmatrix-directory-'))
      roots.push(root)
      const project = join(root, '项目 with spaces')
      const alias = join(root, 'alias')
      await mkdir(project)
      await symlink(project, alias)
      expect(await resolveWorkingDirectory(alias)).toBe(await realpath(project))
    },
  )
})
