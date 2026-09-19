import { mkdir, mkdtemp, realpath, rm, symlink, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { observeExternalFile } from '../src/main/engines/external-sources'
import { matchOpenCodeOverrideSources } from '../src/main/engines/adapters/opencode/override-sources'
import { configurationDiagnosticSchema } from '../src/shared/engines/configuration-report'
import type { RunInputManifest } from '../src/shared/engines/run-inputs'

const roots: string[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})
async function fixture(texts: (string | object)[]) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'agentmatrix-override-sources-')))
  roots.push(root)
  const files = []
  for (const [index, text] of texts.entries()) {
    const directory = join(root, String(index))
    await mkdir(directory)
    const path = join(directory, 'opencode.jsonc')
    await writeFile(path, typeof text === 'string' ? text : JSON.stringify(text))
    files.push(await observeExternalFile(path))
  }
  const manifest = { externalSources: { coverage: 'partial', files } } as RunInputManifest
  return { root, manifest, files }
}
const prompt = (value: unknown) => ({ agent: { build: { prompt: value } } })
const expected = prompt('requested')
const actual = prompt('PRIVATE_NATIVE_BODY')

it('retains all matching declarations without claiming a winner or copying native values', async () => {
  const f = await fixture([actual, expected, actual, { agent: { other: actual.agent.build } }])
  const matches = await matchOpenCodeOverrideSources(f.manifest, expected, actual)
  expect(matches).toEqual([
    { sourceIndex: 0, fields: ['prompts'] },
    { sourceIndex: 2, fields: ['prompts'] },
  ])
  expect(JSON.stringify(matches)).not.toMatch(/PRIVATE|build|agent|opencode|\/tmp/)
  expect(await matchOpenCodeOverrideSources(f.manifest, actual, actual)).toEqual([])
})

it('classifies multiple fields and native permission normalization without copying dynamic names', async () => {
  const requested = {
    provider: {
      'PRIVATE.PROVIDER': { options: { apiKey: 'first', baseURL: 'https://first.test' } },
    },
    agent: { 'PRIVATE.AGENT': { permission: 'ask', temperature: 0.2 } },
    mcp: { private: { enabled: true } },
  }
  const declared = {
    provider: {
      'PRIVATE.PROVIDER': { options: { apiKey: 'PRIVATE_KEY', baseURL: 'https://private.test' } },
    },
    agent: { 'PRIVATE.AGENT': { permission: 'deny', temperature: 0 } },
    mcp: { private: { enabled: false } },
  }
  const native = {
    ...declared,
    agent: { 'PRIVATE.AGENT': { permission: { '*': 'deny', read: 'deny' }, temperature: 0 } },
  }
  const f = await fixture([declared])
  expect(await matchOpenCodeOverrideSources(f.manifest, requested, native)).toEqual([
    { sourceIndex: 0, fields: ['connection', 'authentication', 'sampling', 'execution', 'mcp'] },
  ])
})

it.each(['macro', 'duplicate', 'malformed', 'oversized', 'changed', 'deleted', 'invalid-utf8'])(
  'keeps %s sources unassigned without changing the primary failure',
  async (kind) => {
    const f = await fixture([actual])
    const path = f.files[0]!.path
    if (kind === 'macro')
      await writeFile(path, JSON.stringify(prompt('{file:/PRIVATE_UNSELECTED}')))
    if (kind === 'duplicate') await writeFile(path, '{"agent":{},"agent":{}}')
    if (kind === 'malformed') await writeFile(path, 'PRIVATE_INVALID_JSON')
    if (kind === 'oversized') await writeFile(path, ' '.repeat(1_048_577))
    if (kind === 'changed') await writeFile(path, JSON.stringify(expected))
    if (kind === 'deleted') await unlink(path)
    if (kind === 'invalid-utf8') await writeFile(path, Buffer.from([255]))
    if (!['changed', 'deleted'].includes(kind)) f.files[0] = await observeExternalFile(path)
    expect(await matchOpenCodeOverrideSources(f.manifest, expected, actual)).toEqual([])
  },
)

it('requires the captured target and digest, ignores other file types, and honors cancellation', async () => {
  const f = await fixture([actual, actual])
  const target = f.files[1]!.path
  await unlink(f.files[0]!.path)
  await symlink(target, f.files[0]!.path)
  const unrelated = join(f.root, 'package.json')
  await writeFile(unrelated, JSON.stringify(actual))
  f.files[1] = await observeExternalFile(unrelated)
  expect(await matchOpenCodeOverrideSources(f.manifest, expected, actual)).toEqual([])
  f.files[0] = await observeExternalFile(target)
  const controller = new AbortController()
  controller.abort()
  expect(
    await matchOpenCodeOverrideSources(f.manifest, expected, actual, controller.signal),
  ).toEqual([])
})

it('supports legacy diagnostics but rejects forged source metadata and inconsistent field claims', () => {
  const valid = {
    check: 'opencode-config',
    reason: 'mismatch',
    fields: ['prompts'],
    sourceMatches: [{ sourceIndex: 1, fields: ['prompts'] }],
  }
  expect(configurationDiagnosticSchema.safeParse(valid).success).toBe(true)
  expect(
    configurationDiagnosticSchema.safeParse({ ...valid, sourceMatches: undefined }).success,
  ).toBe(true)
  for (const invalid of [
    { ...valid, check: 'pi-state' },
    { ...valid, reason: 'unavailable' },
    { ...valid, sourceMatches: [{ sourceIndex: -1, fields: ['prompts'] }] },
    { ...valid, sourceMatches: [{ sourceIndex: 1000, fields: ['prompts'] }] },
    { ...valid, sourceMatches: [{ sourceIndex: 1, fields: ['connection'] }] },
    { ...valid, sourceMatches: [valid.sourceMatches[0], valid.sourceMatches[0]] },
    { ...valid, sourceMatches: [{ ...valid.sourceMatches[0], path: '/PRIVATE_PATH' }] },
    { ...valid, sourceMatches: [{ ...valid.sourceMatches[0], value: 'PRIVATE_KEY' }] },
  ])
    expect(configurationDiagnosticSchema.safeParse(invalid).success).toBe(false)
})
