import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import {
  link,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { RedactionHistory } from '../src/main/credentials/redaction-history'
import type { SecretCipher } from '../src/main/credentials/vault'
import { RunInputStore } from '../src/main/engines/run-input-store'
import { prepareRunLaunch } from '../src/main/engines/run-launch'
import { SkillDirectoryStore } from '../src/main/assets/skill-directory-store'
import { planOpenCode } from '../src/main/engines/adapters/opencode/configuration'
import { redactText } from '../src/main/engines/process/redacted-tail'
import { openCodeWorkspace } from './helpers/opencode-fixture'

let root: string
let cipher: SecretCipher
let history: RedactionHistory
const identity = { id: 'capture', digest: 'a'.repeat(64) }
const oldKey = 'retired-key/中文"{value}',
  currentKey = 'current-key-value'

beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), 'agentmatrix-redaction-history-')))
  const key = randomBytes(32)
  cipher = {
    available: async () => true,
    encrypt: vi.fn(async (value) => {
      const iv = randomBytes(12),
        stream = createCipheriv('aes-256-gcm', key, iv)
      return Buffer.concat([iv, stream.update(value, 'utf8'), stream.final(), stream.getAuthTag()])
    }),
    decrypt: vi.fn(async (value) => {
      const stream = createDecipheriv('aes-256-gcm', key, value.subarray(0, 12))
      stream.setAuthTag(value.subarray(-16))
      return {
        value: Buffer.concat([stream.update(value.subarray(12, -16)), stream.final()]).toString(
          'utf8',
        ),
        reencrypt: false,
      }
    }),
  }
  history = new RedactionHistory(cipher)
})
afterEach(() => rm(root, { recursive: true, force: true }))

it('retains only encrypted values across reopening and masks retired key encodings', async () => {
  await history.initialize(root, identity)
  await history.retain(root, identity, [oldKey])
  const reopened = new RedactionHistory(cipher)
  const values = await reopened.retain(root, identity, [currentKey, currentKey])
  expect(values).toEqual([oldKey, currentKey])
  expect(
    redactText(
      `${oldKey} ${encodeURIComponent(oldKey)} ${JSON.stringify(oldKey)} ${currentKey}`,
      values,
    ),
  ).toBe('[redacted] [redacted] "[redacted]" [redacted]')
  const encrypted = await readFile(join(root, 'redactions.enc'))
  expect(encrypted.includes(Buffer.from(oldKey))).toBe(false)
  expect(encrypted.includes(Buffer.from(currentKey))).toBe(false)
  expect((await stat(join(root, 'redactions.enc'))).mode & 0o777).toBe(0o600)
})

it.each(['missing', 'corrupt', 'symlink', 'hardlink', 'fifo', 'wrong-id', 'wrong-digest'])(
  'rejects %s history without replacing it or exposing native error text',
  async (kind) => {
    await history.initialize(root, identity)
    const path = join(root, 'redactions.enc')
    if (kind === 'missing') await rm(path)
    if (kind === 'corrupt') await writeFile(path, 'private-corrupt-data')
    if (kind === 'symlink') {
      await rm(path)
      await writeFile(join(root, 'target'), 'private-linked-data')
      await symlink(join(root, 'target'), path)
    }
    if (kind === 'hardlink') await link(path, join(root, 'copy'))
    if (kind === 'fifo') {
      await rm(path)
      execFileSync('mkfifo', [path])
    }
    const encryptionCalls = vi.mocked(cipher.encrypt).mock.calls.length
    await expect(
      history.retain(
        root,
        {
          id: kind === 'wrong-id' ? 'different' : identity.id,
          digest: kind === 'wrong-digest' ? 'b'.repeat(64) : identity.digest,
        },
        [currentKey],
      ),
    ).rejects.toThrow('error.credentialRedactionHistory')
    expect(vi.mocked(cipher.encrypt).mock.calls).toHaveLength(encryptionCalls)
  },
)

it('preserves prior ciphertext when encryption fails and retries without losing retired keys', async () => {
  await history.initialize(root, identity)
  await history.retain(root, identity, [oldKey])
  const before = await readFile(join(root, 'redactions.enc'))
  vi.mocked(cipher.encrypt).mockRejectedValueOnce(new Error('private-encryption-message'))
  await expect(history.retain(root, identity, [currentKey])).rejects.toThrow(
    'error.credentialRedactionHistory',
  )
  expect(await readFile(join(root, 'redactions.enc'))).toEqual(before)
  expect(await readdir(root)).toEqual(['redactions.enc'])
  expect(await history.retain(root, identity, [currentKey])).toEqual([oldKey, currentKey])
})

it('rejects an unavailable backend and bounded-history overflow without discarding old keys', async () => {
  await history.initialize(root, identity)
  const keys = Array.from({ length: 256 }, (_, index) => `key-${index}`)
  await history.retain(root, identity, keys)
  const before = await readFile(join(root, 'redactions.enc'))
  await expect(history.retain(root, identity, ['one-too-many'])).rejects.toThrow(
    'error.credentialRedactionLimit',
  )
  expect(await readFile(join(root, 'redactions.enc'))).toEqual(before)
  cipher.available = async () => false
  await expect(history.retain(root, identity, [])).rejects.toThrow('error.credentialsUnavailable')
})

async function storeFixture(secure = true, prefixArgs: string[] = []) {
  const executable = join(root, 'fake-engine'),
    cwd = join(root, 'project')
  await writeFile(executable, 'synthetic engine')
  await mkdir(cwd, { recursive: true })
  const workspace = openCodeWorkspace(executable, cwd)
  workspace.installations[0]!.prefixArgs = prefixArgs
  const skills = new SkillDirectoryStore(join(root, 'skills'))
  const store = new RunInputStore(join(root, 'runs'), skills, secure ? cipher : undefined)
  const create = (id: string) =>
    store.create(id, workspace, 'reviewer', (configuration, paths) =>
      planOpenCode(configuration, paths, {
        configHome: root,
        sources: { coverage: 'partial', files: [] },
        readSkillEntry: async () => '',
      }),
    )
  return { store, skills, create }
}

