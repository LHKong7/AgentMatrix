import { execFile } from 'node:child_process'
import {
  mkdir,
  mkdtemp,
  open,
  realpath,
  rename,
  rm,
  symlink,
  unlink,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { inspectOpenCodeSources } from '../src/main/engines/adapters/opencode/sources'
import { observeInstructionSearches } from '../src/main/engines/instruction-sources'
import { verifyExternalSources } from '../src/main/engines/external-sources'
import { instructionSourcesSchema, generatedInputsSchema } from '../src/shared/engines/run-inputs'

let root: string, cwd: string, home: string, configHome: string
beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), 'agentmatrix-instruction-sources-')))
  cwd = join(root, 'project/nested')
  home = join(root, 'home')
  configHome = join(root, 'config')
  for (const path of [cwd, home, configHome, join(root, 'project/.git')])
    await mkdir(path, { recursive: true })
})
afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})
const put = async (path: string, content = 'PRIVATE_RULE_BODY') => {
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, content)
}
const config = (values: unknown[], path = join(cwd, 'opencode.json')) =>
  put(path, JSON.stringify({ instructions: values }))
const inspect = () => inspectOpenCodeSources(cwd, { home, configHome })
const paths = (result: Awaited<ReturnType<typeof inspect>>) =>
  result.instructionSources!.patterns.flatMap((item) => item.files.map((file) => file.path))

it('matches relative selectors at each project ancestor, absolute paths and home paths without copying bodies', async () => {
  for (const path of [
    join(cwd, 'rules/.hidden.txt'),
    join(cwd, 'rules/a.md'),
    join(root, 'project/rules/b.md'),
    join(home, 'global.md'),
  ])
    await put(path)
  await config(['rules/*.{md,txt}', '~/global.md', join(cwd, 'rules/*.txt')])
  const result = await inspect()
  expect(paths(result).sort()).toEqual(
    [
      join(cwd, 'rules/.hidden.txt'),
      join(cwd, 'rules/a.md'),
      join(root, 'project/rules/b.md'),
      join(home, 'global.md'),
    ].sort(),
  )
  // Per-selector order is retained; file matches themselves are sorted and deduplicated.
  expect(result.instructionSources!.patterns[2]!.files).toEqual([])
  expect(JSON.stringify(result)).not.toContain('PRIVATE_RULE_BODY')
  await expect(verifyExternalSources(result)).resolves.toBeUndefined()
})

it.each(['edit', 'add', 'delete', 'rename', 'empty-match'] as const)(
  'rejects %s while the declaring JSON stays unchanged',
  async (change) => {
    const file = join(cwd, 'rules/first.txt')
    if (change !== 'empty-match') await put(file)
    await config(['rules/*.txt'])
    const result = await inspect()
    if (change === 'edit') await writeFile(file, 'CHANGED')
    if (change === 'add' || change === 'empty-match') await put(join(cwd, 'rules/new.txt'))
    if (change === 'delete') await unlink(file)
    if (change === 'rename') await rename(file, join(cwd, 'rules/moved.txt'))
    await expect(verifyExternalSources(result)).rejects.toThrow('error.runSourceChanged')
  },
)

it('tracks symlink targets and their creation, including unchanged bytes at another target', async () => {
  const first = join(root, 'first'),
    second = join(root, 'second'),
    link = join(cwd, 'linked.md')
  await put(first)
  await put(second)
  await symlink(first, link)
  await config(['linked.md'])
  const result = await inspect()
  await unlink(link)
  await symlink(second, link)
  await expect(verifyExternalSources(result)).rejects.toThrow('error.runSourceChanged')
  await unlink(second)
  const missing = await inspect()
  await put(second)
  await expect(verifyExternalSources(missing)).rejects.toThrow('error.runSourceChanged')
})

it('records remote/dynamic/unreadable scope without URLs, macros, body text or execution', async () => {
  await config([
    'https://PRIVATE.invalid/key?secret=PRIVATE',
    '{env:PRIVATE}',
    '{file:/PRIVATE}',
    'missing.md',
  ])
  await put(join(configHome, 'opencode/config.json'), 'INVALID_PRIVATE_CONFIG')
  const result = await inspect()
  expect(result.instructionSources!.unobserved.map((item) => item.reason).sort()).toEqual([
    'configuration',
    'dynamic',
    'dynamic',
    'remote',
  ])
  expect(result.instructionSources!.patterns).toHaveLength(1)
  expect(JSON.stringify(result)).not.toContain('PRIVATE')
  expect(instructionSourcesSchema.safeParse(result.instructionSources).success).toBe(true)
})

it('ignores unmatched changes while tracking selectors declared in global JSONC', async () => {
  await put(
    join(configHome, 'opencode/opencode.jsonc'),
    '{ // comment\n "instructions": ["rules/*.md",], }',
  )
  await put(join(cwd, 'rules/one.md'))
  const result = await inspect()
  await put(join(cwd, 'rules/ignore.txt'))
  await expect(verifyExternalSources(result)).resolves.toBeUndefined()
  expect(paths(result)).toEqual([join(cwd, 'rules/one.md')])
})

it('rejects truncated brace expansion instead of silently observing a subset', async () => {
  await expect(
    observeInstructionSearches([{ cwd, pattern: '{1..100000000}.md', dot: true }]),
  ).rejects.toThrow('error.runIntegrity')
})
it('rejects excessive file size without retaining file bytes', async () => {
  const path = join(cwd, 'large.md'),
    file = await open(path, 'w')
  await file.truncate(20_000_001)
  await file.close()
  await expect(
    observeInstructionSearches([{ cwd, pattern: 'large.md', dot: true }]),
  ).rejects.toThrow('error.runIntegrity')
})
it.runIf(process.platform !== 'win32')('rejects a matched FIFO without blocking', async () => {
  await promisify(execFile)('mkfifo', [join(cwd, 'rule.md')])
  await expect(
    observeInstructionSearches([{ cwd, pattern: 'rule.md', dot: true }]),
  ).rejects.toThrow('error.runIntegrity')
})
it('leaves legacy manifests without synthesized observations', () => {
  const schema = generatedInputsSchema.shape.externalSources
  expect(schema.parse({ coverage: 'partial', files: [] })).toEqual({
    coverage: 'partial',
    files: [],
  })
})
