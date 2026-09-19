import { randomUUID } from 'node:crypto'
import { mkdir, open, readFile, rename, unlink } from 'node:fs/promises'
import { dirname } from 'node:path'
import { z } from 'zod'
import { appError } from '../../shared/errors'
import {
  credentialInputSchema,
  deleteCredentialSchema,
  type CredentialMetadata,
  type CredentialStatus,
  type CredentialInput,
} from '../../shared/credentials'
import { displayName, entityId, type SecretReference } from '../../shared/engines/schema'
import type { CredentialVersion } from '../../shared/engines/credential-observation'

export interface ResolvedCredential {
  value: string
  resolvedAt: string
  version: CredentialVersion
}
export interface CredentialVersions {
  available: boolean
  entries: { id: string; versionId: string | null; revision: number; updatedAt: string }[]
}

export interface SecretCipher {
  available(): Promise<boolean>
  encrypt(value: string): Promise<Buffer>
  decrypt(value: Buffer): Promise<{ value: string; reencrypt: boolean }>
}
const entrySchema = z
  .object({
    id: entityId,
    name: displayName,
    kind: z.enum(['api-key', 'bearer']),
    revision: z.number().int().positive(),
    updatedAt: z.iso.datetime(),
    versionId: z.uuid().optional(),
    ciphertext: z
      .string()
      .min(1)
      .max(200_000)
      .regex(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/),
  })
  .strict()
const vaultSchema = z
  .object({
    schemaVersion: z.literal(1),
    entries: z.array(entrySchema).max(200),
    pendingImport: z
      .object({ id: z.uuid(), credentialIds: z.array(entityId).max(200) })
      .strict()
      .optional(),
  })
  .strict()
  .refine(
    (document) =>
      new Set(document.entries.map((entry) => entry.id)).size === document.entries.length,
  )
type VaultDocument = z.infer<typeof vaultSchema>
type Entry = z.infer<typeof entrySchema>
function metadata(entry: Entry): CredentialMetadata {
  return {
    id: entry.id,
    name: entry.name,
    kind: entry.kind,
    revision: entry.revision,
    updatedAt: entry.updatedAt,
    configured: true,
  }
}

