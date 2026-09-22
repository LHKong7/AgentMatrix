import { createHash, randomUUID } from 'node:crypto'
import { constants, type BigIntStats } from 'node:fs'
import { lstat, mkdir, open, readdir, realpath, rename, rm } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, sep } from 'node:path'
import { appError } from '../../shared/errors'
import {
  assetRelativePath,
  skillVersionSchema,
  type SkillVersion,
} from '../../shared/engines/workspace'
import type { CapturedSkillDirectory } from '../../shared/engines/skill-import'

export type DirectoryRevision = Extract<SkillVersion, { kind: 'directory' }>
type ManifestFile = DirectoryRevision['files'][number]
type SourceEntry = { path: string; stat: BigIntStats }

export const skillImportLimits = {
  files: 1000,
  fileBytes: 20_000_000,
  totalBytes: 100_000_000,
  depth: 32,
}
const hash = (bytes: Uint8Array | string) => createHash('sha256').update(bytes).digest('hex')
const sortPath = (a: { path: string }, b: { path: string }) =>
  a.path < b.path ? -1 : a.path > b.path ? 1 : 0
function identity(stat: BigIntStats): string {
  return [stat.dev, stat.ino, stat.mode, stat.size, stat.mtimeNs, stat.ctimeNs].join(':')
}
function snapshotDigest(files: ManifestFile[]): string {
  return hash(JSON.stringify(files))
}
function inside(root: string, path: string): boolean {
  const child = relative(root, path)
  return child === '' || (!isAbsolute(child) && child !== '..' && !child.startsWith(`..${sep}`))
}
function portablePath(path: string): boolean {
  return (
    assetRelativePath.safeParse(path).success &&
    path
      .split('/')
      .every(
        (part) =>
          !/[<>"|?*]/.test(part) &&
          ![...part].some((character) => character.charCodeAt(0) < 32) &&
          !/[. ]$/.test(part) &&
          !/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part),
      )
  )
}

/** Private content-addressed captures. Imports never execute a Skill or follow symlinks. */
export class SkillDirectoryStore {
  private queue: Promise<unknown> = Promise.resolve()
  constructor(readonly root: string) {}

  capture(source: string): Promise<CapturedSkillDirectory> {
    const result = this.queue.then(() => this.captureDirectory(source))
    this.queue = result.catch(() => undefined)
    return result
  }

  private async scan(root: string): Promise<SourceEntry[]> {
    const rootStat = await lstat(root, { bigint: true })
    if (!rootStat.isDirectory() || rootStat.isSymbolicLink())
      throw appError('error.skillUnsafePath')
    const entries: SourceEntry[] = [{ path: '', stat: rootStat }]
    const names = new Set<string>()
    let files = 0
    let bytes = 0
    const walk = async (directory: string, depth: number) => {
      if (depth > skillImportLimits.depth) throw appError('error.skillLimit')
      const children = await readdir(join(root, directory), { withFileTypes: true })
      for (const child of children) {
        const path = directory ? `${directory}/${child.name}` : child.name
        const normalized = path.normalize('NFC').toLowerCase()
        if (!portablePath(path) || names.has(normalized)) throw appError('error.skillUnsafePath')
        names.add(normalized)
        // Bound empty-directory walks as well as captured files.
        if (names.size > skillImportLimits.files * 2) throw appError('error.skillLimit')
        const absolute = join(root, path)
        const stat = await lstat(absolute, { bigint: true })
        if (stat.isSymbolicLink() || (!stat.isDirectory() && !stat.isFile()))
          throw appError('error.skillUnsafePath')
        if (!inside(root, await realpath(absolute))) throw appError('error.skillUnsafePath')
        entries.push({ path, stat })
        if (stat.isDirectory()) await walk(path, depth + 1)
        else {
          files += 1
          bytes += Number(stat.size)
          if (
            files > skillImportLimits.files ||
            stat.size > skillImportLimits.fileBytes ||
            bytes > skillImportLimits.totalBytes
          )
            throw appError('error.skillLimit')
        }
      }
    }
    await walk('', 0)
    if (!entries.some((entry) => entry.path === 'SKILL.md' && entry.stat.isFile()))
      throw appError('error.skillEntry')
    return entries.sort(sortPath)
  }

  private async readStable(root: string, entry: SourceEntry): Promise<Buffer> {
    const path = join(root, entry.path)
    if (!inside(root, await realpath(path))) throw appError('error.skillUnsafePath')
    const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
    try {
      const before = await file.stat({ bigint: true })
      if (!before.isFile() || identity(before) !== identity(entry.stat))
        throw appError('error.skillChanged')
      // Bounded reads also handle a source file that grows while it is being copied.
      const contents = Buffer.alloc(Number(before.size) + 1)
      let offset = 0
      while (offset < contents.length) {
        const result = await file.read(contents, offset, contents.length - offset, offset)
        if (!result.bytesRead) break
        offset += result.bytesRead
      }
      if (
        offset !== Number(before.size) ||
        identity(await file.stat({ bigint: true })) !== identity(before)
      )
        throw appError('error.skillChanged')
      return contents.subarray(0, offset)
    } finally {
      await file.close()
    }
  }

