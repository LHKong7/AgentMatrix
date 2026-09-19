import { fork } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { build } from 'vite'
import { expect, it } from 'vitest'
type NativeIdentity = { pid: number; descendant: number; guardian: number; observedPid: number }

function alive(pid: number) {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false
    throw error
  }
}
it.skipIf(process.platform === 'win32').each(['application', 'guardian'])(
  'cleans the native process group after the %s is killed',
  async (target) => {
    const root = await mkdtemp(join(tmpdir(), 'agentmatrix-process-crash-'))
    let host: ReturnType<typeof fork> | undefined
    let native: NativeIdentity | undefined
    try {
      await build({
        configFile: false,
        logLevel: 'silent',
        build: {
          lib: {
            entry: resolve('tests/fixtures/managed-process-host.ts'),
            formats: ['es'],
            fileName: () => 'host.mjs',
          },
          outDir: root,
          minify: false,
          emptyOutDir: false,
          target: 'node22',
          rollupOptions: { external: [/^node:/] },
        },
      })
      host = fork(join(root, 'host.mjs'), [], {
        execArgv: [],
        stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
      })
      const closed = new Promise<void>((done) => host!.once('exit', () => done()))
      native = await new Promise<NativeIdentity>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('Host fixture startup timed out')), 5000)
        host!.once('message', (value) => {
          clearTimeout(timer)
          resolve(value as NativeIdentity)
        })
        host!.once('error', (error) => {
          clearTimeout(timer)
          reject(error)
        })
      })
      expect(Number.isInteger(native.pid) && native.pid > 0).toBe(true)
      expect(Number.isInteger(native.descendant) && native.descendant > 0).toBe(true)
      expect(native.observedPid).toBe(native.pid)
      expect(native.guardian).not.toBe(host.pid)
      if (target === 'application') {
        host.kill('SIGKILL')
        await closed
      } else process.kill(native.guardian, 'SIGKILL')
      await expect
        .poll(() => alive(native!.pid) || alive(native!.descendant), { timeout: 5000 })
        .toBe(false)
      expect(() => process.kill(-native!.pid, 0)).toThrow()
      await expect.poll(() => alive(native!.guardian), { timeout: 5000 }).toBe(false)
    } finally {
      host?.kill('SIGKILL')
      if (native) {
        try {
          process.kill(-native.pid, 'SIGKILL')
        } catch {
          /* Already cleaned. */
        }
      }
      await rm(root, { recursive: true, force: true })
    }
  },
  20_000,
)
