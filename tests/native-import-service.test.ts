import { createCipheriv, createDecipheriv, randomBytes, randomUUID } from 'node:crypto'
import {
  chmod,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  symlink,
  unlink,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { NativeImportArchive } from '../src/main/native-import/archive'
import { NativeImportService } from '../src/main/native-import/service'
import { EngineWorkspaceStore } from '../src/main/engine-workspace-store'
import { CredentialVault, type SecretCipher } from '../src/main/credentials/vault'
import { createEngineWorkspace } from '../src/shared/engines/workspace'
import { nativeImportSources, piImportKinds } from '../src/shared/engines/native-import'
import { unpackImportArchive } from '../src/main/native-import/source-files'

let root: string
let source: string
let store: EngineWorkspaceStore
let vault: CredentialVault
let cipher: SecretCipher
let archive: NativeImportArchive
let service: NativeImportService
const secret = 'synthetic-import-secret-中文'
const original = `{
  // Preserve comments, formatting and unknown values exactly.
  "provider": {"custom": {"npm": "@ai-sdk/openai-compatible", "options": {"baseURL": "https://example.test/v1", "apiKey": "${secret}"}}},
  "model": "custom/native-model",
  "agent": {"worker": {"prompt": "Shared role"}},
  "future": {"token": "private-unknown-value"},
  "instructions": ["/no-such-file.md"],
  "plugin": ["/no-such-plugin.js"],
}`
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'agentmatrix-native-import-'))
  source = join(root, 'opencode.jsonc')
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
  archive = new NativeImportArchive(join(root, 'native-imports'), cipher)
  store = new EngineWorkspaceStore(join(root, 'workspace.json'), 'en', undefined, (record) =>
    archive.verify(record),
  )
  vault = new CredentialVault(join(root, 'credentials', 'vault.json'), cipher)
  service = new NativeImportService(store, vault, archive)
  const state = createEngineWorkspace()
  state.installations = [
    {
      id: 'opencode',
      name: 'Import target',
      kind: 'opencode',
      executable: '/no-such-executable',
      prefixArgs: [],
      platform: 'darwin',
      version: null,
      modes: [],
      probedAt: null,
    },
  ]
  await store.save(state)
  await writeFile(source, original)
})
afterEach(async () => {
  vi.restoreAllMocks()
  await rm(root, { recursive: true, force: true })
})
const preview = () => service.preview({ installationId: 'opencode' }, source)
async function piFixture() {
  const current = await store.load()
  current.installations[0] = { ...current.installations[0]!, id: 'pi', kind: 'pi' }
  await store.save(current)
  const documents = {
    'models.json':
      '\uFEFF' +
      JSON.stringify({
        providers: {
          imported: {
            api: 'openai-completions',
            baseUrl: 'https://example.test/v1',
            apiKey: 'shadowed-secret',
            models: [{ id: 'model' }],
          },
        },
        future: { key: 'unknown-secret' },
      }),
    'auth.json': JSON.stringify({ imported: { type: 'api_key', key: secret } }),
    'settings.json': JSON.stringify({
      defaultProvider: 'imported',
      defaultModel: 'model',
      defaultThinkingLevel: 'off',
      extensions: ['/never-loaded'],
    }),
    'SYSTEM.md': '\uFEFFNative Pi role 中文\n',
    'APPEND_SYSTEM.md': 'Native Pi appendix\r\n',
  }
  for (const [name, bytes] of Object.entries(documents)) await writeFile(join(root, name), bytes)
  return {
    documents,
    paths: Object.keys(documents)
      .reverse()
      .map((name) => join(root, name)),
  }
}

