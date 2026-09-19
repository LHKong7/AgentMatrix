import { basename, dirname, isAbsolute, resolve } from 'node:path'
import { z } from 'zod'
import { appError, getErrorKey } from '../../shared/errors'
import {
  nativeImportSources,
  piImportKinds,
  piImportKindSchema,
  dshImportKinds,
  dshImportKindSchema,
  type DshImportKind,
  type NativeImportEngine,
  type NativeImportRecord,
  type PiImportKind,
} from '../../shared/engines/native-import'
import { inspectFile } from '../engines/installed-plugin-files'
import { parseNativeJsonc } from './jsonc'
import { parseImportYaml, type DshValue } from './dsh-yaml'

export interface ImportFile {
  kind: 'opencode' | 'opencode-prompt' | PiImportKind | DshImportKind
  referencePath?: string
  observation: NativeImportRecord['source']
  stamp: string
  content: Buffer
  data: DshValue
}
export async function readImportFiles(
  engine: NativeImportEngine,
  input: string | string[],
  references: readonly string[] = [],
): Promise<ImportFile[]> {
  const paths = typeof input === 'string' ? [input] : input
  if (
    !paths.length ||
    paths.length > (engine === 'pi' ? 5 : engine === 'deepseek-harness' ? 4 : 17) ||
    (engine === 'opencode' ? paths.length !== references.length + 1 : references.length !== 0) ||
    new Set(references).size !== references.length ||
    paths.some((path) => !isAbsolute(path))
  )
    throw appError('error.nativeImportSelection')
  const kinds = paths.map((path, index) =>
    engine === 'opencode'
      ? index === 0
        ? ('opencode' as const)
        : ('opencode-prompt' as const)
      : (engine === 'pi' ? piImportKindSchema : dshImportKindSchema).safeParse(basename(path)),
  )
  if (
    kinds.some((kind) => typeof kind !== 'string' && !kind.success) ||
    (engine === 'pi' && new Set(paths.map((path) => dirname(resolve(path)))).size !== 1)
  )
    throw appError('error.nativeImportSelection')
  const roles = kinds.map((kind) => (typeof kind === 'string' ? kind : kind.data!))
  if (engine !== 'opencode' && new Set(roles).size !== roles.length)
    throw appError('error.nativeImportSelection')
  const files: ImportFile[] = []
  try {
    for (const [index, path] of paths.entries()) {
      const file = await inspectFile(path, 1_048_576, true)
      if (
        files.reduce((total, entry) => total + entry.content.length, 0) + file.content!.length >
        1_048_576
      )
        throw appError('error.nativeImportLimit')
      const kind = roles[index]!
      const text = new TextDecoder('utf-8', {
        fatal: true,
        ignoreBOM: kind.endsWith('.md') || kind === 'opencode-prompt',
      }).decode(file.content!)
      // Pi uses strict JSON. Its BOM handling is preserved; comments/trailing commas are not accepted.
      const data =
        engine === 'deepseek-harness'
          ? parseImportYaml(text, kind === 'cordis.yml' || kind === 'cordis.patch.yml')
          : kind.endsWith('.md') || kind === 'opencode-prompt'
            ? text
            : parseNativeJsonc(text, engine === 'pi')
      files.push({
        kind,
        ...file,
        content: file.content!,
        data,
        ...(kind === 'opencode-prompt' ? { referencePath: references[index - 1]! } : {}),
      })
    }
    if (engine === 'opencode') return files
    const order: readonly string[] = engine === 'deepseek-harness' ? dshImportKinds : piImportKinds
    return files.sort((left, right) => order.indexOf(left.kind) - order.indexOf(right.kind))
  } catch (error) {
    for (const file of files) file.content.fill(0)
    const key = getErrorKey(error)
    if (
      key === 'error.nativeImportSyntax' ||
      key === 'error.nativeImportYaml' ||
      key === 'error.nativeImportLimit'
    )
      throw error
    if (key === 'error.pluginLimit') throw appError('error.nativeImportLimit')
    throw appError('error.nativeImportRead')
  }
}
const bundleSchema = z
  .array(
    z
      .object({
        kind: z.union([
          piImportKindSchema,
          dshImportKindSchema,
          z.literal('opencode'),
          z.literal('opencode-prompt'),
        ]),
        bytes: z
          .string()
          .max(1_398_104)
          .regex(/^[A-Za-z0-9+/]*={0,2}$/),
      })
      .strict(),
  )
  .min(1)
  .max(17)
export function importArchiveBytes(files: ImportFile[]): Buffer {
  return files[0]!.kind === 'opencode' && files.length === 1
    ? Buffer.from(files[0]!.content)
    : Buffer.from(
        JSON.stringify(
          files.map((file) => ({ kind: file.kind, bytes: file.content.toString('base64') })),
        ),
      )
}
export function unpackImportArchive(record: NativeImportRecord, bytes: Buffer): Buffer[] {
  if (record.engine === 'opencode' && !record.additionalSources) return [Buffer.from(bytes)]
  const documents = bundleSchema.parse(JSON.parse(bytes.toString('utf8')))
  const sources = nativeImportSources(record)
  if (
    documents.length !== sources.length ||
    documents.some((file, index) => file.kind !== sources[index]!.kind)
  )
    throw appError('error.nativeImportArchive')
  return documents.map((file) => Buffer.from(file.bytes, 'base64'))
}
