import { createHash } from 'node:crypto'
import * as fs from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  inspectOpenCodePlugin,
  pluginInspectionLimits,
} from '../src/main/engines/adapters/opencode/plugin-inspection'
import { inspectNativePlugin } from '../src/main/engines/plugin-inspection'
import { engineConfigurationIssues } from '../src/shared/engines/validation'
import { resolveAgentProfile } from '../src/shared/engines/resolution'
import { openCodeWorkspace } from './helpers/opencode-fixture'

vi.mock('node:fs/promises', async (original) => {
  const actual = await original<typeof import('node:fs/promises')>()
  return { ...actual, open: vi.fn(actual.open) }
})
const actualFs = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')
let root: string
let plugin: string
const code = 'throw new Error("Inspection must never import this module");\n'
beforeEach(async () => {
  vi.mocked(fs.open).mockClear()
  vi.mocked(fs.open).mockImplementation(actualFs.open)
  root = await fs.realpath(await fs.mkdtemp(join(tmpdir(), 'agentmatrix-plugin-')))
  plugin = join(root, 'installed plugin 中文')
  await fs.mkdir(join(plugin, 'dist'), { recursive: true })
  await fs.writeFile(join(plugin, 'dist', 'server.mjs'), code)
})
afterEach(async () => {
  vi.mocked(fs.open).mockImplementation(actualFs.open)
  await fs.rm(root, { recursive: true, force: true })
})
async function metadata(fields: Record<string, unknown>) {
  await fs.writeFile(join(plugin, 'package.json'), JSON.stringify(fields))
}

