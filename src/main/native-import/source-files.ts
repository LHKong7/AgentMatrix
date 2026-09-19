import { basename, dirname, isAbsolute, resolve } from 'node:path'
import { z } from 'zod'
import { appError, getErrorKey } from '../../shared/errors'
import {
  nativeImportSources,
  piImportKinds,
  piImportKindSchema,
  type NativeImportRecord,
  type PiImportKind,
} from '../../shared/engines/native-import'
import { inspectFile } from '../engines/installed-plugin-files'
import { parseNativeJsonc, type JsonObject } from './jsonc'

export interface ImportFile {
  kind: 'opencode' | PiImportKind
  observation: NativeImportRecord['source']
  stamp: string
  content: Buffer
  data: JsonObject | string
}
export async function readImportFiles(
  engine: 'opencode' | 'pi',
  input: string | string[],
): Promise<ImportFile[]> {
  const paths = typeof input === 'string' ? [input] : input
  if (
    !paths.length ||
    paths.length > (engine === 'pi' ? 5 : 1) ||
    paths.some((path) => !isAbsolute(path))
  )
    throw appError('error.nativeImportSelection')
  const kinds = paths.map((path) =>
    engine === 'opencode' ? ('opencode' as const) : piImportKindSchema.safeParse(basename(path)),
  )
  if (
    kinds.some((kind) => typeof kind !== 'string' && !kind.success) ||
    new Set(paths.map((path) => dirname(resolve(path)))).size !== 1
  )
    throw appError('error.nativeImportSelection')
  const roles = kinds.map((kind) => (typeof kind === 'string' ? kind : kind.data!))
  if (new Set(roles).size !== roles.length) throw appError('error.nativeImportSelection')
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
        ignoreBOM: kind.endsWith('.md'),
      }).decode(file.content!)
      // Pi uses strict JSON. Its BOM handling is preserved; comments/trailing commas are not accepted.
      const data = kind.endsWith('.md') ? text : parseNativeJsonc(text, engine === 'pi')
      files.push({ kind, ...file, content: file.content!, data })
    }
    return files.sort(
      (left, right) =>
        piImportKinds.indexOf(left.kind as PiImportKind) -
        piImportKinds.indexOf(right.kind as PiImportKind),
    )
  } catch (error) {
    for (const file of files) file.content.fill(0)
    const key = getErrorKey(error)
    if (key === 'error.nativeImportSyntax' || key === 'error.nativeImportLimit') throw error
    if (key === 'error.pluginLimit') throw appError('error.nativeImportLimit')
    throw appError('error.nativeImportRead')
  }
}
const bundleSchema = z
  .array(
    z
      .object({
        kind: piImportKindSchema,
        bytes: z
          .string()
          .max(1_398_104)
          .regex(/^[A-Za-z0-9+/]*={0,2}$/),
      })
      .strict(),
  )
  .min(1)
  .max(5)
export function importArchiveBytes(files: ImportFile[]): Buffer {
  return files[0]!.kind === 'opencode'
    ? Buffer.from(files[0]!.content)
    : Buffer.from(
        JSON.stringify(
          files.map((file) => ({ kind: file.kind, bytes: file.content.toString('base64') })),
        ),
      )
}
export function unpackImportArchive(record: NativeImportRecord, bytes: Buffer): Buffer[] {
  if (record.engine === 'opencode') return [Buffer.from(bytes)]
  const documents = bundleSchema.parse(JSON.parse(bytes.toString('utf8')))
  const sources = nativeImportSources(record)
  if (
    documents.length !== sources.length ||
    documents.some((file, index) => file.kind !== sources[index]!.kind)
  )
    throw appError('error.nativeImportArchive')
  return documents.map((file) => Buffer.from(file.bytes, 'base64'))
}
