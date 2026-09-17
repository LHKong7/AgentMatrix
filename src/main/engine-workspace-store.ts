import { createHash, randomUUID } from 'node:crypto'
import { link, mkdir, open, readFile, rename, unlink } from 'node:fs/promises'
import { dirname } from 'node:path'
import { createWorkspace } from '../shared/workspace'
import { appError } from '../shared/errors'
import type { Locale } from '../shared/i18n'
import { migrateWorkspaceDocument } from '../shared/engines/migration'
import { engineWorkspaceSchema, type EngineWorkspace } from '../shared/engines/workspace'

/** Schema v2 persistence. Activate with the v2 editors; never run alongside a v1 writer. */
export class EngineWorkspaceStore {
  private queue: Promise<unknown> = Promise.resolve()
  constructor(
    readonly filePath: string,
    private readonly initialLocale: Locale = 'en',
  ) {}
  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.queue.then(operation)
    this.queue = result.catch(() => undefined)
    return result
  }
  load(): Promise<EngineWorkspace> {
    return this.enqueue(() => this.read())
  }
  save(input: unknown): Promise<EngineWorkspace> {
    return this.enqueue(async () => {
      const parsed = engineWorkspaceSchema.safeParse(input)
      if (!parsed.success) throw appError('error.invalidData')
      const current = await this.read()
      if (parsed.data.revision !== current.revision) throw appError('error.conflict')
      this.validateHistory(current, parsed.data)
      const next = { ...parsed.data, revision: current.revision + 1 }
      await this.write(next)
      return next
    })
  }
  private validateHistory(current: EngineWorkspace, next: EngineWorkspace) {
    for (const collection of ['prompts', 'skills'] as const) {
      for (const prior of current[collection]) {
        const updated = next[collection].find((asset) => asset.id === prior.id)
        // Deleting a library asset is allowed once bindings are removed. Run snapshots own their copies.
        if (!updated) continue
        const priorMax = Math.max(...prior.versions.map((version) => version.version))
        for (const revision of prior.versions) {
          const retained = updated.versions.find((version) => version.version === revision.version)
          if (JSON.stringify(retained) !== JSON.stringify(revision))
            throw appError('error.assetHistory')
        }
        for (const revision of updated.versions) {
          if (
            revision.version <= priorMax &&
            !prior.versions.some((version) => version.version === revision.version)
          )
            throw appError('error.assetHistory')
        }
      }
    }
  }
  private async read(): Promise<EngineWorkspace> {
    let contents: string
    try {
      contents = await readFile(this.filePath, 'utf8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      const initial = migrateWorkspaceDocument(createWorkspace(this.initialLocale)).workspace
      await this.write(initial)
      return initial
    }
    let converted: ReturnType<typeof migrateWorkspaceDocument>
    try {
      converted = migrateWorkspaceDocument(JSON.parse(contents))
    } catch {
      throw appError('error.unreadable', { path: this.filePath })
    }
    if (converted.migrated) {
      await this.backup(contents)
      await this.write(converted.workspace)
    }
    return converted.workspace
  }
  private async backup(contents: string) {
    const digest = createHash('sha256').update(contents).digest('hex')
    const backup = `${this.filePath}.v1.${digest}.bak`
    const temporary = `${backup}.${randomUUID()}.tmp`
    try {
      const file = await open(temporary, 'wx', 0o600)
      try {
        await file.writeFile(contents)
        await file.sync()
      } finally {
        await file.close()
      }
      // Publish only a complete backup, without replacing an existing backup on retry.
      try {
        await link(temporary, backup)
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
        if ((await readFile(backup, 'utf8')) !== contents) throw appError('error.migrationBackup')
      }
    } finally {
      await unlink(temporary).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== 'ENOENT') throw error
      })
    }
  }
  private async write(workspace: EngineWorkspace) {
    await mkdir(dirname(this.filePath), { recursive: true, mode: 0o700 })
    const temporary = `${this.filePath}.${randomUUID()}.tmp`
    try {
      const file = await open(temporary, 'wx', 0o600)
      try {
        await file.writeFile(JSON.stringify(workspace, null, 2) + '\n')
        await file.sync()
      } finally {
        await file.close()
      }
      await rename(temporary, this.filePath)
    } finally {
      await unlink(temporary).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== 'ENOENT') throw error
      })
    }
  }
}