describe('Pi multi-file import', () => {
  it('captures five exact originals with per-file provenance and publishes one atomic import record', async () => {
    const { documents, paths } = await piFixture()
    const before = await readFile(store.filePath, 'utf8')
    const captured = await service.preview({ installationId: 'pi' }, paths)
    expect(captured.record.engine).toBe('pi')
    expect(nativeImportSources(captured.record).map((entry) => entry.kind)).toEqual(piImportKinds)
    expect(await readFile(store.filePath, 'utf8')).toBe(before)
    expect(JSON.stringify(captured)).not.toMatch(
      /shadowed-secret|unknown-secret|synthetic-import-secret|Native Pi role/,
    )
    const saved = await service.apply({
      id: captured.id,
      workspaceRevision: captured.workspaceRevision,
    })
    expect(saved.nativeImports).toEqual([captured.record])
    expect(saved.prompts.map((entry) => entry.versions[0]!.content)).toEqual([
      documents['SYSTEM.md'],
      documents['APPEND_SYSTEM.md'],
    ])
    const auth = saved.connections[0]!.auth
    if (auth.kind !== 'bearer' || !auth.secret) throw new Error('Missing imported key')
    expect(await vault.resolve(auth.secret, {})).toBe(secret)
    const raw = await readFile(join(root, 'native-imports', `${captured.id}.json`), 'utf8')
    expect(raw).not.toMatch(/shadowed-secret|unknown-secret|synthetic-import-secret/)
    const encrypted = JSON.parse(raw)
    const payload = Buffer.from(
      (await cipher.decrypt(Buffer.from(encrypted.ciphertext, 'base64'))).value,
      'base64',
    )
    expect(
      unpackImportArchive(captured.record, payload).map((value) => value.toString('utf8')),
    ).toEqual(Object.values(documents))
    for (const [name, content] of Object.entries(documents))
      expect(await readFile(join(root, name), 'utf8')).toBe(content)
    for (const path of paths) await unlink(path)
    const reopened = new NativeImportService(
      store,
      new CredentialVault(vault.filePath, cipher),
      archive,
    )
    await reopened.recover()
    expect(
      await reopened.apply({ id: captured.id, workspaceRevision: captured.workspaceRevision }),
    ).toEqual(saved)
    const rewritten = structuredClone(saved)
    if (rewritten.nativeImports![0]!.engine !== 'pi') throw new Error('Wrong engine')
    rewritten.nativeImports![0]!.additionalSources.pop()
    await expect(store.save(rewritten)).rejects.toThrow('error.nativeImportHistory')
    await archive.verify(captured.record)
  })
  it.each(piImportKinds)(
    'rejects a change to any selected source before publication: %s',
    async (kind) => {
      const { paths, documents } = await piFixture()
      const captured = await service.preview({ installationId: 'pi' }, paths)
      await writeFile(join(root, kind), documents[kind] + '\n')
      await expect(
        service.apply({ id: captured.id, workspaceRevision: captured.workspaceRevision }),
      ).rejects.toThrow('error.nativeImportChanged')
      expect((await store.load()).nativeImports).toBeUndefined()
      expect((await vault.status()).credentials).toHaveLength(0)
    },
  )
  it('rejects duplicate roles, mixed folders, unknown files, and invalid JSON without following unselected sources', async () => {
    const { paths } = await piFixture()
    await expect(service.preview({ installationId: 'pi' }, [paths[0]!, paths[0]!])).rejects.toThrow(
      'error.nativeImportSelection',
    )
    await expect(
      service.preview({ installationId: 'pi' }, [join(root, 'models.json'), '/another/auth.json']),
    ).rejects.toThrow('error.nativeImportSelection')
    await expect(service.preview({ installationId: 'pi' }, [source])).rejects.toThrow(
      'error.nativeImportSelection',
    )
    await writeFile(join(root, 'auth.json'), '{broken')
    await expect(service.preview({ installationId: 'pi' }, paths)).rejects.toThrow(
      'error.nativeImportSyntax',
    )
    const captured = await service.preview({ installationId: 'pi' }, [join(root, 'models.json')])
    expect(nativeImportSources(captured.record)).toHaveLength(1)
    // The broken, unselected auth file is neither read nor used to change credential precedence.
    const saved = await service.apply({
      id: captured.id,
      workspaceRevision: captured.workspaceRevision,
    })
    const auth = saved.connections[0]!.auth
    if (auth.kind !== 'bearer' || !auth.secret) throw new Error('Missing selected-file key')
    expect(await vault.resolve(auth.secret, {})).toBe('shadowed-secret')
    expect(await readFile(join(root, 'auth.json'), 'utf8')).toBe('{broken')
  })
  it('archives empty Markdown and a near-limit source, while bounding total selected bytes', async () => {
    await piFixture()
    await writeFile(join(root, 'SYSTEM.md'), '')
    let captured = await service.preview({ installationId: 'pi' }, [join(root, 'SYSTEM.md')])
    expect(captured.record.source.bytes).toBe(0)
    expect(captured.entities.map((entry) => entry.collection)).toEqual(['agents'])
    await service.apply({ id: captured.id, workspaceRevision: captured.workspaceRevision })
    await archive.verify(captured.record)
    await writeFile(join(root, 'models.json'), JSON.stringify({ future: 'x'.repeat(900_000) }))
    captured = await service.preview({ installationId: 'pi' }, [join(root, 'models.json')])
    await service.apply({ id: captured.id, workspaceRevision: captured.workspaceRevision })
    await archive.verify(captured.record)
    await writeFile(join(root, 'SYSTEM.md'), 'x'.repeat(150_000))
    await expect(
      service.preview({ installationId: 'pi' }, [
        join(root, 'models.json'),
        join(root, 'SYSTEM.md'),
      ]),
    ).rejects.toThrow('error.nativeImportLimit')
  })
  it('rolls back every new Pi credential when workspace publication fails', async () => {
    const { paths } = await piFixture()
    const captured = await service.preview({ installationId: 'pi' }, paths)
    vi.spyOn(store, 'save').mockRejectedValueOnce(new Error('Publication failed'))
    await expect(
      service.apply({ id: captured.id, workspaceRevision: captured.workspaceRevision }),
    ).rejects.toThrow('Publication failed')
    expect((await store.load()).nativeImports).toBeUndefined()
    expect((await vault.status()).credentials).toHaveLength(0)
  })
})
describe('OpenCode native import transaction', () => {
  it('previews without side effects and publishes encrypted original bytes, referenced secrets and immutable provenance', async () => {
    const before = await readFile(store.filePath, 'utf8')
    await chmod(source, 0o400)
    const captured = await preview()
    expect(captured.credentials).toBe(1)
    expect(captured.entities.map((entity) => entity.collection)).toEqual([
      'connections',
      'models',
      'agents',
      'prompts',
    ])
    expect(JSON.stringify(captured)).not.toMatch(
      /synthetic-import-secret|private-unknown-value|Shared role/,
    )
    expect(await readFile(store.filePath, 'utf8')).toBe(before)
    expect(await readdir(root)).toEqual(
      expect.arrayContaining(['workspace.json', 'opencode.jsonc']),
    )
    expect((await readdir(root)).sort()).toEqual(['opencode.jsonc', 'workspace.json'])
    const saved = await service.apply({
      id: captured.id,
      workspaceRevision: captured.workspaceRevision,
    })
    expect(saved.revision).toBe(captured.workspaceRevision + 1)
    expect(saved.nativeImports).toEqual([captured.record])
    expect(saved.agents[0]).toMatchObject({
      enabled: false,
      execution: { cwd: '', approval: 'ask' },
    })
    const auth = saved.connections[0]!.auth
    expect(auth.kind).toBe('bearer')
    if (auth.kind !== 'bearer' || !auth.secret) throw new Error('Missing credential reference')
    expect(await vault.resolve(auth.secret, {})).toBe(secret)
    const archivePath = join(root, 'native-imports', `${captured.id}.json`)
    for (const path of [store.filePath, vault.filePath, archivePath]) {
      const bytes = await readFile(path, 'utf8')
      expect(bytes).not.toMatch(/synthetic-import-secret|private-unknown-value/)
      if (process.platform !== 'win32') expect((await stat(path)).mode & 0o777).toBe(0o600)
    }
    const encrypted = JSON.parse(await readFile(archivePath, 'utf8'))
    expect(
      Buffer.from(
        (await cipher.decrypt(Buffer.from(encrypted.ciphertext, 'base64'))).value,
        'base64',
      ).toString('utf8'),
    ).toBe(original)
    expect(await readFile(source, 'utf8')).toBe(original)
    await unlink(source)
    const reopened = new NativeImportService(
      store,
      new CredentialVault(vault.filePath, cipher),
      archive,
    )
    await reopened.recover()
    expect(
      await reopened.apply({ id: captured.id, workspaceRevision: captured.workspaceRevision }),
    ).toEqual(saved)
    expect((await vault.status()).credentials).toHaveLength(1)
    await archive.verify(captured.record)
    const modified = structuredClone(saved)
    modified.nativeImports![0]!.diagnostics = []
    await expect(store.save(modified)).rejects.toThrow('error.nativeImportHistory')
    delete modified.nativeImports
    await expect(store.save(modified)).rejects.toThrow('error.nativeImportHistory')
    // Historical provenance outlives user deletion of the imported resources/installations.
    saved.agents = []
    saved.models = []
    saved.connections = []
    saved.prompts = []
    saved.installations = []
    expect((await store.save(saved)).nativeImports).toEqual([captured.record])
  })
  it('rejects forged import history and tampered encrypted archives without publishing a workspace', async () => {
    const captured = await preview()
    const state = await store.load()
    state.nativeImports = [captured.record]
    await expect(store.save(state)).rejects.toThrow('error.nativeImportArchive')
    await archive.save(captured.record, Buffer.from(original))
    const path = join(root, 'native-imports', `${captured.id}.json`)
    const document = JSON.parse(await readFile(path, 'utf8'))
    document.ciphertext = Buffer.from('tampered').toString('base64')
    await writeFile(path, JSON.stringify(document))
    await expect(
      service.apply({ id: captured.id, workspaceRevision: captured.workspaceRevision }),
    ).rejects.toThrow('error.nativeImportArchive')
    expect((await store.load()).nativeImports).toBeUndefined()
    expect((await vault.status()).credentials).toHaveLength(0)
  })
  it('rejects stale workspace revisions without appending entries or credentials', async () => {
    const captured = await preview()
    const current = await store.load()
    current.installations[0]!.name = 'Changed concurrently'
    const saved = await store.save(current)
    await expect(
      service.apply({ id: captured.id, workspaceRevision: captured.workspaceRevision }),
    ).rejects.toThrow('error.conflict')
    expect(await store.load()).toEqual(saved)
    expect((await vault.status()).credentials).toHaveLength(0)
    expect((await readdir(root)).includes('native-imports')).toBe(false)
  })
  it('rechecks source identity, including a symlink that changes targets with identical bytes', async () => {
    const target = source
    source = join(root, 'selected.jsonc')
    await symlink(target, source)
    const captured = await preview()
    const second = join(root, 'second.jsonc')
    await writeFile(second, original)
    await unlink(source)
    await symlink(second, source)
    await expect(
      service.apply({ id: captured.id, workspaceRevision: captured.workspaceRevision }),
    ).rejects.toThrow('error.nativeImportChanged')
    expect((await store.load()).nativeImports).toBeUndefined()
  })
  it('expires or supersedes previews and never trusts client-supplied additions', async () => {
    const first = await preview()
    const second = await preview()
    await expect(
      service.apply({ id: first.id, workspaceRevision: first.workspaceRevision }),
    ).rejects.toThrow('error.nativeImportExpired')
    // A stale token must not cancel the current valid preview.
    await expect(
      service.apply({
        id: second.id,
        workspaceRevision: second.workspaceRevision,
        credentials: [],
      }),
    ).rejects.toThrow()
    expect(
      (await service.apply({ id: second.id, workspaceRevision: second.workspaceRevision }))
        .nativeImports,
    ).toHaveLength(1)
    const fresh = await preview()
    vi.spyOn(Date, 'now').mockReturnValue(new Date(fresh.expiresAt).getTime() + 1)
    await expect(
      service.apply({ id: fresh.id, workspaceRevision: fresh.workspaceRevision }),
    ).rejects.toThrow('error.nativeImportExpired')
  })
  it('bounds input bytes and rejects directories, invalid UTF-8, unavailable encryption and unsupported engines', async () => {
    await expect(service.preview({ installationId: 'missing' }, source)).rejects.toThrow(
      'error.nativeImportEngine',
    )
    await expect(service.preview({ installationId: 'opencode' }, root)).rejects.toThrow(
      'error.nativeImportRead',
    )
    await writeFile(source, Buffer.from([0xff]))
    await expect(preview()).rejects.toThrow('error.nativeImportRead')
    await writeFile(source, ' '.repeat(1_048_577))
    await expect(preview()).rejects.toThrow('error.nativeImportLimit')
    cipher.available = async () => false
    await expect(preview()).rejects.toThrow('error.credentialsUnavailable')
    expect((await vault.status()).credentials).toHaveLength(0)
  })
  it('rolls back staged credentials on publication failure and recovers an ambiguous committed acknowledgment', async () => {
    let captured = await preview()
    const originalSave = store.save.bind(store)
    vi.spyOn(store, 'save').mockRejectedValueOnce(new Error('Failed publication'))
    await expect(
      service.apply({ id: captured.id, workspaceRevision: captured.workspaceRevision }),
    ).rejects.toThrow('Failed publication')
    expect((await vault.status()).credentials).toHaveLength(0)
    expect((await store.load()).nativeImports).toBeUndefined()
    captured = await preview()
    vi.spyOn(store, 'save').mockImplementationOnce(async (input) => {
      await originalSave(input)
      throw new Error('Lost acknowledgment')
    })
    await expect(
      service.apply({ id: captured.id, workspaceRevision: captured.workspaceRevision }),
    ).rejects.toThrow('Lost acknowledgment')
    const committed = await service.apply({
      id: captured.id,
      workspaceRevision: captured.workspaceRevision,
    })
    expect(committed.nativeImports).toHaveLength(1)
    expect((await vault.status()).credentials).toHaveLength(1)
  })
  it('keeps plaintext out of errors when encryption fails', async () => {
    const captured = await preview()
    cipher.encrypt = async () => {
      throw new Error(secret)
    }
    await expect(
      service.apply({ id: captured.id, workspaceRevision: captured.workspaceRevision }),
    ).rejects.toThrow('error.nativeImportArchive')
    expect((await store.load()).nativeImports).toBeUndefined()
  })
})

