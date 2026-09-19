import { isAlias, isMap, isScalar, isSeq, parseDocument, type ScalarTag } from 'yaml'
import { appError } from '../../shared/errors'
import { childPointer } from './jsonc'

/** Tags remain distinct from ordinary objects and strings, and are never evaluated. */
export class ImportExpression {
  constructor(readonly source: string) {}
}
export type DshValue = null | boolean | number | string | ImportExpression | DshValue[] | DshObject
export interface DshObject {
  [key: string]: DshValue
}
export const dshObject = (value: DshValue | undefined): value is DshObject =>
  value !== null &&
  typeof value === 'object' &&
  !Array.isArray(value) &&
  !(value instanceof ImportExpression)
const tag: ScalarTag = {
  tag: 'tag:yaml.org,2002:js',
  resolve: (source) => new ImportExpression(source),
}
export function parseImportYaml(text: string, expressions: boolean): DshValue {
  let count = 0
  const convert = (node: unknown, depth: number): DshValue => {
    if (++count > 4000 || depth > 32) throw appError('error.nativeImportLimit')
    if (isAlias(node)) throw appError('error.nativeImportYaml')
    if (isMap(node)) {
      const result: DshObject = Object.create(null)
      for (const item of node.items) {
        if (!isScalar(item.key) || typeof item.key.value !== 'string')
          throw appError('error.nativeImportYaml')
        const key = item.key.value
        if (key.length > 200) throw appError('error.nativeImportLimit')
        if (Object.hasOwn(result, key) || key === '<<') throw appError('error.nativeImportYaml')
        result[key] = convert(item.value, depth + 1)
      }
      return result
    }
    if (isSeq(node)) return node.items.map((item) => convert(item, depth + 1))
    if (node === null) return null
    if (isScalar(node)) {
      const value: unknown = node.value
      if (
        value === null ||
        typeof value === 'string' ||
        typeof value === 'boolean' ||
        (typeof value === 'number' && Number.isFinite(value)) ||
        value instanceof ImportExpression
      )
        return value
    }
    throw appError('error.nativeImportYaml')
  }
  try {
    const doc = parseDocument(text, {
      customTags: expressions ? [tag] : [],
      uniqueKeys: true,
      stringKeys: false,
    })
    if (doc.errors.length || doc.warnings.length) throw appError('error.nativeImportYaml')
    return convert(doc.contents, 0)
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('AGENT_MATRIX_ERROR:')) throw error
    throw appError('error.nativeImportYaml')
  }
}
export function dshLeafPaths(value: DshValue, path: string): string[] {
  if (Array.isArray(value))
    return value.length
      ? value.flatMap((item, index) => dshLeafPaths(item, childPointer(path, index)))
      : [path]
  if (dshObject(value))
    return Object.keys(value).length
      ? Object.entries(value).flatMap(([key, item]) => dshLeafPaths(item, childPointer(path, key)))
      : [path]
  return [path]
}