describe('read-only installed OpenCode plugin inspection', () => {
  it('resolves a server export before main and returns only bounded metadata and digests', async () => {
    await metadata({
      name: '@fixture/plugin',
      version: '1.2.3',
      engines: { opencode: '^1.18.0' },
      exports: { './server': { import: './dist/server.mjs', default: './missing.mjs' } },
      main: './missing-main.mjs',
      scripts: { install: 'must never execute' },
      privateCredential: 'DO_NOT_RETURN',
    })
    const workspace = openCodeWorkspace(join(root, 'missing-executable'), root)
    const before = structuredClone(workspace)
    const result = await inspectNativePlugin(workspace, { installationId: 'oc', path: plugin })
    expect(result).toMatchObject({
      installationId: 'oc',
      engineVersion: '1.18.16',
      resolverVersion: '1.18.16',
      verification: 'files-only',
      rangeStatus: 'matched',
      selectedPath: plugin,
      localSpecifier: pathToFileURL(plugin).href,
      entryKind: 'server-export',
      entry: {
        path: join(plugin, 'dist', 'server.mjs'),
        sha256: createHash('sha256').update(code).digest('hex'),
        bytes: Buffer.byteLength(code),
      },
      package: { name: '@fixture/plugin', version: '1.2.3', engineRange: '^1.18.0' },
    })
    expect(result.package!.file.sha256).toBe(
      createHash('sha256')
        .update(await fs.readFile(join(plugin, 'package.json')))
        .digest('hex'),
    )
    expect(JSON.stringify(result)).not.toMatch(/DO_NOT_RETURN|must never execute|nativeId/)
    expect(workspace).toEqual(before)
  })

  it.each(['./dist/server.mjs', { default: './dist/server.mjs' }])(
    'accepts a supported server export form: %j',
    async (value) => {
      await metadata({ exports: { './server': value } })
      expect((await inspectOpenCodePlugin(plugin)).entryKind).toBe('server-export')
    },
  )
  it.each(['./dist/server.mjs', pathToFileURL('/PLACEHOLDER').href, '/PLACEHOLDER'])(
    'resolves a package main using native local path forms: %s',
    async (value) => {
      const main = value.replace('/PLACEHOLDER', join(plugin, 'dist', 'server.mjs'))
      await metadata({ main })
      expect((await inspectOpenCodePlugin(plugin)).entryKind).toBe('main')
    },
  )
  it('resolves an adjacent package main even when the user selects another file', async () => {
    await metadata({ main: './dist/server.mjs' })
    await fs.writeFile(join(plugin, 'selected.js'), 'do not use this entry')
    const result = await inspectOpenCodePlugin(join(plugin, 'selected.js'))
    expect(result.entry.path).toBe(join(plugin, 'dist', 'server.mjs'))
    expect(result.entryKind).toBe('main')
  })
  it('does not search ancestor packages or import a standalone module to infer its identity', async () => {
    await metadata({ name: 'unrelated-parent', main: './missing.mjs' })
    const result = await inspectOpenCodePlugin(join(plugin, 'dist', 'server.mjs'))
    expect(result.package).toBeNull()
    expect(result.entryKind).toBe('file')
  })
  it.each([false, true])(
    'inspects index fallback with package exports present: %s',
    async (pkg) => {
      if (pkg) await metadata({ exports: { './tui': './not-a-server.js' } })
      await fs.writeFile(join(plugin, 'index.js'), code)
      await fs.writeFile(join(plugin, 'index.ts'), 'export default {}')
      const result = await inspectOpenCodePlugin(plugin)
      expect(result.entry.path).toBe(join(plugin, 'index.ts'))
      expect(result.entryKind).toBe('index')
    },
  )
  it('preserves a selected installation symlink and reports its physical location', async () => {
    await metadata({ main: './dist/server.mjs' })
    const linked = join(root, 'linked-plugin')
    await fs.symlink(plugin, linked, 'dir')
    const result = await inspectOpenCodePlugin(linked)
    expect(result.selectedPath).toBe(linked)
    expect(result.resolvedPath).toBe(plugin)
    expect(result.entry.resolvedPath).toBe(join(plugin, 'dist', 'server.mjs'))
  })
  it('does not guess an entry for an ambiguous package directory', async () => {
    await metadata({ name: 'ambiguous-package' })
    await fs.writeFile(join(plugin, 'index.js'), code)
    await expect(inspectOpenCodePlugin(plugin)).rejects.toThrow('error.pluginEntry')
  })
  it.each(['../../outside.mjs', 'symlink'])(
    'rejects an escaping package entry: %s',
    async (entry) => {
      await fs.writeFile(join(root, 'outside.mjs'), code)
      const main = entry === 'symlink' ? './link.mjs' : '../outside.mjs'
      if (entry === 'symlink') await fs.symlink(join(root, 'outside.mjs'), join(plugin, 'link.mjs'))
      await metadata({ main })
      await expect(inspectOpenCodePlugin(plugin)).rejects.toThrow('error.pluginOutside')
    },
  )
  it.each(['missing.mjs', 'dist', 'empty.mjs', 'entry.json'])(
    'rejects missing, nonregular, empty, or unsupported entry: %s',
    async (main) => {
      await metadata({ main })
      if (main === 'empty.mjs') await fs.writeFile(join(plugin, main), '')
      if (main === 'entry.json') await fs.writeFile(join(plugin, main), '{}')
      await expect(inspectOpenCodePlugin(plugin)).rejects.toThrow('AGENT_MATRIX_ERROR:')
    },
  )
  it.each(['{bad', '[]', 'null', Buffer.from([0xff])])(
    'rejects malformed package metadata without returning its content',
    async (value) => {
      await fs.writeFile(join(plugin, 'package.json'), value)
      await expect(inspectOpenCodePlugin(plugin)).rejects.toThrow('error.pluginMetadata')
    },
  )
  it.each([{ version: 7 }, { name: 'bad\nname' }, { engines: { opencode: 'x'.repeat(201) } }])(
    'rejects invalid allowlisted metadata fields: %j',
    async (fields) => {
      await metadata({ main: './dist/server.mjs', ...fields })
      await expect(inspectOpenCodePlugin(plugin)).rejects.toThrow('error.pluginMetadata')
    },
  )
  it.each(['metadataBytes', 'entryBytes'] as const)('enforces the %s read limit', async (limit) => {
    const path = join(plugin, limit === 'metadataBytes' ? 'package.json' : 'dist/server.mjs')
    const file = await fs.open(path, 'w')
    await file.truncate(pluginInspectionLimits[limit] + 1)
    await file.close()
    await expect(inspectOpenCodePlugin(limit === 'metadataBytes' ? plugin : path)).rejects.toThrow(
      'error.pluginLimit',
    )
  })
  it('rejects a metadata edit while inspecting the entry', async () => {
    await metadata({ version: '1.0.0', main: './dist/server.mjs' })
    vi.mocked(fs.open).mockImplementation(async (...args) => {
      if (String(args[0]).endsWith('server.mjs'))
        await metadata({ version: '2.0.0', main: './dist/server.mjs' })
      return actualFs.open(...args)
    })
    await expect(inspectOpenCodePlugin(plugin)).rejects.toThrow('error.pluginChanged')
  })
  it('rejects unknown installations and other engines before touching the selected path', async () => {
    const workspace = openCodeWorkspace('/absent', root)
    await expect(
      inspectNativePlugin(workspace, { installationId: 'absent', path: plugin }),
    ).rejects.toThrow('error.pluginEngine')
    workspace.installations[0]!.kind = 'pi'
    await expect(
      inspectNativePlugin(workspace, { installationId: 'oc', path: plugin }),
    ).rejects.toThrow('error.pluginEngine')
    expect(fs.open).not.toHaveBeenCalled()
  })
  it('rejects extra input fields and relative paths', async () => {
    const workspace = openCodeWorkspace('/absent', root)
    await expect(
      inspectNativePlugin(workspace, { installationId: 'oc', path: 'relative' }),
    ).rejects.toThrow()
    await expect(
      inspectNativePlugin(workspace, { installationId: 'oc', path: plugin, execute: true }),
    ).rejects.toThrow()
  })
  it('keeps activation blocked after a successful filesystem inspection', async () => {
    const workspace = openCodeWorkspace('/absent', root)
    await metadata({ version: '1.2.3', main: './dist/server.mjs' })
    await inspectNativePlugin(workspace, { installationId: 'oc', path: plugin })
    workspace.nativePlugins.push({
      id: 'plugin',
      name: 'Plugin',
      engineInstallationId: 'oc',
      nativeId: 'declared-id',
      version: '1.2.3',
      source: 'user supplied',
      path: plugin,
    })
    workspace.agents[0]!.nativePluginIds.push('plugin')
    const resolved = resolveAgentProfile(workspace, 'reviewer')
    if (resolved.status !== 'resolved') throw new Error('Invalid fixture')
    expect(engineConfigurationIssues(resolved.configuration)).toContainEqual({
      code: 'native-plugins',
      field: 'plugins',
      nativeFeature: 'nativePlugins.activation',
    })
  })
})
