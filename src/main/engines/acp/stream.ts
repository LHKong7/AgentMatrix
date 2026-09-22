import type { AnyMessage, Stream } from '@agentclientprotocol/sdk'

export const acpFrameLimit = 1_048_576
export class AcpFailure extends Error {
  constructor(
    readonly code:
      'protocol' | 'closed' | 'timeout' | 'unsupported' | 'invalid-state' | 'overload' | 'engine',
    readonly rpcCode?: number,
  ) {
    // Never include native messages, parameters, or raw frames in a diagnostic.
    super(`ACP ${code}${rpcCode === undefined ? '' : ` (${rpcCode})`}`)
  }
}

function messageOf(bytes: Uint8Array): AnyMessage {
  try {
    const value: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes))
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error()
    const message = value as Record<string, unknown>
    if (message.jsonrpc !== '2.0') throw new Error()
    if (
      'id' in message &&
      message.id !== null &&
      typeof message.id !== 'string' &&
      !(typeof message.id === 'number' && Number.isSafeInteger(message.id))
    )
      throw new Error()
    if ('method' in message) {
      if (
        typeof message.method !== 'string' ||
        !message.method ||
        'result' in message ||
        'error' in message
      )
        throw new Error()
    } else if (!('id' in message) || 'result' in message === 'error' in message) throw new Error()
    return message as AnyMessage
  } catch {
    throw new AcpFailure('protocol')
  }
}

/** ACP v1 only: bounded LF frames, strict UTF-8, and no unterminated final message. */
export function boundedAcpStream(
  input: ReadableStream<Uint8Array>,
  output: WritableStream<Uint8Array>,
  limit = acpFrameLimit,
): {
  stream: Stream
  dispose: () => Promise<void>
} {
  const reader = input.getReader()
  const writer = output.getWriter()
  let chunk: Uint8Array = new Uint8Array()
  let offset = 0
  let parts: Uint8Array[] = []
  let bytes = 0
  let disposed = false
  const dispose = async () => {
    if (disposed) return
    disposed = true
    chunk = new Uint8Array()
    parts = []
    await Promise.allSettled([reader.cancel(), writer.abort()])
  }
  const readable = new ReadableStream<AnyMessage>({
    async pull(controller) {
      try {
        while (!disposed) {
          if (offset >= chunk.length) {
            const next = await reader.read()
            if (disposed) return
            if (next.done) {
              if (bytes) throw new AcpFailure('protocol')
              controller.close()
              return
            }
            chunk = next.value
            offset = 0
          }
          const newline = chunk.indexOf(10, offset)
          const end = newline < 0 ? chunk.length : newline
          bytes += end - offset
          if (bytes > limit) throw new AcpFailure('protocol')
          if (end > offset) parts.push(chunk.slice(offset, end))
          offset = end + (newline < 0 ? 0 : 1)
          if (newline < 0) continue
          const line = new Uint8Array(bytes)
          let cursor = 0
          for (const part of parts) {
            line.set(part, cursor)
            cursor += part.length
          }
          parts = []
          bytes = 0
          if (!line.length) continue
          controller.enqueue(messageOf(line))
          return
        }
      } catch (error) {
        controller.error(error instanceof AcpFailure ? error : new AcpFailure('closed'))
        void dispose()
      }
    },
    cancel: dispose,
  })
  const writable = new WritableStream<AnyMessage>({
    async write(message) {
      if (disposed) throw new AcpFailure('closed')
      const encoded = new TextEncoder().encode(JSON.stringify(message) + '\n')
      if (encoded.length - 1 > limit) throw new AcpFailure('protocol')
      await writer.write(encoded)
    },
    close: dispose,
    abort: dispose,
  })
  return { stream: { readable, writable }, dispose }
}
