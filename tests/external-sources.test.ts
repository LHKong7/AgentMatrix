import { execFile } from 'node:child_process'
import {
  mkdir,
  mkdtemp,
  open,
  realpath,
  rename,
  rm,
  symlink,
  unlink,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  observeResourceDirectory,
  verifyExternalSources,
} from '../src/main/engines/external-sources'
import type { ExternalDirectory } from '../src/shared/engines/run-inputs'

let root: string
beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), 'agentmatrix-resource-sources-')))
})
afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})
const scan = (path = root, kind: ExternalDirectory['kind'] = 'opencode-agent') =>
  observeResourceDirectory(path, kind)
const verify = (directory: ExternalDirectory) =>
  verifyExternalSources({ coverage: 'partial', files: [], directories: [directory] })

describe('native Markdown directory observations', () => {
  it.each(['opencode-agent', 'opencode-command', 'opencode-mode'] as const)(
    'captures only matching files with the native discovery depth: %s',
    async (kind) => {
      await mkdir(join(root, '.nested'))
      for (const name of ['z.md', '.hidden.md', 'ignored.MD', 'ignored.json', '.nested/a.md'])
        await writeFile(join(root, name), 'PRIVATE_MARKDOWN_CONTENT')
      const observed = await scan(root, kind)
      expect(observed.observation.exists).toBe(true)
      if (!observed.observation.exists) throw new Error('Missing observation')
      expect(observed.observation.files.map((file) => file.path)).toEqual(
        (kind === 'opencode-mode'
          ? ['.hidden.md', 'z.md']
          : ['.hidden.md', '.nested/a.md', 'z.md']
        ).map((name) => join(root, name)),
      )
      expect(JSON.stringify(observed)).not.toContain('PRIVATE_MARKDOWN_CONTENT')
      await writeFile(join(root, 'ignored.json'), 'unrelated change')
      await expect(verify(observed)).resolves.toBeUndefined()
    },
  )

  it.each(['add', 'delete', 'rename', 'edit'])(
    'detects a native file %s on re-enumeration',
    async (change) => {
      const file = join(root, 'agent.md')
      await writeFile(file, 'before')
      const observed = await scan()
      if (change === 'add') await writeFile(join(root, 'new.md'), 'new agent')
      if (change === 'delete') await unlink(file)
      if (change === 'rename') await rename(file, join(root, 'renamed.md'))
      if (change === 'edit') await writeFile(file, 'after')
      await expect(verify(observed)).rejects.toThrow('error.runSourceChanged')
    },
  )

  it('does not follow unmatched symlinks during flat Mode discovery', async () => {
    await symlink('cycle', join(root, 'cycle'))
    await writeFile(join(root, 'mode.md'), 'mode')
    const observed = await scan(root, 'opencode-mode')
    expect(observed.observation).toMatchObject({
      files: [{ path: join(root, 'mode.md'), exists: true }],
    })
    await expect(verify(observed)).resolves.toBeUndefined()
  })

  it('records an absent directory and detects its creation, even when empty', async () => {
    const path = join(root, 'agents')
    const observed = await scan(path)
    expect(observed).toEqual({ path, kind: 'opencode-agent', observation: { exists: false } })
    await expect(verify(observed)).resolves.toBeUndefined()
    await mkdir(path)
    await expect(verify(observed)).rejects.toThrow('error.runSourceChanged')
  })

  it('follows linked files and nested directories, recording their targets', async () => {
    const source = join(root, 'source'),
      target = join(root, 'target')
    await mkdir(source)
    await mkdir(target)
    await writeFile(join(target, 'agent.md'), 'first')
    await symlink(target, join(source, 'nested'))
    await symlink(join(target, 'agent.md'), join(source, 'linked.md'))
    const observed = await scan(source)
    if (!observed.observation.exists) throw new Error('Missing observation')
    expect(observed.observation.files).toHaveLength(2)
    for (const file of observed.observation.files)
      expect(file).toMatchObject({ exists: true, resolvedPath: join(target, 'agent.md') })
    await writeFile(join(target, 'agent.md'), 'second')
    await expect(verify(observed)).rejects.toThrow('error.runSourceChanged')
    await writeFile(join(target, 'agent.md'), 'first')
    await expect(verify(observed)).resolves.toBeUndefined()
    await writeFile(join(target, 'copy.md'), 'first')
    await unlink(join(source, 'linked.md'))
    await symlink(join(target, 'copy.md'), join(source, 'linked.md'))
    await expect(verify(observed)).rejects.toThrow('error.runSourceChanged')
  })

  it('detects a directory link retargeted to identical file bytes', async () => {
    for (const name of ['first', 'second']) {
      await mkdir(join(root, name))
      await writeFile(join(root, name, 'agent.md'), 'same')
    }
    const alias = join(root, 'alias')
    await symlink(join(root, 'first'), alias)
    const observed = await scan(alias)
    await unlink(alias)
    await symlink(join(root, 'second'), alias)
    await expect(verify(observed)).rejects.toThrow('error.runSourceChanged')
  })

  it('records a dangling Markdown link and detects later target creation', async () => {
    const missing = join(root, 'missing')
    const link = join(root, 'linked.md')
    await symlink(missing, link)
    const observed = await scan()
    expect(observed.observation).toMatchObject({ files: [{ path: link, exists: false }] })
    await writeFile(missing, 'appeared')
    await expect(verify(observed)).rejects.toThrow('error.runSourceChanged')
  })

  it('rejects recursive directory links and non-directory roots', async () => {
    await symlink(root, join(root, 'cycle'))
    await expect(scan()).rejects.toThrow('error.runIntegrity')
    await writeFile(join(root, 'file'), 'not a directory')
    await expect(scan(join(root, 'file'))).rejects.toThrow('error.runIntegrity')
  })

  it.runIf(process.platform !== 'win32')('rejects a Markdown FIFO without opening it', async () => {
    await promisify(execFile)('mkfifo', [join(root, 'blocked.md')])
    await expect(scan()).rejects.toThrow('error.runIntegrity')
  })

  it('rejects oversized Markdown before hashing its contents', async () => {
    const file = await open(join(root, 'large.md'), 'w')
    try {
      await file.truncate(20_000_001)
    } finally {
      await file.close()
    }
    await expect(scan()).rejects.toThrow('error.runLimit')
  })
})
