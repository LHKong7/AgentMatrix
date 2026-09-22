import { randomUUID } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import { appError } from '../../shared/errors'
import {
  nativeImportApplySchema,
  nativeImportQuerySchema,
  nativeImportRecordSchema,
  type NativeImportPreview,
  type NativeImportRecord,
  type NativeImportEngine,
  type ImportCollection,
} from '../../shared/engines/native-import'
import { engineWorkspaceSchema, type EngineWorkspace } from '../../shared/engines/workspace'
import { fingerprintFor, mergeEvidence } from '../../shared/engines/evidence'
import { adapterVersionFor } from '../../shared/engines/provider'
import type { EngineInstallation } from '../../shared/engines/schema'
import type { EngineWorkspaceStore } from '../engine-workspace-store'
import type { CredentialVault } from '../credentials/vault'
import { NativeImportArchive } from './archive'
import { planOpenCodeImport } from './opencode'
import { openCodePromptReferences } from './opencode-prompts'
import { planPiImport, type PiImportDocuments } from './pi'
import { planDshImport } from './dsh'
import type { DshImportDocuments } from './dsh-layers'
import type { NativeImportPlan } from './plan'
import type { JsonObject } from './jsonc'
import { readImportFiles, importArchiveBytes, type ImportFile } from './source-files'
import { verifyImportSecretBoundary } from './secret-boundary'

/**
 * Adds everything one adoption produced, and files what adopting actually observed.
 *
 * Reading a provider out of a CLI's own files establishes that the provider is configured there,
 * which is what `discovered` means: the endpoint has not been called and no session has started.
 * The interface reports it as found and unverified until something stronger is observed.
 */
function applyPlan(
  workspace: EngineWorkspace,
  plan: NativeImportPlan,
  record: NativeImportRecord,
): EngineWorkspace {
  const next = structuredClone(workspace)
  for (const collection of Object.keys(plan.additions) as ImportCollection[])
    (next[collection] as { id: string }[]).push(...structuredClone(plan.additions[collection]))
  next.engineBindings = [...next.engineBindings, ...structuredClone(plan.bindings)]
  next.nativeImports = [...(workspace.nativeImports ?? []), record]
  let serial = 0
  for (const subject of [
    ...plan.additions.connections.map((connection) => ({
      kind: 'connection' as const,
      id: connection.id,
    })),
    ...plan.bindings.map((binding) => ({ kind: 'binding' as const, id: binding.id })),
  ]) {
    const fingerprint = fingerprintFor(next, subject)
    if (!fingerprint) continue
    next.evidence = mergeEvidence(next.evidence, {
      id: `import-${record.id}-found-${++serial}`,
      subject,
      kind: 'discovered',
      result: 'pass',
      observedAt: record.importedAt,
      adapterVersion: adapterVersionFor(record.engine),
      fingerprint,
      detail: '',
    })
  }
  return next
}

