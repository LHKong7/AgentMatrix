import { createHash, randomUUID } from 'node:crypto'
import { link, mkdir, open, readFile, rename, unlink } from 'node:fs/promises'
import { dirname } from 'node:path'
import { appError } from '../shared/errors'
import type { Locale } from '../shared/i18n'
import { migrateWorkspaceDocument } from '../shared/engines/migration'
import { engineWorkspaceSchema, type EngineWorkspace } from '../shared/engines/workspace'
import { createInitialEngineWorkspace, validateAssetHistory } from '../shared/engines/editing'
import {
  fingerprintFor,
  mergeEvidence,
  type EvidenceKind,
  type EvidenceSubject,
} from '../shared/engines/evidence'
import { sha256Hex } from '../shared/digest'
import type { DirectoryRevision } from './assets/skill-directory-store'
import type { NativeImportRecord } from '../shared/engines/native-import'
import { isDeepStrictEqual } from 'node:util'

function keepObservations(
  current: EngineWorkspace['evidence'],
  next: EngineWorkspace,
): EngineWorkspace['evidence'] {
  const present: Record<EvidenceSubject['kind'], Set<string>> = {
    installation: new Set(next.installations.map((item) => item.id)),
    connection: new Set(next.connections.map((item) => item.id)),
    binding: new Set(next.engineBindings.map((item) => item.id)),
    agent: new Set(next.agents.map((item) => item.id)),
  }
  const kept = current.filter(
    (record) =>
      !next.evidence.some((item) => item.id === record.id) &&
      present[record.subject.kind].has(record.subject.id),
  )
  return [...next.evidence, ...kept]
}

/** Active schema v2 persistence, including atomic migration of the legacy document. */
export class EngineWorkspaceStore {
  private queue: Promise<unknown> = Promise.resolve()
  constructor(
    readonly filePath: string,
    private readonly initialLocale: Locale = 'en',
    private readonly verifyDirectory?: (revision: DirectoryRevision) => Promise<unknown>,
    private readonly verifyNativeImport?: (record: NativeImportRecord) => Promise<unknown>,
  ) {}
  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.queue.then(operation)
    this.queue = result.catch(() => undefined)
    return result
  }
  load(): Promise<EngineWorkspace> {
    return this.enqueue(() => this.read())
  }
  /**
   * Files one observation about the workspace as it stands.
   *
   * The fingerprint is the caller's record of the state it observed. A workspace that has moved on
   * since keeps nothing: the observation applied to a configuration that is no longer the one
   * saved, and it is dropped rather than transferred to the new one. Filing does not advance the
   * revision, because nobody edited anything.
   */
  observe(entry: {
    subject: EvidenceSubject
    kind: EvidenceKind
    result: 'pass' | 'fail'
    fingerprint: string
    adapterVersion: string
    detail?: string
  }): Promise<void> {
    return this.enqueue(async () => {
      const current = await this.read()
      if (fingerprintFor(current, entry.subject) !== entry.fingerprint) return
      const evidence = mergeEvidence(current.evidence, {
        // One stable record per subject and kind, so repeated sessions replace rather than pile up.
        id: `e-${sha256Hex(`${entry.subject.kind}/${entry.subject.id}/${entry.kind}`).slice(0, 32)}`,
        subject: entry.subject,
        kind: entry.kind,
        result: entry.result,
        observedAt: new Date().toISOString(),
        adapterVersion: entry.adapterVersion,
        fingerprint: entry.fingerprint,
        detail: entry.detail ?? '',
      })
      await this.write(engineWorkspaceSchema.parse({ ...current, evidence }))
    })
  }
  save(input: unknown): Promise<EngineWorkspace> {
    return this.enqueue(async () => {
      const parsed = engineWorkspaceSchema.safeParse(input)
      if (!parsed.success) throw appError('error.invalidData')
      const current = await this.read()
      if (parsed.data.revision !== current.revision) throw appError('error.conflict')
      for (const record of current.nativeImports ?? [])
        if (
          !isDeepStrictEqual(
            record,
            parsed.data.nativeImports?.find((item) => item.id === record.id),
          )
        )
          throw appError('error.nativeImportHistory')
      for (const record of parsed.data.nativeImports ?? []) {
        if (current.nativeImports?.some((item) => item.id === record.id)) continue
        if (!this.verifyNativeImport) throw appError('error.nativeImportArchive')
        await this.verifyNativeImport(record)
      }
      validateAssetHistory(current, parsed.data)
      for (const skill of parsed.data.skills) {
        const previous = current.skills.find((item) => item.id === skill.id)
        for (const revision of skill.versions) {
          if (
            revision.kind !== 'directory' ||
            previous?.versions.some((item) => item.version === revision.version)
          )
            continue
          if (!this.verifyDirectory) throw appError('error.skillCaptureInvalid')
          await this.verifyDirectory(revision)
        }
      }
      const next = {
        ...parsed.data,
        // Observations are filed by the main process while a session runs. A save prepared before
        // one arrived must not delete it, but a subject the save removed takes its records along.
        evidence: keepObservations(current.evidence, parsed.data),
        revision: current.revision + 1,
      }
      await this.write(next)
      return next
    })
  }
  private async read(): Promise<EngineWorkspace> {
    let contents: Buffer
    try {
      contents = await readFile(this.filePath)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      const initial = createInitialEngineWorkspace(this.initialLocale)
      await this.write(initial)
      return initial
    }
    let converted: ReturnType<typeof migrateWorkspaceDocument>
    try {
      converted = migrateWorkspaceDocument(
        JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(contents)),
      )
    } catch {
      throw appError('error.unreadable', { path: this.filePath })
    }
    if (converted.migrated) {
      await this.backup(contents, converted.from)
      await this.write(converted.workspace)
    }
    return converted.workspace
  }
  private async backup(contents: Buffer, schemaVersion: number) {
    const digest = createHash('sha256').update(contents).digest('hex')
    const backup = `${this.filePath}.v${schemaVersion}.${digest}.bak`
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
        if (!(await readFile(backup)).equals(contents)) throw appError('error.migrationBackup')
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
