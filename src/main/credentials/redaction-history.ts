import { randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { lstat, open, rename, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { z } from 'zod'
import { appError } from '../../shared/errors'
import { contentDigest, type RunInputManifest } from '../../shared/engines/run-inputs'
import { entityId } from '../../shared/engines/schema'
import type { SecretCipher } from './vault'

const maximumCiphertext = 16 * 1024 * 1024
const valuesSchema = z
  .array(z.string().min(1).max(65_536))
  .max(256)
  .refine((values) => values.reduce((sum, value) => sum + value.length, 0) <= 1_048_576)
const documentSchema = z
  .object({
    version: z.literal(1),
    snapshotId: entityId,
    snapshotDigest: contentDigest,
    values: valuesSchema,
  })
  .strict()
type Identity = Pick<RunInputManifest, 'id' | 'digest'>

/** Retired values are only redaction inputs; they must never be used for authentication. */
export class RedactionHistory {
  constructor(private readonly cipher: SecretCipher) {}

  private async requireAvailable() {
    if (!(await this.cipher.available().catch(() => false)))
      throw appError('error.credentialsUnavailable')
  }

  async initialize(root: string, identity: Identity): Promise<void> {
    await this.requireAvailable()
    await this.write(root, identity, [], true)
  }

  /** Caller serializes this with capture creation and removal. Missing history is never reset. */
  async retain(root: string, identity: Identity, current: readonly string[]): Promise<string[]> {
    await this.requireAvailable()
    let previous: z.infer<typeof documentSchema>
    try {
      const handle = await open(
        join(root, 'redactions.enc'),
        constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
      )
      let bytes: Buffer
      try {
        const before = await handle.stat({ bigint: true })
        if (!before.isFile() || before.nlink !== 1n || before.size > maximumCiphertext)
          throw new Error('Invalid history file')
        bytes = Buffer.alloc(Number(before.size) + 1)
        let offset = 0
        while (offset < bytes.length) {
          const read = await handle.read(bytes, offset, bytes.length - offset, offset)
          if (!read.bytesRead) break
          offset += read.bytesRead
        }
        const after = await handle.stat({ bigint: true })
        if (
          offset !== Number(before.size) ||
          before.mtimeNs !== after.mtimeNs ||
          before.ctimeNs !== after.ctimeNs ||
          before.size !== after.size
        )
          throw new Error('Changed history file')
        bytes = bytes.subarray(0, offset)
      } finally {
        await handle.close()
      }
      previous = documentSchema.parse(JSON.parse((await this.cipher.decrypt(bytes)).value))
      if (previous.snapshotId !== identity.id || previous.snapshotDigest !== identity.digest)
        throw new Error('Wrong history identity')
    } catch {
      throw appError('error.credentialRedactionHistory')
    }
    const values = [...new Set([...previous.values, ...current].filter(Boolean))]
    if (!valuesSchema.safeParse(values).success) throw appError('error.credentialRedactionLimit')
    // Re-encrypt every attachment to honor backend rewrapping and flush before any child starts.
    await this.write(root, identity, values, false)
    return values
  }

  private async write(root: string, identity: Identity, values: string[], initial: boolean) {
    const destination = join(root, 'redactions.enc')
    const temporary = join(root, `.redactions-${randomUUID()}.tmp`)
    try {
      if (!(await lstat(root)).isDirectory()) throw new Error('Invalid capture directory')
      const ciphertext = await this.cipher.encrypt(
        JSON.stringify({
          version: 1,
          snapshotId: identity.id,
          snapshotDigest: identity.digest,
          values,
        }),
      )
      if (ciphertext.length > maximumCiphertext) throw new Error('Oversized ciphertext')
      const file = await open(initial ? destination : temporary, 'wx', 0o600)
      try {
        await file.writeFile(ciphertext)
        await file.sync()
      } finally {
        await file.close()
      }
      if (!initial) await rename(temporary, destination)
      const directory = await open(root, constants.O_RDONLY | constants.O_NOFOLLOW)
      try {
        await directory.sync()
      } finally {
        await directory.close()
      }
    } catch {
      throw appError('error.credentialRedactionHistory')
    } finally {
      if (!initial) await rm(temporary, { force: true }).catch(() => undefined)
    }
  }
}