interface Pending {
  record: NativeImportRecord
  installation: EngineInstallation
  plan: NativeImportPlan
  files: ImportFile[]
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
      for (const file of this.pending.files) file.content.fill(0)
      for (const credential of this.pending.plan.credentials) credential.value = ''
    }
    this.pending = undefined
  }
  async recover() {
    const current = await this.workspace.load()
    await this.vault.recoverImport(new Set(current.nativeImports?.map((record) => record.id)))
  }
  preview(input: unknown, paths: string | string[]): Promise<NativeImportPreview> {
    return this.operation(async () => {
      const query = nativeImportQuerySchema.parse(input)
      let references: string[] = []
      let priorFiles: ImportFile[] = []
      if (query.previousPreviewId) {
        const prior = this.pending
        if (!prior || prior.record.id !== query.previousPreviewId || prior.expires <= Date.now())
          throw appError('error.nativeImportExpired')
        if (
          !['opencode', 'deepseek-harness'].includes(prior.record.engine) ||
          prior.installation.id !== query.installationId
        )
          throw appError('error.nativeImportSelection')
        if (prior.record.engine === 'opencode') {
          const selected = typeof paths === 'string' ? [paths] : paths
          if (
            selected.length !== 1 ||
            !query.referencePath ||
            !openCodePromptReferences(prior.files[0]!.data as JsonObject).some(
              (reference) => reference.path === query.referencePath,
            )
          )
            throw appError('error.nativeImportSelection')
          priorFiles = prior.files
          const retained = prior.files.filter((file) => file.referencePath !== query.referencePath)
          paths = [...retained.map((file) => file.observation.path), selected[0]!]
          references = [
            ...retained.slice(1).map((file) => file.referencePath!),
            query.referencePath,
          ]
        } else {
          if (query.referencePath !== undefined) throw appError('error.nativeImportSelection')
          paths = [
            ...prior.files.map((file) => file.observation.path),
            ...(typeof paths === 'string' ? [paths] : paths),
          ]
        }
      }
      this.discard()
      const current = await this.workspace.load()
      const installation = current.installations.find((item) => item.id === query.installationId)
      if (!installation || !['opencode', 'pi', 'deepseek-harness'].includes(installation.kind))
        throw appError('error.nativeImportEngine')
      const engine = installation.kind as NativeImportEngine
      await this.archive.available()
      const files = await readImportFiles(engine, paths, references)
      for (const prior of priorFiles) {
        const latest = files.find(
          (file) =>
            file.referencePath === prior.referencePath &&
            file.observation.path === prior.observation.path,
        )
        // A replaced selection may differ; every retained source must match the reviewed preview.
        if (!latest) continue
        if (
          latest.stamp !== prior.stamp ||
          !isDeepStrictEqual(latest.observation, prior.observation)
        ) {
          for (const file of files) file.content.fill(0)
          throw appError('error.nativeImportChanged')
        }
      }
      const file = files[0]!
      const promptReferences =
        engine === 'opencode'
          ? openCodePromptReferences(file.data as JsonObject).map((reference) => ({
              ...reference,
              ...(files.find((file) => file.referencePath === reference.path)
                ? {
                    selectedPath: files.find((file) => file.referencePath === reference.path)!
                      .observation.path,
                  }
                : {}),
            }))
          : undefined
      if (
        references.some((path) => !promptReferences?.some((reference) => reference.path === path))
      ) {
        for (const file of files) file.content.fill(0)
        throw appError('error.nativeImportSelection')
      }
      const id = randomUUID()
      const plan =
        engine === 'opencode'
          ? planOpenCodeImport(
              file.data as JsonObject,
              installation.id,
              id,
              new Map(files.slice(1).map((file) => [file.referencePath!, file.data as string])),
            )
          : engine === 'deepseek-harness'
            ? planDshImport(
                Object.fromEntries(
                  files.map((file) => [file.kind, file.data]),
                ) as DshImportDocuments,
                installation.id,
                id,
              )
            : planPiImport(
                Object.fromEntries(
                  files.map((file) => [file.kind, file.data]),
                ) as PiImportDocuments,
                installation.id,
                id,
              )
      const record = nativeImportRecordSchema.parse({
        id,
        engine,
        installationId: installation.id,
        contractVersion:
          engine === 'opencode' ? '1.18.16' : engine === 'pi' ? '0.85.1' : '0.1.5-rc.2',
        ...(engine !== 'opencode'
          ? {
              sourceKind: file.kind,
              additionalSources: files
                .slice(1)
                .map((file) => ({ kind: file.kind, source: file.observation })),
            }
          : files.length > 1
            ? {
                additionalSources: files.slice(1).map((file) => ({
                  kind: 'opencode-prompt',
                  referencePath: file.referencePath,
                  source: file.observation,
                })),
              }
            : {}),
        importedAt: new Date().toISOString(),
        source: file.observation,
        mappings: plan.mappings,
        diagnostics: plan.diagnostics,
      })
      try {
        verifyImportSecretBoundary(plan, record, promptReferences)
      } catch (error) {
        for (const file of files) file.content.fill(0)
        for (const credential of plan.credentials) credential.value = ''
        throw error
      }
      if (!engineWorkspaceSchema.safeParse(applyPlan(current, plan, record)).success)
        throw appError('error.invalidData')
      const expires = Date.now() + 10 * 60_000
      this.pending = {
        record,
        installation,
        plan,
        files,
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
        ...(promptReferences ? { promptReferences } : {}),
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
      const latest = await readImportFiles(
        pending.record.engine,
        pending.files.map((file) => file.observation.path),
        pending.record.engine === 'opencode'
          ? pending.files.slice(1).map((file) => file.referencePath!)
          : [],
      )
      const changed = latest.some(
        (file, index) =>
          file.stamp !== pending.files[index]!.stamp ||
          !isDeepStrictEqual(file.observation, pending.files[index]!.observation),
      )
      for (const file of latest) file.content.fill(0)
      if (changed) throw appError('error.nativeImportChanged')
      const parsed = engineWorkspaceSchema.parse(applyPlan(current, pending.plan, pending.record))
      const bytes = importArchiveBytes(pending.files)
      try {
        await this.archive.save(pending.record, bytes)
      } finally {
        bytes.fill(0)
      }
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
