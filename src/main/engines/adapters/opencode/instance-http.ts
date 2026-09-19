import { randomBytes } from 'node:crypto'
import { createServer } from 'node:net'
import { z } from 'zod'
import type { ConfigurationField } from '../../../../shared/engines/configuration-report'
import { RuntimeFailure } from '../../runtime'

export interface OpenCodeInstanceCheck {
  check: 'opencode-instance-config' | 'opencode-instance-skills'
  fields: ConfigurationField[]
  observe(read: (path: string) => Promise<unknown>): Promise<void>
}

/** Reserve a candidate loopback port. A subsequent bind collision fails native ACP startup. */
async function loopbackPort(): Promise<number> {
  const server = createServer()
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      server.close((error) => {
        if (error) return reject(error)
        if (!address || typeof address === 'string')
          return reject(new Error('Missing listener address'))
        resolve(address.port)
      })
    })
  })
}

/** Read only from the authenticated server owned by this ACP attachment. */
export async function prepareOpenCodeInstanceHttp(
  cwd: string,
  checks: [OpenCodeInstanceCheck, ...OpenCodeInstanceCheck[]],
) {
  const fail = (check = checks[0], reason: 'mismatch' | 'unavailable' = 'unavailable'): never => {
    throw new RuntimeFailure('configuration', 'native.instance-readback', {
      check: check.check,
      reason,
      fields: check.fields,
    })
  }
  let port: number
  try {
    port = await loopbackPort()
  } catch {
    return fail()
  }
  const password = randomBytes(32).toString('hex')
  const encoded = Buffer.from(`opencode:${password}`).toString('base64'),
    authorization = `Basic ${encoded}`
  const disposed = new AbortController()
  async function readNative(path: string, signal: AbortSignal): Promise<unknown> {
    const url = new URL(path, `http://127.0.0.1:${port}`)
    url.searchParams.set('directory', cwd)
    const response = await fetch(url, {
      headers: { Authorization: authorization },
      redirect: 'error',
      signal,
    })
    if (!response.ok || !response.body) {
      await response.body?.cancel()
      throw new Error('Native observation unavailable')
    }
    const reader = response.body.getReader(),
      chunks: Uint8Array[] = []
    let size = 0
    try {
      for (;;) {
        const part = await reader.read()
        if (part.done) break
        size += part.value.byteLength
        if (size > 4_194_304) throw new Error('Native observation unavailable')
        chunks.push(part.value)
      }
      return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)))
    } finally {
      await reader.cancel().catch(() => {})
      reader.releaseLock()
    }
  }
  const sessionSchema = z.object({ id: z.string().min(1).max(1000), directory: z.string() })
  return {
    args: ['--hostname', '127.0.0.1', '--port', String(port)],
    environment: { OPENCODE_SERVER_USERNAME: 'opencode', OPENCODE_SERVER_PASSWORD: password },
    secrets: [password, encoded, authorization],
    async verify(pid: number | undefined, signal: AbortSignal, sessionId: string) {
      try {
        if (!pid || !sessionId || sessionId.length > 1000) return fail()
        const lifetime = AbortSignal.any([signal, disposed.signal, AbortSignal.timeout(10000)])
        lifetime.throwIfAborted()
        const sessionPath = `/session/${encodeURIComponent(sessionId)}`
        const checkSession = async () => {
          const session = sessionSchema.parse(await readNative(sessionPath, lifetime))
          if (session.id !== sessionId || session.directory !== cwd) return fail()
        }
        await checkSession()
        for (const check of checks) {
          try {
            await check.observe((path) => readNative(path, lifetime))
          } catch (error) {
            if (error instanceof RuntimeFailure) throw error
            return fail(check)
          }
        }
        await checkSession()
        lifetime.throwIfAborted()
      } catch (error) {
        if (signal.aborted || disposed.signal.aborted) throw new RuntimeFailure('process-exit')
        if (error instanceof RuntimeFailure) throw error
        return fail()
      }
    },
    cleanup: async () => {
      disposed.abort()
    },
  }
}
