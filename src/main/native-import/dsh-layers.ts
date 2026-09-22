import { appError } from '../../shared/errors'
import type { DshImportKind, NativeImportRecord } from '../../shared/engines/native-import'
import { childPointer as at } from './jsonc'
import {
  dshLeafPaths,
  dshObject,
  ImportExpression,
  type DshValue,
  type DshObject,
} from './dsh-yaml'

export type DshImportDocuments = Partial<Record<DshImportKind, DshValue>>
export interface Located {
  value: DshValue
  origins: Map<string, string>
}
export const located = (value: DshValue, path: string): Located => ({
  value,
  origins: new Map(dshLeafPaths(value, '').map((key) => [key, path + key])),
})
export function field(input: Located, key: string): Located {
  const prefix = at('', key)
  const value = dshObject(input.value) ? (input.value[key] ?? null) : null
  return {
    value,
    origins: new Map(
      [...input.origins]
        .filter(([path]) => path === prefix || path.startsWith(prefix + '/'))
        .map(([path, source]) => [path.slice(prefix.length), source]),
    ),
  }
}
export const origin = (input: Located) =>
  input.origins.get('') ?? [...input.origins.values()][0] ?? ''
function merge(under: Located, over: Located): Located {
  if (!dshObject(under.value) || !dshObject(over.value)) return over
  const value: DshObject = Object.create(null),
    origins = new Map<string, string>()
  for (const key of new Set([...Object.keys(under.value), ...Object.keys(over.value)])) {
    const next = Object.hasOwn(over.value, key)
      ? merge(field(under, key), field(over, key))
      : field(under, key)
    value[key] = next.value
    for (const [path, source] of next.origins) origins.set(at('', key) + path, source)
  }
  return { value, origins }
}

/** Static selected rows only. No bundle/package discovery, native loaders, or executable tags. */
export function dshSections(
  files: DshImportDocuments,
  diagnostic: (path: string, code: NativeImportRecord['diagnostics'][number]['code']) => void,
) {
  const rows: Located[] = [],
    byId = new Map<string, Located>()
  const copy = (value: DshValue): DshValue => {
    if (Array.isArray(value)) return value.map(copy)
    if (value instanceof ImportExpression) return new ImportExpression(value.source)
    if (dshObject(value))
      return Object.assign(
        Object.create(null),
        Object.fromEntries(Object.entries(value).map(([key, child]) => [key, copy(child)])),
      )
    return value
  }
  const add = (value: DshValue, path: string) => {
    if (!dshObject(value)) throw appError('error.nativeImportYaml')
    const row = located(copy(value), path)
    rows.push(row)
    if (typeof value.id === 'string') {
      if (byId.has(value.id)) throw appError('error.nativeImportYaml')
      byId.set(value.id, row)
    }
  }
  if (files['cordis.yml'] !== undefined) {
    if (!Array.isArray(files['cordis.yml'])) throw appError('error.nativeImportYaml')
    files['cordis.yml'].forEach((row, index) => add(row, `/cordis.yml/${index}`))
  }
  if (files['cordis.patch.yml'] !== undefined) {
    if (!Array.isArray(files['cordis.patch.yml'])) throw appError('error.nativeImportYaml')
    files['cordis.patch.yml'].forEach((patch, index) => {
      const path = `/cordis.patch.yml/${index}`
      if (!dshObject(patch)) throw appError('error.nativeImportYaml')
      if (Array.isArray(patch.insert) && patch.id === undefined) {
        patch.insert.forEach((row, i) => add(row, `${path}/insert/${i}`))
        return
      }
      const target = typeof patch.id === 'string' ? byId.get(patch.id) : undefined
      if (
        patch.insert !== undefined ||
        !target ||
        !dshObject(target.value) ||
        (patch.name !== undefined && patch.name !== target.value.name)
      ) {
        diagnostic(path, 'unconverted')
        return
      }
      // Cordis overrides each top-level row field wholesale; config is NOT deep merged here.
      for (const [key, value] of Object.entries(patch)) {
        if (key === 'id' || key === 'name') continue
        target.value[key] = value
        const prefix = at('', key)
        for (const pointer of target.origins.keys())
          if (pointer === prefix || pointer.startsWith(prefix + '/')) target.origins.delete(pointer)
        for (const pointer of dshLeafPaths(value, prefix))
          target.origins.set(pointer, path + pointer)
      }
    })
  }
  const sections = new Map<string, Located>()
  const known = ['llm-pi-ai', 'llm-deepseek', 'agent-default-model', 'system-prompt']
  const ambiguous = new Set<string>()
  for (const row of rows) {
    const value = row.value as DshObject
    if (typeof value.name !== 'string') continue
    const name = known.find((entry) => value.name === `@deepseek-ai/dsh-${entry}`)
    if (!name) continue
    if (value.disabled === true) {
      diagnostic(origin(row), 'review-policy')
      ambiguous.add(name)
      continue
    }
    // Conditional, scoped and grouped components cannot be treated as global active configuration.
    if (
      Object.keys(value).some((key) => !['id', 'name', 'config', 'disabled'].includes(key)) ||
      (value.disabled !== undefined && value.disabled !== false)
    ) {
      diagnostic(origin(row), 'review-policy')
      ambiguous.add(name)
      continue
    }
    if (sections.has(name)) ambiguous.add(name)
    sections.set(
      name,
      value.config === undefined ? located(Object.create(null), origin(row)) : field(row, 'config'),
    )
  }
  const settings = files['settings.yaml']
  if (settings !== undefined && !dshObject(settings)) throw appError('error.nativeImportYaml')
  for (const name of ['llm-pi-ai', 'llm-deepseek', 'agent-default-model']) {
    if (settings && Object.hasOwn(settings, name)) {
      const user = located(settings[name]!, at('/settings.yaml', name))
      sections.set(name, sections.has(name) ? merge(sections.get(name)!, user) : user)
    }
  }
  for (const name of ambiguous) {
    diagnostic(origin(sections.get(name) ?? located(null, '/cordis.yml')), 'review-policy')
    sections.delete(name)
  }
  return sections
}
