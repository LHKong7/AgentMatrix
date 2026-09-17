import { parse } from '@babel/parser'
import { appError } from '../../../../shared/errors'

const fail = (): never => {
  throw appError('error.pluginExports')
}
const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object'

function bindings(node: unknown): string[] {
  if (!record(node)) return []
  if (node.type === 'Identifier') return [String(node.name)]
  if (node.type === 'AssignmentPattern') return bindings(node.left)
  if (node.type === 'RestElement') return bindings(node.argument)
  if (node.type === 'ArrayPattern' && Array.isArray(node.elements))
    return node.elements.flatMap(bindings)
  if (node.type === 'ObjectPattern' && Array.isArray(node.properties))
    return node.properties.flatMap((property) =>
      record(property)
        ? bindings(property.type === 'RestElement' ? property.argument : property.value)
        : [],
    )
  return []
}

/** Enumerate explicit ESM exports without evaluating selected code in Electron. */
export function pluginExportNames(source: string): string[] {
  try {
    const ast = parse(source, { sourceType: 'module', plugins: ['typescript', 'jsx'] })
    const names = new Set<string>()
    const typeOnly = new Set<string>()
    for (const item of ast.program.body) {
      const declaration = item.type === 'ExportNamedDeclaration' ? item.declaration : item
      if (
        declaration &&
        (('declare' in declaration && declaration.declare) ||
          declaration.type === 'TSInterfaceDeclaration' ||
          declaration.type === 'TSTypeAliasDeclaration')
      ) {
        if ('id' in declaration) bindings(declaration.id).forEach((name) => typeOnly.add(name))
        if (declaration.type === 'VariableDeclaration')
          declaration.declarations
            .flatMap((value) => bindings(value.id))
            .forEach((name) => typeOnly.add(name))
      }
      if (item.type === 'ImportDeclaration')
        for (const specifier of item.specifiers)
          if (
            item.importKind === 'type' ||
            ('importKind' in specifier && specifier.importKind === 'type')
          )
            typeOnly.add(specifier.local.name)
    }
    for (const item of ast.program.body) {
      if (item.type === 'ExportAllDeclaration' || item.type === 'TSExportAssignment') return fail()
      if (item.type === 'ExportDefaultDeclaration') {
        if (!['TSInterfaceDeclaration', 'TSDeclareFunction'].includes(item.declaration.type))
          names.add('default')
      }
      if (item.type !== 'ExportNamedDeclaration' || item.exportKind === 'type') continue
      const declaration = item.declaration
      if (declaration && !('declare' in declaration && declaration.declare)) {
        if (declaration.type === 'VariableDeclaration')
          declaration.declarations
            .flatMap((value) => bindings(value.id))
            .forEach((name) => names.add(name))
        else if ('id' in declaration && declaration.id)
          bindings(declaration.id)
            .filter((name) => !typeOnly.has(name))
            .forEach((name) => names.add(name))
      }
      for (const specifier of item.specifiers) {
        if (
          specifier.type === 'ExportSpecifier' &&
          (specifier.exportKind === 'type' || (!item.source && typeOnly.has(specifier.local.name)))
        )
          continue
        const exported = specifier.exported
        names.add(exported.type === 'Identifier' ? exported.name : exported.value)
      }
    }
    if (!names.size || names.size > 200) return fail()
    return [...names].sort()
  } catch {
    return fail()
  }
}
