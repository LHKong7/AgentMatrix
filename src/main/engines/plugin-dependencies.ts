import { parse } from '@babel/parser'
import { isBuiltin } from 'node:module'
import { dirname, extname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { isDeepStrictEqual } from 'node:util'
import { appError, getErrorKey } from '../../shared/errors'
import type {
  ExternalFile,
  GeneratedInputs,
  PluginDependencySources,
} from '../../shared/engines/run-inputs'
import { inspectFile } from './installed-plugin-files'

type Reason = PluginDependencySources['bindings'][number]['unobserved'][number]['reason']
type Node = Record<string, unknown>
const object = (value: unknown): value is Node => value !== null && typeof value === 'object'
const sourceExtensions = new Set(['.js', '.jsx', '.mjs', '.cjs', '.ts', '.tsx', '.mts', '.cts'])
const limits = { files: 1000, bytes: 64 * 1024 * 1024, parseBytes: 2 * 1024 * 1024, nodes: 200000 }

function bindsRequire(value: unknown): boolean {
  if (!object(value)) return false
  if (value.type === 'Identifier') return value.name === 'require'
  if (value.type === 'RestElement') return bindsRequire(value.argument)
  if (value.type === 'AssignmentPattern') return bindsRequire(value.left)
  if (value.type === 'ArrayPattern' && Array.isArray(value.elements))
    return value.elements.some(bindsRequire)
  if (value.type === 'ObjectPattern' && Array.isArray(value.properties))
    return value.properties.some(
      (item) =>
        object(item) && bindsRequire(item.type === 'RestElement' ? item.argument : item.value),
    )
  return false
}

/** Enumerate declarations only. Never import modules, resolve packages, or evaluate expressions. */
export function literalPluginReferences(source: string): {
  references: { value: string; kind: 'import' | 'require' }[]
  unobserved: Partial<Record<Reason, number>>
} {
  try {
    const ast = parse(source, {
      sourceType: 'unambiguous',
      createImportExpressions: true,
      plugins: ['typescript', 'jsx'],
      attachComment: false,
    })
    const pending: unknown[] = [ast.program],
      nodes: Node[] = []
    let shadowed = false
    while (pending.length) {
      const node = pending.pop()
      if (!object(node)) continue
      if (nodes.length >= limits.nodes) return { references: [], unobserved: { 'source-limit': 1 } }
      nodes.push(node)
      if (
        (node.type === 'VariableDeclarator' && bindsRequire(node.id)) ||
        (String(node.type).startsWith('Import') && bindsRequire(node.local)) ||
        ([
          'FunctionDeclaration',
          'FunctionExpression',
          'ClassDeclaration',
          'ClassExpression',
          'TSImportEqualsDeclaration',
        ].includes(String(node.type)) &&
          bindsRequire(node.id)) ||
        (Array.isArray(node.params) && node.params.some(bindsRequire)) ||
        (node.type === 'AssignmentExpression' && bindsRequire(node.left)) ||
        (node.type === 'UpdateExpression' && bindsRequire(node.argument)) ||
        (node.type === 'CatchClause' && bindsRequire(node.param))
      )
        shadowed = true
      for (const [key, value] of Object.entries(node)) {
        if (
          [
            'loc',
            'extra',
            'comments',
            'leadingComments',
            'trailingComments',
            'innerComments',
          ].includes(key)
        )
          continue
        if (Array.isArray(value)) pending.push(...value)
        else if (object(value)) pending.push(value)
      }
    }
    const references: { value: string; kind: 'import' | 'require' }[] = []
    let dynamic = 0
    function add(value: unknown, kind: 'import' | 'require') {
      if (object(value) && value.type === 'StringLiteral' && typeof value.value === 'string')
        references.push({ value: value.value, kind })
      else dynamic++
    }
    for (const node of nodes) {
      if (
        ['ImportDeclaration', 'ExportNamedDeclaration', 'ExportAllDeclaration'].includes(
          String(node.type),
        ) &&
        node.source
      ) {
        if (
          node.importKind === 'type' ||
          node.exportKind === 'type' ||
          (Array.isArray(node.specifiers) &&
            node.specifiers.length &&
            node.specifiers.every(
              (item) => object(item) && (item.importKind === 'type' || item.exportKind === 'type'),
            ))
        )
          continue
        add(node.source, 'import')
      } else if (node.type === 'ImportExpression') add(node.source, 'import')
      else if (
        node.type === 'CallExpression' &&
        object(node.callee) &&
        node.callee.type === 'Identifier' &&
        node.callee.name === 'require'
      ) {
        if (shadowed) dynamic++
        else add(Array.isArray(node.arguments) ? node.arguments[0] : undefined, 'require')
      } else if (
        node.type === 'TSImportEqualsDeclaration' &&
        node.importKind !== 'type' &&
        object(node.moduleReference) &&
        node.moduleReference.type === 'TSExternalModuleReference'
      )
        add(node.moduleReference.expression, 'require')
    }
    return { references, unobserved: dynamic ? { dynamic } : {} }
  } catch {
    return { references: [], unobserved: { syntax: 1 } }
  }
}

/** Extend immutable source observations with explicit relative modules and their package scopes. */
export async function observePluginDependencies(
  generated: GeneratedInputs,
  pluginId: string,
  entries: Extract<ExternalFile, { exists: true }>[],
): Promise<void> {
  const known = new Map<string, ExternalFile>()
  for (const file of generated.externalSources.files) {
    if (known.has(file.path) && !isDeepStrictEqual(known.get(file.path), file))
      throw appError('error.pluginChanged')
    known.set(file.path, file)
  }
  const files = new Set<string>(),
    parsed = new Set<string>(),
    visited = new Set<string>()
  const unobserved: PluginDependencySources['bindings'][number]['unobserved'] = []
  const tracked = new Set(
    generated.externalSources.pluginDependencies?.bindings.flatMap((binding) => binding.files) ??
      [],
  )
  let bytes = [...tracked].reduce((sum, path) => {
    const file = known.get(path)
    return sum + (file?.exists ? file.bytes : 0)
  }, 0)
  const note = (source: string, reason: Reason, count = 1) => {
    const row = unobserved.find((item) => item.source === source && item.reason === reason)
    if (row) row.count += count
    else unobserved.push({ source, reason, count })
  }
  async function observe(path: string, metadata = false) {
    if (!known.has(path) && known.size >= limits.files)
      throw appError('error.pluginDependencyLimit')
    files.add(path)
    if (visited.has(path)) return null
    visited.add(path)
    let current: ExternalFile,
      content: Buffer | null = null
    try {
      const read = await inspectFile(path, metadata ? 256 * 1024 : 20_000_000, !metadata)
      current = { ...read.observation, exists: true }
      content = read.content
      if (!tracked.has(path)) bytes += current.bytes
      tracked.add(path)
      if (bytes > limits.bytes) throw appError('error.pluginDependencyLimit')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      current = { path, exists: false }
    }
    if (known.has(path) && !isDeepStrictEqual(known.get(path), current))
      throw appError('error.pluginChanged')
    known.set(path, current)
    return current.exists ? { file: current, content } : null
  }
  try {
    for (const entry of entries) {
      if (known.has(entry.path) && !isDeepStrictEqual(known.get(entry.path), entry))
        throw appError('error.pluginChanged')
      known.set(entry.path, entry)
    }
    if (known.size > limits.files || bytes > limits.bytes)
      throw appError('error.pluginDependencyLimit')
    const queue: { path: string; source?: string }[] = entries.map((entry) => ({
      path: entry.path,
    }))
    while (queue.length) {
      const { path, source } = queue.shift()!
      let current: Awaited<ReturnType<typeof observe>>
      try {
        current = await observe(path)
      } catch (error) {
        // A directory import needs native loader resolution, not a guessed file observation.
        if (source && !known.has(path) && getErrorKey(error) === 'error.pluginFile') {
          files.delete(path)
          note(source, 'resolution')
          continue
        }
        throw error
      }
      if (!current || parsed.has(current.file.resolvedPath) || !sourceExtensions.has(extname(path)))
        continue
      parsed.add(current.file.resolvedPath)
      let directory = dirname(current.file.resolvedPath)
      for (let depth = 0; ; depth++) {
        if (depth >= 64) throw appError('error.pluginDependencyLimit')
        const packagePath = join(directory, 'package.json')
        await observe(packagePath, true)
        if (known.get(packagePath)?.exists || dirname(directory) === directory) break
        directory = dirname(directory)
      }
      if (current.file.bytes > limits.parseBytes) {
        note(path, 'source-limit')
        continue
      }
      let parsedSource: ReturnType<typeof literalPluginReferences>
      try {
        parsedSource = literalPluginReferences(
          new TextDecoder('utf-8', { fatal: true }).decode(current.content!),
        )
      } catch {
        note(path, 'syntax')
        continue
      }
      for (const [reason, count] of Object.entries(parsedSource.unobserved))
        note(path, reason as Reason, count)
      for (const reference of parsedSource.references) {
        if (isBuiltin(reference.value)) continue
        if (!reference.value.startsWith('./') && !reference.value.startsWith('../')) {
          note(path, /^(?:[a-z]+:|\/)/i.test(reference.value) ? 'resolution' : 'package')
          continue
        }
        let dependency: string
        try {
          dependency =
            reference.kind === 'import'
              ? fileURLToPath(new URL(reference.value, pathToFileURL(current.file.resolvedPath)))
              : resolve(dirname(current.file.resolvedPath), reference.value)
          if (
            dependency.includes('\0') ||
            (!sourceExtensions.has(extname(dependency)) && extname(dependency) !== '.json')
          )
            throw new Error('Unresolved module form')
        } catch {
          note(path, 'resolution')
          continue
        }
        if (!visited.has(dependency)) queue.push({ path: dependency, source: path })
      }
    }
    generated.externalSources.files = [...known.values()]
    generated.externalSources.pluginDependencies ??= { version: 1, bindings: [] }
    generated.externalSources.pluginDependencies.bindings.push({
      pluginId,
      files: [...files],
      unobserved,
    })
    generated.externalSources.coverage = 'partial'
  } catch (error) {
    if (getErrorKey(error)) throw error
    throw appError('error.pluginRead')
  }
}
