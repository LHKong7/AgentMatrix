import { createHash, randomUUID } from 'node:crypto'
import { constants, type BigIntStats } from 'node:fs'
import { lstat, mkdir, open, opendir, realpath, rename, rm } from 'node:fs/promises'
import { dirname, isAbsolute, join } from 'node:path'
import { appError } from '../../shared/errors'
import { entityId } from '../../shared/engines/schema'
import {
  resolveAgentProfile,
  type ResolvedAgentConfiguration,
} from '../../shared/engines/resolution'
import type { EngineWorkspace } from '../../shared/engines/workspace'
import {
  generatedInputsSchema,
  inputFileSchema,
  runInputManifestSchema,
  type GeneratedInputs,
  type RunInputManifest,
  type RunPaths,
} from '../../shared/engines/run-inputs'
import { SkillDirectoryStore } from '../assets/skill-directory-store'
import { observeExternalFile, verifyExternalSources } from './external-sources'
import { RunDataCleanup } from './run-data-cleanup'
import type { RunDataQuery, RunDataRemoval } from '../../shared/sessions/run-data'
export { observeExternalFile } from './external-sources'

const maximumFile = 20_000_000
const maximumTotal = 256 * 1024 * 1024
const maximumManifest = 16 * 1024 * 1024
const maximumDepth = 64
const maximumEntries = 16384
const hash = (bytes: Uint8Array | string) => createHash('sha256').update(bytes).digest('hex')
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (value !== null && typeof value === 'object')
    return `{${Object.entries(value)
      .filter(([, item]) => item !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`)
      .join(',')}}`
  return JSON.stringify(value)
}
const identity = (stat: BigIntStats) =>
  [stat.dev, stat.ino, stat.size, stat.mode, stat.mtimeNs, stat.ctimeNs].join(':')
function portable(path: string) {
  if (
    !inputFileSchema.shape.path.safeParse(path).success ||
    path.split('/').length > maximumDepth ||
    path
      .split('/')
      .some(
        (part) =>
          /[<>"|?*]/.test(part) ||
          /[. ]$/.test(part) ||
          /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part) ||
          [...part].some((char) => char.charCodeAt(0) < 32),
      )
  )
    throw appError('error.runPath')
}
async function regularFile(path: string, limit: number): Promise<Buffer> {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  try {
    const before = await file.stat({ bigint: true })
    if (!before.isFile() || before.size > limit) throw appError('error.runIntegrity')
    const bytes = Buffer.alloc(Number(before.size) + 1)
    let offset = 0
    while (offset < bytes.length) {
      const read = await file.read(bytes, offset, bytes.length - offset, offset)
      if (!read.bytesRead) break
      offset += read.bytesRead
    }
    if (
      offset !== Number(before.size) ||
      identity(before) !== identity(await file.stat({ bigint: true }))
    )
      throw appError('error.runIntegrity')
    return bytes.subarray(0, offset)
  } finally {
    await file.close()
  }
}

/** Publish once, verify before launch/resume, and keep mutable native state outside frozen inputs. */
export class RunInputStore {
  private queue: Promise<unknown> = Promise.resolve()
  private readonly cleanup: RunDataCleanup
  constructor(
    readonly root: string,
    private readonly skills: SkillDirectoryStore,
  ) {
    if (!isAbsolute(root)) throw appError('error.runPath')
    this.cleanup = new RunDataCleanup(root, (id) => this.read(id))
  }

  unused(referenced: ReadonlySet<string>, query: RunDataQuery) {
    const operation = this.queue.then(() => this.cleanup.list(referenced, query))
    this.queue = operation.catch(() => {})
    return operation
  }
  removeUnused(query: RunDataRemoval, referenced: ReadonlySet<string>) {
    const operation = this.queue.then(() => this.cleanup.remove(query, referenced))
    this.queue = operation.catch(() => {})
    return operation
  }

  paths(id: string): RunPaths {
    entityId.parse(id)
    const root = join(this.root, id)
    return { root, inputs: join(root, 'inputs'), state: join(root, 'state') }
  }

  /** Only the retention coordinator may release an unreferenced, inactive capture. */
  remove(id: string): Promise<void> {
    const path = this.paths(id).root
    const operation = this.queue.then(async () => {
      for (const directory of [this.root, path]) {
        const info = await lstat(directory).catch((error: NodeJS.ErrnoException) => {
          if (error.code !== 'ENOENT') throw error
          return null
        })
        if (!info) return
        if (!info.isDirectory() || info.isSymbolicLink()) throw appError('error.runIntegrity')
      }
      // rm does not traverse links inside native state. External resources are never removed.
      await rm(path, { recursive: true, force: true })
      const directory = await open(this.root, constants.O_RDONLY)
      try {
        await directory.sync()
      } finally {
        await directory.close()
      }
    })
    this.queue = operation.catch(() => {})
    return operation
  }

  create(
    id: string,
    workspace: EngineWorkspace,
    agentId: string,
    generate: (
      configuration: ResolvedAgentConfiguration,
      paths: RunPaths,
    ) => Promise<GeneratedInputs>,
  ): Promise<RunInputManifest> {
    // Resolve immediately so later library edits cannot race an asynchronous materialization.
    const revision = workspace.revision
    const resolution = resolveAgentProfile(workspace, agentId)
    if (resolution.status !== 'resolved') return Promise.reject(appError('error.runConfiguration'))
    const operation = this.queue.then(() =>
      this.materialize(id, revision, resolution.configuration, generate),
    )
    this.queue = operation.catch(() => {})
    return operation
  }

  private async materialize(
    id: string,
    workspaceRevision: number,
    configuration: ResolvedAgentConfiguration,
    generate: (
      configuration: ResolvedAgentConfiguration,
      paths: RunPaths,
    ) => Promise<GeneratedInputs>,
  ): Promise<RunInputManifest> {
    const paths = this.paths(id)
    await mkdir(this.root, { recursive: true, mode: 0o700 })
    await this.cleanup.assertAvailable(id)
    const existing = await lstat(paths.root).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== 'ENOENT') throw error
      return null
    })
    if (existing) throw appError('error.runExists')
    if (
      configuration.installation.platform !== process.platform ||
      !configuration.installation.version
    )
      throw appError('error.runConfiguration')
    const cwd = await realpath(configuration.agent.execution.cwd)
    if (!(await lstat(cwd)).isDirectory()) throw appError('error.runConfiguration')
    const executable = await observeExternalFile(configuration.installation.executable)
    if (!executable.exists || !executable.bytes) throw appError('error.runConfiguration')
    const generated = generatedInputsSchema.parse(
      await generate(structuredClone(configuration), paths),
    )
    if (!configuration.installation.modes.includes(generated.launch.mode))
      throw appError('error.runConfiguration')
    for (const [assets, targets] of [
      [configuration.prompts, generated.promptPaths],
      [configuration.skills, generated.skillPaths],
    ] as const) {
      if (
        Object.keys(targets).length !== assets.length ||
        assets.some((asset) => !Object.hasOwn(targets, asset.assetId))
      )
        throw appError('error.runConfiguration')
    }
    const stage = join(this.root, `.stage-${randomUUID()}`)
    await mkdir(join(stage, 'inputs'), { recursive: true, mode: 0o700 })
    const files: RunInputManifest['files'] = []
    const occupied = new Map<string, string>()
    let total = 0
    const add = async (path: string, content: Buffer | string, executable = false) => {
      portable(path)
      const parts = path.split('/')
      for (let index = 1; index <= parts.length; index++) {
        const entry = parts.slice(0, index).join('/')
        const key = entry.normalize('NFC').toLowerCase()
        const previous = occupied.get(key)
        const directory = index < parts.length
        if (previous && (previous !== `directory:${entry}` || !directory))
          throw appError('error.runPath')
        occupied.set(key, `${directory ? 'directory' : 'file'}:${entry}`)
        if (occupied.size > maximumEntries) throw appError('error.runLimit')
      }
      const bytes = typeof content === 'string' ? Buffer.from(content) : content
      total += bytes.length
      if (bytes.length > maximumFile || total > maximumTotal || files.length >= 4096)
        throw appError('error.runLimit')
      const target = join(stage, 'inputs', path)
      await mkdir(dirname(target), { recursive: true, mode: 0o700 })
      const file = await open(target, 'wx', executable ? 0o700 : 0o600)
      try {
        await file.writeFile(bytes)
        await file.sync()
      } finally {
        await file.close()
      }
      files.push({ path, sha256: hash(bytes), bytes: bytes.length, executable })
    }
    try {
      for (const prompt of configuration.prompts)
        await add(generated.promptPaths[prompt.assetId]!, prompt.content)
      for (const skill of configuration.skills) {
        const target = generated.skillPaths[skill.assetId]!
        portable(target)
        if (skill.revision.kind === 'markdown')
          await add(`${target}/SKILL.md`, skill.revision.content)
        else {
          const captured = await this.skills.verify(skill.revision)
          for (const entry of skill.revision.files) {
            const bytes = await regularFile(join(captured, entry.path), maximumFile)
            if (hash(bytes) !== entry.sha256 || bytes.length !== entry.bytes)
              throw appError('error.runIntegrity')
            await add(`${target}/${entry.path}`, bytes, entry.executable)
          }
        }
      }
      for (const file of generated.files) await add(file.path, file.content, file.executable)
      for (const value of Object.values(generated.launch.environment)) {
        if (value.kind === 'input-file' && !files.some((file) => file.path === value.path))
          throw appError('error.runConfiguration')
        if (value.kind === 'input-directory') {
          portable(value.path)
          if (!files.some((file) => file.path.startsWith(`${value.path}/`)))
            throw appError('error.runConfiguration')
        }
        if (value.kind === 'state-directory') {
          portable(value.path)
          await mkdir(join(stage, 'state', value.path), { recursive: true, mode: 0o700 })
        }
      }
      await verifyExternalSources(generated.externalSources)
      // Recheck the selected executable too; a binary update during preparation invalidates the plan.
      if (
        canonical(await observeExternalFile(configuration.installation.executable)) !==
          canonical(executable) ||
        (await realpath(configuration.agent.execution.cwd)) !== cwd ||
        !(await lstat(cwd)).isDirectory()
      )
        throw appError('error.runSourceChanged')
      const manifest = runInputManifestSchema.parse({
        schemaVersion: 1,
        id,
        createdAt: new Date().toISOString(),
        workspaceRevision,
        adapter: generated.adapter,
        agent: configuration.agent,
        installation: configuration.installation,
        executable: {
          path: executable.resolvedPath,
          sha256: executable.sha256,
          bytes: executable.bytes,
        },
        cwd,
        connection: configuration.connection,
        model: configuration.model,
        mcpServers: configuration.mcpServers,
        nativePlugins: configuration.nativePlugins,
        prompts: configuration.prompts.map((prompt) => ({
          assetId: prompt.assetId,
          version: prompt.version,
          mode: prompt.mode,
          source: prompt.source,
          path: generated.promptPaths[prompt.assetId],
        })),
        skills: configuration.skills.map((skill) => ({
          assetId: skill.assetId,
          version: skill.revision.version,
          name: skill.name,
          source: skill.source,
          path: generated.skillPaths[skill.assetId],
          directoryDigest: skill.revision.kind === 'directory' ? skill.revision.digest : null,
        })),
        launch: generated.launch,
        externalSources: generated.externalSources,
        files: files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0)),
        digest: '0'.repeat(64),
      })
      manifest.digest = manifestDigest(manifest)
      const contents = JSON.stringify(manifest, null, 2) + '\n'
      if (Buffer.byteLength(contents) > maximumManifest) throw appError('error.runLimit')
      const record = await open(join(stage, 'manifest.json'), 'wx', 0o600)
      try {
        await record.writeFile(contents)
        await record.sync()
      } finally {
        await record.close()
      }
      await mkdir(join(stage, 'state'), { recursive: true, mode: 0o700 })
      // A second check also catches destinations created while an adapter was preparing inputs.
      if (
        await lstat(paths.root).catch((error: NodeJS.ErrnoException) => {
          if (error.code !== 'ENOENT') throw error
          return null
        })
      )
        throw appError('error.runExists')
      await rename(stage, paths.root)
      return manifest
    } finally {
      await rm(stage, { recursive: true, force: true })
    }
  }

  async read(id: string): Promise<RunInputManifest> {
    const paths = this.paths(id)
    await this.cleanup.assertAvailable(id)
    try {
      if (!(await lstat(paths.root)).isDirectory() || !(await lstat(paths.inputs)).isDirectory())
        throw appError('error.runIntegrity')
      const manifest = runInputManifestSchema.parse(
        JSON.parse(
          new TextDecoder('utf-8', { fatal: true }).decode(
            await regularFile(join(paths.root, 'manifest.json'), maximumManifest),
          ),
        ),
      )
      if (
        manifest.id !== id ||
        manifestDigest(manifest) !== manifest.digest ||
        manifest.files.reduce((sum, file) => sum + file.bytes, 0) > maximumTotal
      )
        throw appError('error.runIntegrity')
      const actual = new Set<string>()
      const names = new Set<string>()
      const walk = async (directory: string) => {
        for await (const entry of await opendir(join(paths.inputs, directory))) {
          const path = directory ? `${directory}/${entry.name}` : entry.name
          portable(path)
          const key = path.normalize('NFC').toLowerCase()
          if (names.has(key)) throw appError('error.runIntegrity')
          names.add(key)
          if (names.size > maximumEntries) throw appError('error.runIntegrity')
          const stat = await lstat(join(paths.inputs, path))
          if (stat.isDirectory()) await walk(path)
          else if (stat.isFile()) actual.add(path)
          else throw appError('error.runIntegrity')
          if (actual.size > 4096) throw appError('error.runIntegrity')
        }
      }
      await walk('')
      if (actual.size !== manifest.files.length) throw appError('error.runIntegrity')
      for (const file of manifest.files) {
        portable(file.path)
        if (!actual.delete(file.path)) throw appError('error.runIntegrity')
        const bytes = await regularFile(join(paths.inputs, file.path), maximumFile)
        if (bytes.length !== file.bytes || hash(bytes) !== file.sha256)
          throw appError('error.runIntegrity')
        if (
          process.platform !== 'win32' &&
          Boolean((await lstat(join(paths.inputs, file.path))).mode & 0o111) !== file.executable
        )
          throw appError('error.runIntegrity')
      }
      return manifest
    } catch {
      throw appError('error.runIntegrity')
    }
  }

  async verifyForReuse(id: string): Promise<RunInputManifest> {
    const manifest = await this.read(id)
    if (manifest.installation.platform !== process.platform)
      throw appError('error.runConfiguration')
    try {
      const executable = await observeExternalFile(manifest.installation.executable)
      if (
        !executable.exists ||
        executable.resolvedPath !== manifest.executable.path ||
        executable.sha256 !== manifest.executable.sha256 ||
        (await realpath(manifest.agent.execution.cwd)) !== manifest.cwd ||
        !(await lstat(manifest.cwd)).isDirectory()
      )
        throw appError('error.runSourceChanged')
      await verifyExternalSources(manifest.externalSources)
    } catch {
      throw appError('error.runSourceChanged')
    }
    try {
      const statePath = this.paths(id).state
      if (!(await lstat(statePath)).isDirectory()) throw appError('error.runIntegrity')
      for (const value of Object.values(manifest.launch.environment)) {
        if (value.kind === 'state-directory') {
          portable(value.path)
          const parts = value.path.split('/')
          for (let length = 1; length <= parts.length; length++)
            if (!(await lstat(join(statePath, ...parts.slice(0, length)))).isDirectory())
              throw appError('error.runIntegrity')
        }
      }
    } catch {
      throw appError('error.runIntegrity')
    }
    return manifest
  }
}

function manifestDigest(manifest: RunInputManifest): string {
  return hash(
    canonical(Object.fromEntries(Object.entries(manifest).filter(([key]) => key !== 'digest'))),
  )
}