  private async writePrivate(path: string, contents: Buffer | string, executable = false) {
    await mkdir(dirname(path), { recursive: true, mode: 0o700 })
    const file = await open(path, 'wx', executable ? 0o700 : 0o600)
    try {
      await file.writeFile(contents)
      await file.sync()
    } finally {
      await file.close()
    }
  }

  private async captureDirectory(source: string): Promise<CapturedSkillDirectory> {
    if (!isAbsolute(source)) throw appError('error.skillUnsafePath')
    const selected = await lstat(source, { bigint: true })
    if (!selected.isDirectory() || selected.isSymbolicLink())
      throw appError('error.skillUnsafePath')
    const sourcePath = await realpath(source)
    await mkdir(this.root, { recursive: true, mode: 0o700 })
    const storageRoot = await realpath(this.root)
    // Avoid recursively capturing this store into itself, even via an ancestor directory.
    if (inside(sourcePath, storageRoot) || inside(storageRoot, sourcePath))
      throw appError('error.skillUnsafePath')
    const entries = await this.scan(sourcePath)
    const stage = join(storageRoot, `.capture-${randomUUID()}`)
    await mkdir(stage, { mode: 0o700 })
    try {
      const files: ManifestFile[] = []
      for (const entry of entries.filter((entry) => entry.stat.isFile())) {
        const contents = await this.readStable(sourcePath, entry)
        if (entry.path === 'SKILL.md') {
          try {
            if (!new TextDecoder('utf-8', { fatal: true }).decode(contents).trim())
              throw new Error('Empty entry')
          } catch {
            throw appError('error.skillEntry')
          }
        }
        const executable = (entry.stat.mode & 0o111n) !== 0n
        files.push({ path: entry.path, sha256: hash(contents), bytes: contents.length, executable })
        await this.writePrivate(join(stage, 'files', entry.path), contents, executable)
      }
      const after = await this.scan(sourcePath)
      if (
        after.length !== entries.length ||
        entries.some(
          (entry, index) =>
            entry.path !== after[index]!.path ||
            identity(entry.stat) !== identity(after[index]!.stat),
        )
      )
        throw appError('error.skillChanged')
      const snapshot: DirectoryRevision = {
        version: 1,
        kind: 'directory',
        digest: snapshotDigest(files),
        files,
      }
      skillVersionSchema.parse(snapshot)
      await this.writePrivate(join(stage, 'manifest.json'), JSON.stringify(snapshot) + '\n')
      const destination = join(storageRoot, snapshot.digest)
      const existing = await lstat(destination).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== 'ENOENT') throw error
        return null
      })
      if (existing) {
        await this.verify(snapshot)
        return { sourcePath, snapshot }
      }
      try {
        await rename(stage, destination)
      } catch (error) {
        if (!['EEXIST', 'ENOTEMPTY'].includes((error as NodeJS.ErrnoException).code ?? ''))
          throw error
        await this.verify(snapshot)
      }
      return { sourcePath, snapshot }
    } finally {
      await rm(stage, { recursive: true, force: true })
    }
  }

  /** Recheck stored bytes before a new binding or future run materialization. Never repair in place. */
  async verify(input: DirectoryRevision): Promise<string> {
    try {
      const parsed = skillVersionSchema.parse(input)
      if (parsed.kind !== 'directory') throw new Error('Invalid directory')
      const snapshot = { ...parsed, version: 1 }
      if (snapshot.digest !== snapshotDigest(snapshot.files)) throw new Error('Invalid digest')
      const directory = join(await realpath(this.root), snapshot.digest)
      if ((await lstat(directory)).isSymbolicLink()) throw new Error('Linked snapshot')
      const manifestStat = await lstat(join(directory, 'manifest.json'), { bigint: true })
      if (!manifestStat.isFile() || manifestStat.isSymbolicLink() || manifestStat.size > 4_000_000n)
        throw new Error('Invalid manifest')
      const manifest = await this.readStable(directory, {
        path: 'manifest.json',
        stat: manifestStat,
      })
      if (JSON.stringify(JSON.parse(manifest.toString('utf8'))) !== JSON.stringify(snapshot))
        throw new Error('Manifest mismatch')
      const filesRoot = join(directory, 'files')
      const entries = (await this.scan(filesRoot)).filter((entry) => entry.stat.isFile())
      if (entries.length !== snapshot.files.length) throw new Error('File count mismatch')
      for (let index = 0; index < entries.length; index++) {
        const entry = entries[index]!
        const expected = snapshot.files[index]!
        const contents = await this.readStable(filesRoot, entry)
        if (
          entry.path !== expected.path ||
          contents.length !== expected.bytes ||
          hash(contents) !== expected.sha256 ||
          (process.platform !== 'win32' &&
            ((entry.stat.mode & 0o111n) !== 0n) !== expected.executable)
        )
          throw new Error('File mismatch')
      }
      return filesRoot
    } catch {
      throw appError('error.skillCaptureInvalid')
    }
  }
}
