import { randomUUID } from 'node:crypto'
import { isAbsolute } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import { appError, getErrorKey } from '../../shared/errors'
import {
  nativeImportApplySchema,
  nativeImportQuerySchema,
  nativeImportRecordSchema,
  type NativeImportPreview,
  type NativeImportRecord,
  type ImportCollection,
} from '../../shared/engines/native-import'
import { engineWorkspaceSchema } from '../../shared/engines/workspace'
import type { EngineInstallation } from '../../shared/engines/schema'
import type { EngineWorkspaceStore } from '../engine-workspace-store'
import type { CredentialVault } from '../credentials/vault'
import { inspectFile } from '../engines/installed-plugin-files'
import { NativeImportArchive } from './archive'
import { parseNativeJsonc } from './jsonc'
import { planOpenCodeImport, type NativeImportPlan } from './opencode'

interface Pending {
  record: NativeImportRecord
  installation: EngineInstallation
  plan: NativeImportPlan
  source: Buffer
  stamp: string
  revision: number
  expires: number
}
export class NativeImportService {
  private pending: Pending | undefined
  private busy = false
  constructor(
    private readonly workspace: EngineWorkspaceStore,
    private readonly vault: CredentialVault,
    private readonly archive: NativeImportArchive,
  ) {}
  private async operation<T>(work: () => Promise<T>): Promise<T> {
    if (this.busy) throw appError('error.nativeImportBusy')
    this.busy = true
    try {
      return await work()
    } finally {
      this.busy = false
    }
  }
  private discard() {
    if (this.pending) {
      this.pending.source.fill(0)
      for (const credential of this.pending.plan.credentials) credential.value = ''
    }
    this.pending = undefined
  }
  private async read(path: string) {
    if (!isAbsolute(path)) throw appError('error.nativeImportRead')
    try {
      const file = await inspectFile(path, 1_048_576, true)
      if (!file.content?.length) throw appError('error.nativeImportSyntax')
      const data = parseNativeJsonc(new TextDecoder('utf-8', { fatal: true }).decode(file.content))
      return { ...file, data, content: file.content }
    } catch (error) {
      const key = getErrorKey(error)
      if (key === 'error.nativeImportSyntax' || key === 'error.nativeImportLimit') throw error
      if (key === 'error.pluginLimit') throw appError('error.nativeImportLimit')
      throw appError('error.nativeImportRead')
    }
  }
  async recover() {
    const current = await this.workspace.load()
    await this.vault.recoverImport(new Set(current.nativeImports?.map((record) => record.id)))
  }
  preview(input: unknown, path: string): Promise<NativeImportPreview> {
    return this.operation(async () => {
      const query = nativeImportQuerySchema.parse(input)
      this.discard()
      const current = await this.workspace.load()
      const installation = current.installations.find((item) => item.id === query.installationId)
      if (installation?.kind !== 'opencode') throw appError('error.nativeImportEngine')
      await this.archive.available()
      const file = await this.read(path)
      const id = randomUUID()
      const plan = planOpenCodeImport(file.data, installation.id, id)
      const record = nativeImportRecordSchema.parse({
        id,
        engine: 'opencode',
        installationId: installation.id,
        contractVersion: '1.18.16',
        importedAt: new Date().toISOString(),
        source: file.observation,
        mappings: plan.mappings,
        diagnostics: plan.diagnostics,
      })
      const next = structuredClone(current)
      for (const collection of Object.keys(plan.additions) as ImportCollection[])
        (next[collection] as { id: string }[]).push(...plan.additions[collection])
      next.nativeImports = [...(current.nativeImports ?? []), record]
      if (!engineWorkspaceSchema.safeParse(next).success) throw appError('error.invalidData')
      const expires = Date.now() + 10 * 60_000
      this.pending = {
        record,
        installation,
        plan,
        source: file.content,
        stamp: file.stamp,
        revision: current.revision,
        expires,
      }
      return {
        id,
        workspaceRevision: current.revision,
        record: structuredClone(record),
        entities: (Object.keys(plan.additions) as ImportCollection[]).flatMap((collection) =>
          plan.additions[collection].map((entity) => ({
            collection,
            id: entity.id,
            name: entity.name,
          })),
        ),
        credentials: plan.credentials.length,
        expiresAt: new Date(expires).toISOString(),
      }
    })
  }
  apply(input: unknown) {
    return this.operation(async () => {
      const query = nativeImportApplySchema.parse(input)
      await this.recover()
      const current = await this.workspace.load()
      // A lost IPC acknowledgment never creates a second set of entries/credentials.
      if (current.nativeImports?.some((record) => record.id === query.id)) {
        if (this.pending?.record.id === query.id) this.discard()
        return current
      }
      const pending = this.pending
      if (!pending || pending.record.id !== query.id) throw appError('error.nativeImportExpired')
      if (Date.now() > pending.expires) {
        this.discard()
        throw appError('error.nativeImportExpired')
      }
      if (query.workspaceRevision !== pending.revision || current.revision !== pending.revision)
        throw appError('error.conflict')
      if (
        !isDeepStrictEqual(
          current.installations.find((entry) => entry.id === pending.installation.id),
          pending.installation,
        )
      )
        throw appError('error.nativeImportChanged')
      const latest = await this.read(pending.record.source.path)
      latest.content.fill(0)
      if (
        latest.stamp !== pending.stamp ||
        !isDeepStrictEqual(latest.observation, pending.record.source)
      )
        throw appError('error.nativeImportChanged')
      const next = structuredClone(current)
      for (const collection of Object.keys(pending.plan.additions) as ImportCollection[])
        (next[collection] as { id: string }[]).push(
          ...structuredClone(pending.plan.additions[collection]),
        )
      next.nativeImports = [...(current.nativeImports ?? []), pending.record]
      const parsed = engineWorkspaceSchema.parse(next)
      await this.archive.save(pending.record, pending.source)
      const result = await this.vault.importBatch(
        query.id,
        pending.plan.credentials,
        () => this.workspace.save(parsed),
        async () =>
          Boolean(
            (await this.workspace.load()).nativeImports?.some((record) => record.id === query.id),
          ),
      )
      this.discard()
      return result
    })
  }
}
