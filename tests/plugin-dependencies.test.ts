import { mkdir, mkdtemp, open, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import {
  literalPluginReferences,
  observePluginDependencies,
} from '../src/main/engines/plugin-dependencies'
import { observeExternalFile, verifyExternalSources } from '../src/main/engines/external-sources'
import { generatedInputsSchema, type GeneratedInputs } from '../src/shared/engines/run-inputs'

let root: string, generated: GeneratedInputs
beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), 'agentmatrix-plugin-dependencies-')))
  await writeFile(
    join(root, 'package.json'),
    '{"type":"module","privateCredential":"PRIVATE_METADATA"}',
  )
  generated = {
    adapter: { id: 'fixture', version: '1' },
    launch: { mode: 'pi-rpc', args: [], environment: {} },
    files: [],
    promptPaths: {},
    skillPaths: {},
    externalSources: { coverage: 'partial', files: [] },
  }
})
afterEach(() => rm(root, { recursive: true, force: true }))
async function inspect(paths = ['entry.mjs'], id = 'plugin') {
  const entries = await Promise.all(paths.map((path) => observeExternalFile(join(root, path))))
  if (entries.some((file) => !file.exists)) throw new Error('Invalid fixture entry')
  await observePluginDependencies(
    generated,
    id,
    entries.filter((file) => file.exists),
  )
  return generatedInputsSchema.parse(generated)
}
it('extracts runtime references without evaluating source and excludes type-only imports', () => {
  const result = literalPluginReferences(`
    import type { Only } from './types.ts'; import { type Other } from './other-types.ts';
    export type { A } from './a-types.ts'; export { value } from './value.mjs';
    import './side.mjs'; const file = require('./file.cjs');
    const lazy = import('./lazy.ts'); const computed = import(process.env.PRIVATE);
    import alias = require('./alias.cjs');
    throw new Error('Do not execute');
  `)
  expect(result.references.map((item) => item.value).sort()).toEqual([
    './alias.cjs',
    './file.cjs',
    './lazy.ts',
    './side.mjs',
    './value.mjs',
  ])
  expect(result.unobserved).toEqual({ dynamic: 1 })
})
it.each([
  "function f(require) { require('./private.cjs') }",
  "const require = loader; require('./private.cjs')",
  "const f = function require() { require('./private.cjs') }",
  "require = loader; require('./private.cjs')",
])('does not infer the target of a shadowed require: %s', (source) => {
  expect(literalPluginReferences(source)).toEqual({ references: [], unobserved: { dynamic: 1 } })
})
it('captures cycles, literal lazy imports, JSON, package scopes and explicit unknown categories', async () => {
  await mkdir(join(root, 'lib'))
  await writeFile(
    join(root, 'entry.mjs'),
    `import './lib/a.mjs'; import('./lazy.ts'); import 'PRIVATE_PACKAGE'; import('https://private.invalid/SECRET'); import('./extensionless'); import(process.env.SECRET);`,
  )
  await writeFile(
    join(root, 'lib/a.mjs'),
    `import '../entry.mjs'; import './data.json' with { type:'json' }; export { b } from './b.cjs';`,
  )
  await writeFile(
    join(root, 'lib/b.cjs'),
    `require('node:fs'); require('./data.json'); exports.b = 'PRIVATE_SOURCE';`,
  )
  await writeFile(join(root, 'lib/data.json'), '{"key":"PRIVATE_DATA"}')
  await writeFile(join(root, 'lazy.ts'), `export const lazy: string = 'PRIVATE_LAZY';`)
  const captured = await inspect()
  const binding = captured.externalSources.pluginDependencies!.bindings[0]!
  expect(binding.files).toEqual(
    expect.arrayContaining(
      [
        'entry.mjs',
        'lib/a.mjs',
        'lib/b.cjs',
        'lib/data.json',
        'lazy.ts',
        'package.json',
        'lib/package.json',
      ].map((path) => join(root, path)),
    ),
  )
  expect(
    captured.externalSources.files.find((file) => file.path === join(root, 'lib/package.json')),
  ).toEqual({ path: join(root, 'lib/package.json'), exists: false })
  expect(binding.unobserved).toEqual(
    expect.arrayContaining([
      { source: join(root, 'entry.mjs'), reason: 'dynamic', count: 1 },
      { source: join(root, 'entry.mjs'), reason: 'package', count: 1 },
      { source: join(root, 'entry.mjs'), reason: 'resolution', count: 2 },
    ]),
  )
  expect(JSON.stringify(captured)).not.toMatch(/PRIVATE|SECRET|private.invalid/)
  await verifyExternalSources(captured.externalSources)
  await writeFile(join(root, 'lib/data.json'), '{"key":"changed"}')
  await expect(verifyExternalSources(captured.externalSources)).rejects.toThrow(
    'error.runSourceChanged',
  )
})
it.each(['missing', 'package'])(
  'rejects newly appearing %s files that change captured resolution',
  async (target) => {
    await mkdir(join(root, 'lib'))
    await writeFile(join(root, 'entry.mjs'), `import './lib/module.mjs'`)
    if (target === 'package') await writeFile(join(root, 'lib/module.mjs'), 'export default 1')
    const captured = await inspect()
    await writeFile(join(root, target === 'package' ? 'lib/package.json' : 'lib/module.mjs'), '{}')
    await expect(verifyExternalSources(captured.externalSources)).rejects.toThrow(
      'error.runSourceChanged',
    )
  },
)
it('captures physical symlink dependencies and rejects retargeting with identical bytes', async () => {
  await writeFile(join(root, 'entry.mjs'), `import './linked.mjs'`)
  await writeFile(join(root, 'first.mjs'), 'export default 1')
  await writeFile(join(root, 'second.mjs'), 'export default 1')
  await symlink(join(root, 'first.mjs'), join(root, 'linked.mjs'))
  const captured = await inspect()
  expect(
    captured.externalSources.files.find((file) => file.path === join(root, 'linked.mjs')),
  ).toMatchObject({ resolvedPath: join(root, 'first.mjs') })
  await rm(join(root, 'linked.mjs'))
  await symlink(join(root, 'second.mjs'), join(root, 'linked.mjs'))
  await expect(verifyExternalSources(captured.externalSources)).rejects.toThrow(
    'error.runSourceChanged',
  )
})
it('leaves directory resolution unknown instead of declaring a native directory import invalid', async () => {
  await mkdir(join(root, 'directory.mjs'))
  await writeFile(join(root, 'entry.mjs'), `import './directory.mjs'`)
  const captured = await inspect()
  expect(captured.externalSources.pluginDependencies!.bindings[0]!.unobserved).toEqual([
    { source: join(root, 'entry.mjs'), reason: 'resolution', count: 1 },
  ])
  expect(
    captured.externalSources.files.some((file) => file.path === join(root, 'directory.mjs')),
  ).toBe(false)
})
it.each(['syntax', 'source-limit'] as const)(
  'preserves explicit %s limitations',
  async (reason) => {
    await writeFile(
      join(root, 'entry.mjs'),
      reason === 'syntax' ? Buffer.from([0xff]) : ' '.repeat(2 * 1024 * 1024 + 1),
    )
    const captured = await inspect()
    expect(captured.externalSources.pluginDependencies!.bindings[0]!.unobserved).toEqual([
      { source: join(root, 'entry.mjs'), reason, count: 1 },
    ])
  },
)
it('deduplicates shared dependencies while retaining each binding and legacy schema semantics', async () => {
  await writeFile(join(root, 'entry.mjs'), `import './shared.mjs'`)
  await writeFile(join(root, 'second.mjs'), `import './shared.mjs'`)
  await writeFile(join(root, 'shared.mjs'), 'export const x = 1')
  await inspect()
  const captured = await inspect(['second.mjs'], 'second')
  expect(
    captured.externalSources.files.filter((file) => file.path === join(root, 'shared.mjs')),
  ).toHaveLength(1)
  expect(
    captured.externalSources.pluginDependencies!.bindings.every((binding) =>
      binding.files.includes(join(root, 'shared.mjs')),
    ),
  ).toBe(true)
  const invalid = structuredClone(captured)
  invalid.externalSources.pluginDependencies!.bindings[0]!.files.push('/unobserved/file')
  expect(generatedInputsSchema.safeParse(invalid).success).toBe(false)
  delete captured.externalSources.pluginDependencies
  expect(generatedInputsSchema.parse(captured)).toEqual(captured)
})
it('does not accept a stale selected-entry observation', async () => {
  await writeFile(join(root, 'entry.mjs'), 'export default 1')
  const entry = await observeExternalFile(join(root, 'entry.mjs'))
  if (!entry.exists) throw new Error('Missing entry')
  await writeFile(join(root, 'entry.mjs'), 'export default 2')
  await expect(observePluginDependencies(generated, 'plugin', [entry])).rejects.toThrow(
    'error.pluginChanged',
  )
})
it('enforces a bounded number of observed source files', async () => {
  await writeFile(join(root, 'entry.mjs'), 'export default 1')
  generated.externalSources.files = Array.from({ length: 1000 }, (_, index) => ({
    path: join(root, String(index)),
    exists: false,
  }))
  await expect(inspect()).rejects.toThrow('error.pluginDependencyLimit')
})
it('enforces the aggregate source byte limit without parsing large modules', async () => {
  const paths = ['a.mjs', 'b.mjs', 'c.mjs', 'd.mjs']
  for (const path of paths) {
    const file = await open(join(root, path), 'w')
    await file.truncate(17_000_000)
    await file.close()
  }
  await expect(inspect(paths)).rejects.toThrow('error.pluginDependencyLimit')
})
