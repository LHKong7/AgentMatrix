import { createHash, randomUUID } from 'node:crypto'
import { link, mkdir, open, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import { z } from 'zod'
import { appError, getErrorKey } from '../../shared/errors'
import {
  nativeImportRecordSchema,
  type NativeImportRecord,
} from '../../shared/engines/native-import'
import type { SecretCipher } from '../credentials/vault'
import { inspectFile } from '../engines/installed-plugin-files'

const documentSchema = z
  .object({
    schemaVersion: z.literal(1),
    record: nativeImportRecordSchema,
    ciphertext: z
      .string()
      .min(1)
      .max(4_194_304)
      .regex(/^[A-Za-z0-9+/]+={0,2}$/),
  })
  .strict()

/** Immutable encrypted source documents, separate from ordinary workspace/run configuration. */
export class NativeImportArchive {
  constructor(
    private readonly root: string,
    private readonly cipher: SecretCipher,
  ) {}
  private path(id: string) {
    return join(this.root, `${z.uuid().parse(id)}.json`)
  }
  async available() {
    if (!(await this.cipher.available().catch(() => false)))
      throw appError('error.credentialsUnavailable')
  }
  async verify(record: NativeImportRecord) {
    try {
      await this.available()
      const file = await inspectFile(this.path(record.id), 5_242_880, true)
      const document = documentSchema.parse(JSON.parse(file.content!.toString('utf8')))
      if (!isDeepStrictEqual(document.record, record)) throw new Error('Record mismatch')
      const plaintext = await this.cipher.decrypt(Buffer.from(document.ciphertext, 'base64'))
      const bytes = Buffer.from(plaintext.value, 'base64')
      try {
        if (
          bytes.length !== record.source.bytes ||
          createHash('sha256').update(bytes).digest('hex') !== record.source.sha256
        )
          throw new Error('Source mismatch')
      } finally {
        bytes.fill(0)
      }
    } catch (error) {
      if (getErrorKey(error) === 'error.credentialsUnavailable') throw error
      throw appError('error.nativeImportArchive')
    }
  }
  async save(record: NativeImportRecord, bytes: Buffer) {
    await this.available()
    const path = this.path(record.id)
    const temporary = `${path}.${randomUUID()}.tmp`
    try {
      const ciphertext = await this.cipher.encrypt(bytes.toString('base64'))
      const document = documentSchema.parse({
        schemaVersion: 1,
        record,
        ciphertext: ciphertext.toString('base64'),
      })
      await mkdir(this.root, { recursive: true, mode: 0o700 })
      const file = await open(temporary, 'wx', 0o600)
      try {
        await file.writeFile(JSON.stringify(document) + '\n')
        await file.sync()
      } finally {
        await file.close()
      }
      try {
        await link(temporary, path)
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      }
      await this.verify(record)
    } catch (error) {
      if (getErrorKey(error) === 'error.credentialsUnavailable') throw error
      throw appError('error.nativeImportArchive')
    } finally {
      await unlink(temporary).catch(() => undefined)
    }
  }
}
