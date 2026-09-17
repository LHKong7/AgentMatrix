import { appError } from '../shared/errors'
import type { Locale } from '../shared/i18n'
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { randomUUID } from 'node:crypto'
import { createWorkspace, workspaceSchema, type Workspace } from '../shared/workspace'

export class WorkspaceStore {
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

  load(): Promise<Workspace> {
    return this.enqueue(() => this.read())
  }

  save(input: unknown): Promise<Workspace> {
    return this.enqueue(async () => {
      const parsed = workspaceSchema.safeParse(input)
      if (!parsed.success) throw appError('error.invalidData')
      const workspace = parsed.data
      const current = await this.read()
      if (workspace.revision !== current.revision) {
        throw appError('error.conflict')
      }
      const next = { ...workspace, revision: current.revision + 1 }
      await this.write(next)
      return next
    })
  }

  private async read(): Promise<Workspace> {
    let contents: string
    try {
      contents = await readFile(this.filePath, 'utf8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      const initial = createWorkspace(this.initialLocale)
      await this.write(initial)
      return initial
    }
    try {
      return workspaceSchema.parse(JSON.parse(contents))
    } catch {
      // Preserve the original file so invalid or newer configurations can be recovered.
      throw appError('error.unreadable', { path: this.filePath })
    }
  }

  private async write(workspace: Workspace): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true, mode: 0o700 })
    const temporary = `${this.filePath}.${randomUUID()}.tmp`
    try {
      await writeFile(temporary, `${JSON.stringify(workspace, null, 2)}\n`, {
        mode: 0o600,
        flag: 'wx',
      })
      await rename(temporary, this.filePath)
    } finally {
      await unlink(temporary).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== 'ENOENT') throw error
      })
    }
  }
}