/** Main-process only: plaintext resolution is deliberately absent from the preload API. */
export class CredentialVault {
  private queue: Promise<unknown> = Promise.resolve()
  constructor(
    readonly filePath: string,
    private readonly cipher: SecretCipher,
  ) {}
  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.queue.then(operation)
    this.queue = next.catch(() => undefined)
    return next
  }
  private async available() {
    try {
      return await this.cipher.available()
    } catch {
      return false
    }
  }
  private async requireAvailable() {
    if (!(await this.available())) throw appError('error.credentialsUnavailable')
  }
  async status(): Promise<CredentialStatus> {
    return this.enqueue(async () => ({
      available: await this.available(),
      credentials: (await this.read()).entries.map(metadata),
    }))
  }
  set(input: unknown): Promise<CredentialMetadata> {
    return this.enqueue(async () => {
      const parsed = credentialInputSchema.safeParse(input)
      if (!parsed.success) throw appError('error.invalidData')
      const candidate = parsed.data
      await this.requireAvailable()
      const document = await this.read()
      if (document.pendingImport) throw appError('error.nativeImportRecovery')
      const id = candidate.id ?? randomUUID()
      const existing = document.entries.find((entry) => entry.id === id)
      if ((existing?.revision ?? null) !== candidate.expectedRevision)
        throw appError('error.conflict')
      let ciphertext: Buffer
      try {
        ciphertext = await this.cipher.encrypt(candidate.value)
      } catch {
        throw appError('error.credentialEncryption')
      }
      const entry = entrySchema.parse({
        id,
        name: candidate.name,
        kind: candidate.kind,
        revision: (existing?.revision ?? 0) + 1,
        updatedAt: new Date().toISOString(),
        versionId: randomUUID(),
        ciphertext: ciphertext.toString('base64'),
      })
      const next = {
        schemaVersion: 1 as const,
        entries: [...document.entries.filter((item) => item.id !== id), entry],
      }
      if (!vaultSchema.safeParse(next).success) throw appError('error.invalidData')
      await this.write(next)
      return metadata(entry)
    })
  }
  remove(input: unknown): Promise<void> {
    return this.enqueue(async () => {
      const parsed = deleteCredentialSchema.safeParse(input)
      if (!parsed.success) throw appError('error.invalidData')
      const document = await this.read()
      if (document.pendingImport) throw appError('error.nativeImportRecovery')
      const entry = document.entries.find((item) => item.id === parsed.data.id)
      if (!entry) throw appError('error.credentialMissing')
      if (entry.revision !== parsed.data.expectedRevision) throw appError('error.conflict')
      await this.write({
        ...document,
        entries: document.entries.filter((item) => item.id !== entry.id),
      })
    })
  }
  resolve(reference: SecretReference, environment: NodeJS.ProcessEnv): Promise<string> {
    return this.resolveVersioned(reference, environment).then((result) => result.value)
  }
  /** Read-only metadata for main-process reports. Never decrypts or resolves environment references. */
  versions(): Promise<CredentialVersions> {
    return this.enqueue(async () => {
      const document = await this.read()
      if (document.pendingImport) throw appError('error.nativeImportRecovery')
      return {
        available: await this.available(),
        entries: document.entries.map((entry) => ({
          id: entry.id,
          versionId: entry.versionId ?? null,
          revision: entry.revision,
          updatedAt: entry.updatedAt,
        })),
      }
    })
  }
  /** Value and revision come from the same serialized read, never a separate status lookup. */
  resolveVersioned(
    reference: SecretReference,
    environment: NodeJS.ProcessEnv,
  ): Promise<ResolvedCredential> {
    return this.enqueue(async () => {
      if (reference.kind === 'environment') {
        const value = environment[reference.name]
        if (!value) throw appError('error.credentialMissing')
        return { value, resolvedAt: new Date().toISOString(), version: { source: 'environment' } }
      }
      await this.requireAvailable()
      const document = await this.read()
      if (document.pendingImport) throw appError('error.nativeImportRecovery')
      const entry = document.entries.find((item) => item.id === reference.id)
      if (!entry) throw appError('error.credentialMissing')
      try {
        const decrypted = await this.cipher.decrypt(Buffer.from(entry.ciphertext, 'base64'))
        if (decrypted.reencrypt || !entry.versionId) {
          if (decrypted.reencrypt)
            entry.ciphertext = (await this.cipher.encrypt(decrypted.value)).toString('base64')
          // Legacy entries acquire an opaque version on explicit secret resolution, never on report reads.
          entry.versionId ??= randomUUID()
          await this.write(document)
        }
        return {
          value: decrypted.value,
          resolvedAt: new Date().toISOString(),
          version: {
            source: 'vault',
            versionId: entry.versionId!,
            revision: entry.revision,
            updatedAt: entry.updatedAt,
          },
        }
      } catch {
        throw appError('error.credentialDecryption')
      }
    })
  }
  /** Recover the credential half of an import using the atomically published workspace record. */
  recoverImport(committedIds: ReadonlySet<string>): Promise<void> {
    return this.enqueue(async () => {
      const document = await this.read()
      if (!document.pendingImport) return
      const pending = document.pendingImport
      await this.write({
        schemaVersion: 1,
        entries: committedIds.has(pending.id)
          ? document.entries
          : document.entries.filter((entry) => !pending.credentialIds.includes(entry.id)),
      })
    })
  }
  /** Main-process import transaction. Plaintext inputs never cross the preload boundary. */
  importBatch<T>(
    importId: string,
    inputs: CredentialInput[],
    publish: () => Promise<T>,
    isCommitted: () => Promise<boolean>,
  ): Promise<T> {
    return this.enqueue(async () => {
      z.uuid().parse(importId)
      await this.requireAvailable()
      const original = await this.read()
      if (original.pendingImport) throw appError('error.nativeImportRecovery')
      const ids = new Set(original.entries.map((entry) => entry.id))
      const entries = [...original.entries]
      const added: string[] = []
      for (const input of inputs) {
        const parsed = credentialInputSchema.parse(input)
        if (!parsed.id || parsed.expectedRevision !== null || ids.has(parsed.id))
          throw appError('error.conflict')
        ids.add(parsed.id)
        added.push(parsed.id)
        let ciphertext: Buffer
        try {
          ciphertext = await this.cipher.encrypt(parsed.value)
        } catch {
          throw appError('error.credentialEncryption')
        }
        entries.push(
          entrySchema.parse({
            id: parsed.id,
            name: parsed.name,
            kind: parsed.kind,
            revision: 1,
            updatedAt: new Date().toISOString(),
            versionId: randomUUID(),
            ciphertext: ciphertext.toString('base64'),
          }),
        )
      }
      const staged = vaultSchema.parse({
        schemaVersion: 1,
        entries,
        pendingImport: { id: importId, credentialIds: added },
      })
      const committed: VaultDocument = { schemaVersion: 1, entries }
      try {
        await this.write(staged)
        const result = await publish()
        // A failed final cleanup is recoverable from the published import ID on the next attempt/start.
        await this.write(committed).catch(() => undefined)
        return result
      } catch (error) {
        // Publication may have succeeded before its acknowledgment failed. Never undo those keys.
        const published = await isCommitted().catch(() => null)
        if (published !== null)
          await this.write(published ? committed : original).catch(() => undefined)
        throw error
      }
    })
  }
  private async read(): Promise<VaultDocument> {
    let contents: string
    try {
      contents = await readFile(this.filePath, 'utf8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT')
        return { schemaVersion: 1, entries: [] }
      throw appError('error.credentialStorage')
    }
    try {
      return vaultSchema.parse(JSON.parse(contents))
    } catch {
      throw appError('error.credentialStorage')
    }
  }
  private async write(document: VaultDocument) {
    const temporary = `${this.filePath}.${randomUUID()}.tmp`
    try {
      await mkdir(dirname(this.filePath), { recursive: true, mode: 0o700 })
      const file = await open(temporary, 'wx', 0o600)
      try {
        await file.writeFile(JSON.stringify(document) + '\n')
        await file.sync()
      } finally {
        await file.close()
      }
      await rename(temporary, this.filePath)
    } catch {
      throw appError('error.credentialStorage')
    } finally {
      await unlink(temporary).catch(() => undefined)
    }
  }
}
