import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { z } from 'zod'
import { appError } from '../../shared/errors'
import {
  credentialInputSchema,
  deleteCredentialSchema,
  type CredentialMetadata,
  type CredentialStatus,
} from '../../shared/credentials'
import { displayName, entityId, type SecretReference } from '../../shared/engines/schema'

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
    ciphertext: z
      .string()
      .min(1)
      .max(200_000)
      .regex(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/),
  })
  .strict()
const vaultSchema = z
  .object({ schemaVersion: z.literal(1), entries: z.array(entrySchema).max(200) })
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
    return this.enqueue(async () => {
      if (reference.kind === 'environment') {
        const value = environment[reference.name]
        if (!value) throw appError('error.credentialMissing')
        return value
      }
      await this.requireAvailable()
      const document = await this.read()
      const entry = document.entries.find((item) => item.id === reference.id)
      if (!entry) throw appError('error.credentialMissing')
      try {
        const decrypted = await this.cipher.decrypt(Buffer.from(entry.ciphertext, 'base64'))
        if (decrypted.reencrypt) {
          entry.ciphertext = (await this.cipher.encrypt(decrypted.value)).toString('base64')
          await this.write(document)
        }
        return decrypted.value
      } catch {
        throw appError('error.credentialDecryption')
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
      await writeFile(temporary, JSON.stringify(document) + '\n', { mode: 0o600, flag: 'wx' })
      await rename(temporary, this.filePath)
    } catch {
      throw appError('error.credentialStorage')
    } finally {
      await unlink(temporary).catch(() => undefined)
    }
  }
}
