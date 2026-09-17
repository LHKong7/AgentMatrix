import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { CredentialVault, type SecretCipher } from '../src/main/credentials/vault'

let root: string
let vault: CredentialVault
let cipher: SecretCipher
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'agentmatrix-vault-test-'))
  const key = randomBytes(32)
  cipher = {
    available: async () => true,
    async encrypt(value) {
      const iv = randomBytes(12)
      const stream = createCipheriv('aes-256-gcm', key, iv)
      const data = Buffer.concat([stream.update(value, 'utf8'), stream.final()])
      return Buffer.concat([iv, stream.getAuthTag(), data])
    },
    async decrypt(value) {
      const stream = createDecipheriv('aes-256-gcm', key, value.subarray(0, 12))
      stream.setAuthTag(value.subarray(12, 28))
      return {
        value: Buffer.concat([stream.update(value.subarray(28)), stream.final()]).toString('utf8'),
        reencrypt: false,
      }
    },
  }
  vault = new CredentialVault(join(root, 'credentials', 'vault.json'), cipher)
})
afterEach(() => rm(root, { recursive: true, force: true }))
const input = {
  name: 'Test key',
  kind: 'api-key' as const,
  value: 'test-secret-不可泄漏',
  expectedRevision: null,
}

describe('credential vault boundaries', () => {
  it('persists ciphertext and exposes only metadata while main-process resolution survives reopening', async () => {
    const entry = await vault.set(input)
    expect(Object.keys(entry).sort()).toEqual([
      'configured',
      'id',
      'kind',
      'name',
      'revision',
      'updatedAt',
    ])
    expect(await vault.status()).toEqual({ available: true, credentials: [entry] })
    expect(await readFile(vault.filePath, 'utf8')).not.toContain(input.value)
    if (process.platform !== 'win32') expect((await stat(vault.filePath)).mode & 0o777).toBe(0o600)
    const reopened = new CredentialVault(vault.filePath, cipher)
    expect(await reopened.resolve({ kind: 'credential', id: entry.id }, {})).toBe(input.value)
  })
  it('serializes replacement and rejects a stale edit/delete without losing the last value', async () => {
    const entry = await vault.set(input)
    const updates = await Promise.allSettled([
      vault.set({ ...input, id: entry.id, expectedRevision: 1, value: 'replacement' }),
      vault.set({ ...input, id: entry.id, expectedRevision: 1, value: 'stale' }),
    ])
    expect(updates.map((result) => result.status)).toEqual(['fulfilled', 'rejected'])
    await expect(vault.remove({ id: entry.id, expectedRevision: 1 })).rejects.toThrow(
      'error.conflict',
    )
    expect(await vault.resolve({ kind: 'credential', id: entry.id }, {})).toBe('replacement')
    await vault.remove({ id: entry.id, expectedRevision: 2 })
    expect((await vault.status()).credentials).toEqual([])
    await expect(vault.resolve({ kind: 'credential', id: entry.id }, {})).rejects.toThrow(
      'error.credentialMissing',
    )
  })
  it('preserves stored bytes on encryption failures and never includes backend secret details in errors', async () => {
    const entry = await vault.set(input)
    const before = await readFile(vault.filePath, 'utf8')
    cipher.encrypt = async () => {
      throw new Error(input.value)
    }
    await expect(vault.set({ ...input, id: entry.id, expectedRevision: 1 })).rejects.toThrow(
      'error.credentialEncryption',
    )
    expect(await readFile(vault.filePath, 'utf8')).toBe(before)
  })
  it('rejects unavailable storage rather than saving plaintext', async () => {
    cipher.available = async () => false
    expect(await vault.status()).toEqual({ available: false, credentials: [] })
    await expect(vault.set(input)).rejects.toThrow('error.credentialsUnavailable')
    await expect(readFile(vault.filePath)).rejects.toMatchObject({ code: 'ENOENT' })
  })
  it('preserves corrupt data and reports a sanitized storage failure', async () => {
    await vault.set(input)
    await writeFile(vault.filePath, '{corrupt')
    await expect(vault.status()).rejects.toThrow('error.credentialStorage')
    await expect(vault.set(input)).rejects.toThrow('error.credentialStorage')
    expect(await readFile(vault.filePath, 'utf8')).toBe('{corrupt')
  })
  it('resolves only the selected environment reference and does not persist it', async () => {
    expect(
      await vault.resolve(
        { kind: 'environment', name: 'CHOSEN' },
        { CHOSEN: 'value', OTHER: 'unrelated' },
      ),
    ).toBe('value')
    await expect(vault.resolve({ kind: 'environment', name: 'MISSING' }, {})).rejects.toThrow(
      'error.credentialMissing',
    )
    await expect(readFile(vault.filePath)).rejects.toMatchObject({ code: 'ENOENT' })
  })
})