const argumentEncodings = {
  raw: (value: string) => value,
  JSON: (value: string) => JSON.stringify(value).slice(1, -1),
  URL: (value: string) => encodeURIComponent(value),
  nativeTemplate: (value: string) => JSON.stringify(value).slice(1, -1).replaceAll('{', '\\u007b'),
}
it.each(
  Object.entries(argumentEncodings).flatMap(([encoding, encode]) =>
    (['current', 'retired', 'legacy'] as const).map((scope) => ({ encoding, encode, scope })),
  ),
)(
  'rejects $scope $encoding credentials in arguments without rewriting captured inputs',
  async ({ encode, scope }) => {
    const { store, create } = await storeFixture(scope !== 'legacy', [`--custom=${encode(oldKey)}`])
    const manifest = await create('argument-boundary')
    if (scope === 'retired')
      await store.retainRedactions(manifest, [oldKey, argumentEncodings.nativeTemplate(oldKey)])
    const before = await readFile(join(store.paths(manifest.id).root, 'manifest.json'))
    const resolve = vi.fn(async () => (scope === 'retired' ? currentKey : oldKey))
    await expect(prepareRunLaunch(store, manifest.id, resolve, {})).rejects.toThrow(
      'error.runConfiguration',
    )
    expect(resolve).toHaveBeenCalledTimes(1)
    expect(await readFile(join(store.paths(manifest.id).root, 'manifest.json'))).toEqual(before)
    expect(await store.verifyForReuse(manifest.id)).toEqual(manifest)
  },
)

it('allows unrelated argument prefixes and resolves only current references into the environment', async () => {
  const { store, create } = await storeFixture(true, ['--custom=r'])
  const manifest = await create('safe-arguments')
  const resolver = vi.fn(async () => oldKey)
  const result = await prepareRunLaunch(store, manifest.id, resolver, {
    UNSELECTED_API_KEY: 'unrelated-key',
  })
  expect(result.launch.args).toEqual(manifest.launch.args)
  expect(result.launch.environment.UNSELECTED_API_KEY).toBeUndefined()
  expect(result.launch.secrets).toContain(oldKey)
  expect(resolver).toHaveBeenCalledTimes(1)
})

it('serializes history updates, never injects retired keys, and removes history with run data', async () => {
  const { store, skills, create } = await storeFixture()
  const manifest = await create('capture')
  expect(manifest.redactionHistoryVersion).toBe(1)
  const before = await readFile(join(store.paths('capture').root, 'manifest.json'))
  await prepareRunLaunch(store, 'capture', async () => oldKey, {})
  const reopened = new RunInputStore(store.root, skills, cipher)
  const result = await prepareRunLaunch(reopened, 'capture', async () => currentKey, {})
  expect(result.launch.secrets).toContain(oldKey)
  expect(result.launch.secrets).toContain(currentKey)
  expect(JSON.stringify(result.launch.environment)).not.toContain(oldKey)
  expect(Object.values(result.launch.environment)).toContain(currentKey)
  await Promise.all([
    reopened.retainRedactions(manifest, ['concurrent-one']),
    reopened.retainRedactions(manifest, ['concurrent-two']),
  ])
  expect(await reopened.retainRedactions(manifest, [])).toEqual(
    expect.arrayContaining(['concurrent-one', 'concurrent-two', oldKey, currentKey]),
  )
  expect(await readFile(join(store.paths('capture').root, 'manifest.json'))).toEqual(before)
  await reopened.remove('capture')
  await expect(stat(join(store.paths('capture').root, 'redactions.enc'))).rejects.toMatchObject({
    code: 'ENOENT',
  })
})

it('isolates captures and fails launch on missing required history or a deleted credential', async () => {
  const { store, create } = await storeFixture()
  await create('first')
  await create('second')
  await prepareRunLaunch(store, 'first', async () => oldKey, {})
  const { launch } = await prepareRunLaunch(store, 'second', async () => currentKey, {})
  expect(launch.secrets).not.toContain(oldKey)
  await expect(
    prepareRunLaunch(
      store,
      'first',
      async () => {
        throw new Error('credential missing')
      },
      {},
    ),
  ).rejects.toThrow('credential missing')
  await rm(join(store.paths('first').root, 'redactions.enc'))
  await expect(prepareRunLaunch(store, 'first', async () => currentKey, {})).rejects.toThrow(
    'error.credentialRedactionHistory',
  )
})

it('does not synthesize history or change digests for legacy captures', async () => {
  const { store, create, skills } = await storeFixture(false)
  const manifest = await create('legacy')
  expect(Object.hasOwn(manifest, 'redactionHistoryVersion')).toBe(false)
  const reopened = new RunInputStore(store.root, skills, cipher)
  expect(await reopened.verifyForReuse('legacy')).toEqual(manifest)
  expect(
    (await prepareRunLaunch(reopened, 'legacy', async () => currentKey, {})).launch.secrets,
  ).toEqual([currentKey])
  expect(vi.mocked(cipher.encrypt)).not.toHaveBeenCalled()
})

it('does not publish a capture when secure storage is unavailable', async () => {
  const { store, create } = await storeFixture()
  cipher.available = async () => false
  await expect(create('unavailable')).rejects.toThrow('error.credentialsUnavailable')
  expect(await readdir(store.root)).toEqual([])
})
