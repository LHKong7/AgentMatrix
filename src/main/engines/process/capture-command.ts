import { ManagedProcess, type ProcessLaunch } from './managed-process'
import { RuntimeFailure } from '../runtime'

/** Internal native readback. Output may contain credentials and must never be logged or journaled. */
export async function captureCommand(
  launch: ProcessLaunch,
  signal: AbortSignal,
  timeoutMs = 30_000,
): Promise<string> {
  if (signal.aborted) throw new RuntimeFailure('process-exit')
  const child = new ManagedProcess(launch)
  let expired = false
  const abort = () => {
    void child.terminate().catch(() => {})
  }
  signal.addEventListener('abort', abort, { once: true })
  const timer = setTimeout(() => {
    expired = true
    abort()
  }, timeoutMs)
  try {
    await child.ready
    const reader = child.stdout.getReader()
    const chunks: Uint8Array[] = []
    let length = 0
    for (;;) {
      const item = await reader.read()
      if (item.done) break
      length += item.value.byteLength
      if (length > 4_194_304) throw new RuntimeFailure('protocol', 'readback.size')
      chunks.push(item.value)
    }
    const result = await child.closed
    if (expired) throw new RuntimeFailure('timeout')
    if (signal.aborted || result.code !== 0 || result.failure || result.outputTruncated)
      throw new RuntimeFailure('process-exit')
    return new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks))
  } catch (error) {
    if (error instanceof RuntimeFailure) throw error
    throw new RuntimeFailure('process-exit')
  } finally {
    clearTimeout(timer)
    signal.removeEventListener('abort', abort)
    await child.terminate()
  }
}
