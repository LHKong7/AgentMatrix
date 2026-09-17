import { z } from 'zod'

export const piFrameLimit = 1_048_576
export class PiFailure extends Error {
  constructor(
    readonly code: 'protocol' | 'closed' | 'timeout' | 'overload' | 'engine' | 'invalid-state',
  ) {
    super(`Pi RPC ${code}`)
  }
}
export type PiRecord = Record<string, unknown> & { type: string }
export type PiCommand =
  | {
      type: 'get_state' | 'get_messages' | 'get_commands' | 'abort' | 'clear_queue' | 'new_session'
    }
  | { type: 'prompt'; message: string }
  | { type: 'switch_session'; sessionPath: string }
  | { type: 'set_auto_retry' | 'set_auto_compaction'; enabled: boolean }

const text = z.string().max(65_536)
const common = {
  type: z.literal('extension_ui_request'),
  id: z.string().min(1).max(256),
  title: text,
  timeout: z.number().int().positive().max(86_400_000).optional(),
}
export const piDialogSchema = z.discriminatedUnion('method', [
  z.object({ ...common, method: z.literal('select'), options: z.array(text).min(1).max(100) }),
  z.object({ ...common, method: z.literal('confirm'), message: text }),
  z.object({ ...common, method: z.literal('input'), placeholder: text.optional() }),
  z.object({ ...common, method: z.literal('editor'), prefill: text.optional() }),
])
export type PiDialog = z.infer<typeof piDialogSchema>
export type PiDialogAnswer = { value: string } | { confirmed: boolean } | { cancelled: true }

export function validDialogAnswer(dialog: PiDialog, value: PiDialogAnswer): boolean {
  if ('cancelled' in value) return value.cancelled === true && Object.keys(value).length === 1
  if (Object.keys(value).length !== 1) return false
  if (dialog.method === 'confirm')
    return 'confirmed' in value && typeof value.confirmed === 'boolean'
  return (
    'value' in value &&
    typeof value.value === 'string' &&
    value.value.length <= 65_536 &&
    (dialog.method !== 'select' || dialog.options.includes(value.value))
  )
}

/** Native JSONL: only LF delimits records; Unicode separators are ordinary string content. */
export async function readPiRecords(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  receive: (message: PiRecord, bytes: number) => void,
): Promise<void> {
  let parts: Uint8Array[] = []
  let size = 0
  for (;;) {
    const next = await reader.read()
    if (next.done) {
      if (size) throw new PiFailure('protocol')
      return
    }
    const chunk = next.value
    let offset = 0
    while (offset < chunk.length) {
      const newline = chunk.indexOf(10, offset)
      const end = newline < 0 ? chunk.length : newline
      size += end - offset
      if (size > piFrameLimit) throw new PiFailure('protocol')
      if (end > offset) parts.push(chunk.slice(offset, end))
      offset = end + (newline < 0 ? 0 : 1)
      if (newline < 0) continue
      const line = Buffer.concat(parts, size)
      parts = []
      const bytes = size
      size = 0
      if (!line.length || (line.length === 1 && line[0] === 13)) continue
      let record: unknown
      try {
        record = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(line))
      } catch {
        throw new PiFailure('protocol')
      }
      if (
        !record ||
        typeof record !== 'object' ||
        Array.isArray(record) ||
        !('type' in record) ||
        typeof record.type !== 'string' ||
        !record.type ||
        record.type.length > 100
      )
        throw new PiFailure('protocol')
      receive(record as PiRecord, bytes)
    }
  }
}