describe('credential journal recovery', () => {
  it.each([false, true])(
    'recovers after restart using committed import identity: %s',
    async (committed) => {
      const prior = await vault.set({
        name: 'Prior',
        kind: 'api-key',
        value: 'prior-value',
        expectedRevision: null,
      })
      const importId = randomUUID()
      const staged = {
        id: 'staged-key',
        name: 'Staged',
        kind: 'api-key' as const,
        value: secret,
        expectedRevision: null,
      }
      await expect(
        vault.importBatch(
          importId,
          [staged],
          async () => {
            throw new Error('Interrupted')
          },
          async () => {
            throw new Error('Workspace unavailable')
          },
        ),
      ).rejects.toThrow('Interrupted')
      expect(JSON.parse(await readFile(vault.filePath, 'utf8')).pendingImport).toEqual({
        id: importId,
        credentialIds: ['staged-key'],
      })
      await expect(vault.set({ ...staged, id: 'another' })).rejects.toThrow(
        'error.nativeImportRecovery',
      )
      await expect(vault.remove({ id: prior.id, expectedRevision: 1 })).rejects.toThrow(
        'error.nativeImportRecovery',
      )
      await expect(vault.resolve({ kind: 'credential', id: 'staged-key' }, {})).rejects.toThrow(
        'error.nativeImportRecovery',
      )
      const reopened = new CredentialVault(vault.filePath, cipher)
      await reopened.recoverImport(new Set(committed ? [importId] : []))
      expect((await reopened.status()).credentials.map((item) => item.id)).toEqual(
        committed ? [prior.id, 'staged-key'] : [prior.id],
      )
      if (committed)
        expect(await reopened.resolve({ kind: 'credential', id: 'staged-key' }, {})).toBe(secret)
      expect(await reopened.resolve({ kind: 'credential', id: prior.id }, {})).toBe('prior-value')
      expect(JSON.parse(await readFile(vault.filePath, 'utf8'))).not.toHaveProperty('pendingImport')
    },
  )
  it('leaves the prior vault intact if the batch cannot encrypt every credential', async () => {
    await vault.set({
      id: 'prior',
      name: 'Prior',
      kind: 'api-key',
      value: 'prior-value',
      expectedRevision: null,
    })
    const before = await readFile(vault.filePath, 'utf8')
    const encrypt = cipher.encrypt.bind(cipher)
    vi.spyOn(cipher, 'encrypt')
      .mockImplementationOnce(encrypt)
      .mockRejectedValueOnce(new Error(secret))
    const publish = vi.fn()
    await expect(
      vault.importBatch(
        randomUUID(),
        ['one', 'two'].map((id) => ({
          id,
          name: id,
          kind: 'api-key',
          value: secret,
          expectedRevision: null,
        })),
        publish,
        async () => false,
      ),
    ).rejects.toThrow('error.credentialEncryption')
    expect(publish).not.toHaveBeenCalled()
    expect(await readFile(vault.filePath, 'utf8')).toBe(before)
  })
})
