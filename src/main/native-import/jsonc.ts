import { parseTree, type Node, type ParseError } from 'jsonc-parser'
import { appError } from '../../shared/errors'

export type JsonValue = null | boolean | number | string | JsonValue[] | JsonObject
export interface JsonObject {
  [key: string]: JsonValue
}
export const isObject = (value: JsonValue | undefined): value is JsonObject =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
export const childPointer = (parent: string, key: string | number) =>
  `${parent}/${String(key).replaceAll('~', '~0').replaceAll('/', '~1')}`

/** Data parsing only: no macro substitution, imports, shell, environment or referenced-file reads. */
export function parseNativeJsonc(text: string, strict = false): JsonObject {
  const errors: ParseError[] = []
  let count = 0
  const convert = (node: Node, depth: number): JsonValue => {
    if (++count > 4000 || depth > 32) throw appError('error.nativeImportLimit')
    if (node.type === 'object') {
      const result: JsonObject = Object.create(null)
      for (const property of node.children ?? []) {
        const key = property.children?.[0]?.value
        if (typeof key === 'string' && key.length > 200) throw appError('error.nativeImportLimit')
        if (typeof key !== 'string' || Object.hasOwn(result, key) || !property.children?.[1])
          throw appError('error.nativeImportSyntax')
        result[key] = convert(property.children[1], depth + 1)
      }
      return result
    }
    if (node.type === 'array') return (node.children ?? []).map((item) => convert(item, depth + 1))
    if (node.type === 'number' && !Number.isFinite(node.value))
      throw appError('error.nativeImportSyntax')
    if (!['null', 'boolean', 'number', 'string'].includes(node.type))
      throw appError('error.nativeImportSyntax')
    return node.value as null | boolean | number | string
  }
  let root: Node | undefined
  try {
    root = parseTree(text, errors, { allowTrailingComma: !strict, disallowComments: strict })
  } catch {
    throw appError('error.nativeImportLimit')
  }
  if (errors.length || !root || root.type !== 'object') throw appError('error.nativeImportSyntax')
  return convert(root, 0) as JsonObject
}

export function nativeLeafPaths(value: JsonValue, path = ''): string[] {
  if (Array.isArray(value))
    return value.length
      ? value.flatMap((child, i) => nativeLeafPaths(child, childPointer(path, i)))
      : [path]
  if (isObject(value))
    return Object.keys(value).length
      ? Object.entries(value).flatMap(([key, child]) =>
          nativeLeafPaths(child, childPointer(path, key)),
        )
      : [path]
  return [path]
}
