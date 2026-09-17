import { engineContracts } from '../../../../shared/engines/contracts'
import { createRequire } from 'node:module'
import { createHash } from 'node:crypto'
import { dirname, join } from 'node:path'
import { lstat, opendir, readFile, realpath } from 'node:fs/promises'
import { parseDocument, stringify, type ScalarTag } from 'yaml'
import { z } from 'zod'
import { appError } from '../../../../shared/errors'
import type { GeneratedInputs } from '../../../../shared/engines/run-inputs'
import { observeExternalFile } from '../../run-input-store'

export const dshContract = engineContracts['deepseek-harness']
export const dshBundles = ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-acp-app'] as const
const rowSchema = z.looseObject({ id: z.string(), name: z.string().optional() })
export type DshRow = z.infer<typeof rowSchema>
// Native JavaScript tags are represented as data, never evaluated in Electron.
export class DshExpression {
  constructor(readonly source: string) {}
}
const expressionTag: ScalarTag = {
  tag: 'tag:yaml.org,2002:js',
  identify: (value) => value instanceof DshExpression,
  resolve: (value) => new DshExpression(value),
  stringify: (node) => JSON.stringify((node.value as DshExpression).source),
}
export function parseDshYaml(text: string): unknown {
  if (Buffer.byteLength(text) > 4_194_304) throw new Error('DSH configuration limit')
  const doc = parseDocument(text, {
    customTags: [expressionTag],
    uniqueKeys: true,
    stringKeys: true,
  })
  if (doc.errors.length || doc.warnings.length) throw new Error('Invalid DSH configuration')
  return doc.toJS({ maxAliasCount: 0 })
}
export const writeDshYaml = (value: unknown) => stringify(value, { customTags: [expressionTag] })
export const dshUnsupported = (feature: string): never => {
  throw appError('error.dshConfiguration', { feature })
}
export interface DshComposition {
  rows: DshRow[]
  entries: Record<string, string>
  components: { name: string; version: string; manifest: string; entry: string }[]
  sources: GeneratedInputs['externalSources']
}
const packageSchema = z.looseObject({ name: z.string(), version: z.string() })

/** Inspect only installed files. Do not import engine code or run a package manager. */
export async function inspectDshComposition(
  executable: string,
  cwd: string,
): Promise<DshComposition> {
  try {
    const bin = await realpath(executable)
    const require = createRequire(bin)
    const files = new Set<string>([executable])
    const inspected = new Map<string, string>()
    async function readInspected(path: string) {
      const observed = await observeExternalFile(path)
      if (!observed.exists || observed.bytes > 4_194_304)
        return dshUnsupported('composition.source')
      const bytes = await readFile(path)
      if (createHash('sha256').update(bytes).digest('hex') !== observed.sha256)
        return dshUnsupported('composition.changed')
      inspected.set(path, observed.sha256)
      return new TextDecoder('utf-8', { fatal: true }).decode(bytes)
    }
    const components: DshComposition['components'] = []
    const entries: Record<string, string> = {}
    const roots: Record<string, string> = {}
    const scanned = new Set<string>()
    async function inspectLibrary(directory: string, depth = 0): Promise<void> {
      if (depth > 20 || files.size > 800) return dshUnsupported('composition.limit')
      const stat = await lstat(directory).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== 'ENOENT') throw error
        return null
      })
      if (!stat) return
      if (!stat.isDirectory()) return dshUnsupported('composition.library')
      const entries = await opendir(directory)
      for await (const entry of entries) {
        if (entry.name === 'node_modules' || entry.name === 'types') continue
        const path = join(directory, entry.name)
        if (entry.isDirectory()) await inspectLibrary(path, depth + 1)
        else if (/\.(?:[cm]?js|json|node|wasm)$/.test(entry.name)) {
          if (!entry.isFile()) return dshUnsupported('composition.library')
          files.add(path)
        }
      }
    }
    async function component(name: string, entry = require.resolve(name)) {
      if (roots[name]) return roots[name]!
      const expectedName = name.split('/').slice(0, 2).join('/')
      let directory = dirname(await realpath(entry))
      for (let depth = 0; ; depth++) {
        const path = join(directory, 'package.json')
        const manifest = await readInspected(path)
          .then((text) => packageSchema.parse(JSON.parse(text)))
          .catch(() => null)
        if (manifest?.name === expectedName) {
          if (name.startsWith('@deepseek-ai/dsh') && manifest.version !== dshContract.engineVersion)
            return dshUnsupported('component.version')
          files.add(path)
          files.add(entry)
          components.push({ name, version: manifest.version, manifest: path, entry })
          entries[name] = entry
          roots[name] = directory
          if (!scanned.has(directory)) {
            scanned.add(directory)
            await inspectLibrary(join(directory, 'lib'))
          }
          return directory
        }
        const parent = dirname(directory)
        if (depth >= 20 || parent === directory) return dshUnsupported('component.manifest')
        directory = parent
      }
    }
    await component('@deepseek-ai/dsh', bin)
    const rows: DshRow[] = []
    for (const name of dshBundles) {
      const root = await component(name)
      const patch = join(root, 'cordis.patch.yml')
      files.add(patch)
      for (const item of z
        .array(z.record(z.string(), z.unknown()))
        .parse(parseDshYaml(await readInspected(patch)))) {
        if (Array.isArray(item.insert)) {
          for (const row of item.insert) rows.push(rowSchema.parse(row))
        } else {
          const row = rowSchema.parse(item)
          const previous = rows.find((value) => value.id === row.id)
          if (!previous) return dshUnsupported('composition.patch')
          Object.assign(previous, row)
        }
      }
    }
    if (rows.length > 200 || new Set(rows.map((row) => row.id)).size !== rows.length)
      return dshUnsupported('composition.rows')
    for (const row of rows) {
      if (!row.name?.startsWith('@deepseek-ai/')) return dshUnsupported('composition.package')
      await component(row.name)
    }
    await component('@deepseek-ai/dsh-mcp-client')
    // Baseline instruction discovery and .env can affect native execution; nested reads stay dynamic.
    let directory = await realpath(cwd)
    files.add(join(directory, '.env'))
    for (let depth = 0; ; depth++) {
      for (const name of ['AGENTS.md', 'CLAUDE.md', 'AGENTS.local.md', 'CLAUDE.local.md'])
        files.add(join(directory, name))
      const parent = dirname(directory)
      if (parent === directory) break
      if (depth >= 99) return dshUnsupported('native.source-depth')
      directory = parent
    }
    const observations = []
    if (files.size > 1000) return dshUnsupported('composition.limit')
    for (const path of [...files].sort()) {
      const observation = await observeExternalFile(path)
      if (
        inspected.has(path) &&
        (!observation.exists || observation.sha256 !== inspected.get(path))
      )
        return dshUnsupported('composition.changed')
      observations.push(observation)
    }
    return { rows, entries, components, sources: { coverage: 'partial', files: observations } }
  } catch (error) {
    if (error instanceof Error && error.message.includes('AGENT_MATRIX_ERROR:')) throw error
    return dshUnsupported('composition.installation')
  }
}
