import { spawn } from 'node:child_process'
import { StringDecoder } from 'node:string_decoder'

/** A bounded, short-lived probe transport. This is not the application runtime. */
export function startProbe(executable, args, { cwd, env, timeoutMs = 15_000 }) {
  const child = spawn(executable, args, {
    cwd,
    env,
    stdio: 'pipe',
    detached: process.platform !== 'win32',
  })
  const decoder = new StringDecoder('utf8')
  const pending = new Map()
  let buffer = '',
    stderr = '',
    sequence = 0,
    closed = false,
    failure = null
  const exit = new Promise((resolve) =>
    child.once('close', (code, signal) => {
      closed = true
      for (const request of pending.values())
        request.reject(new Error(`Process exited (${code ?? signal})`))
      pending.clear()
      resolve({ code, signal })
    }),
  )
  function fail(error) {
    failure = error
    for (const request of pending.values()) request.reject(error)
    pending.clear()
  }
  child.once('error', fail)
  child.stdin.on('error', fail)
  child.stderr.on('data', (data) => {
    stderr = (stderr + data.toString()).slice(-8000)
  })
  child.stdout.on('data', (data) => {
    if (failure) return
    buffer += decoder.write(data)
    if (Buffer.byteLength(buffer) > 2_000_000) return fail(new Error('Probe output exceeded limit'))
    let index
    while ((index = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, index).replace(/\r$/, '')
      buffer = buffer.slice(index + 1)
      if (!line.trim()) continue
      let message
      try {
        message = JSON.parse(line)
      } catch {
        fail(new Error('Non-JSON stdout from probe'))
        continue
      }
      if (!message || typeof message !== 'object' || Array.isArray(message)) {
        fail(new Error('Invalid protocol record'))
        continue
      }
      const request = pending.get(message.id)
      if (request && !message.method) {
        pending.delete(message.id)
        request.resolve(message)
      } else if (message.method && message.id !== undefined) {
        // Probes never authorize tools or pretend to provide client services.
        child.stdin.write(
          JSON.stringify({
            jsonrpc: '2.0',
            id: message.id,
            error: { code: -32601, message: 'No client services in discovery probe' },
          }) + '\n',
        )
      }
    }
  })
  return {
    async request(payload) {
      if (failure) throw failure
      if (closed) throw new Error('Process already closed')
      const id = ++sequence
      let timer
      try {
        return await new Promise((resolve, reject) => {
          timer = setTimeout(() => {
            pending.delete(id)
            reject(new Error('Probe request timed out'))
          }, timeoutMs)
          pending.set(id, { resolve, reject })
          child.stdin.write(JSON.stringify({ ...payload, id }) + '\n', (error) => {
            if (error) {
              pending.delete(id)
              reject(error)
            }
          })
        })
      } finally {
        clearTimeout(timer)
      }
    },
    async stop() {
      if (!closed) {
        child.stdin.end()
        const signal = (value) => {
          try {
            if (process.platform !== 'win32' && child.pid) process.kill(-child.pid, value)
            else child.kill(value)
          } catch (error) {
            if (error.code !== 'ESRCH') throw error
          }
        }
        signal('SIGTERM')
        const force = setTimeout(() => signal('SIGKILL'), 1500)
        await exit
        clearTimeout(force)
      }
      return { ...(await exit), stderr }
    },
  }
}
