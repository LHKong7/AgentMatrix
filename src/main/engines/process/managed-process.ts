import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { isAbsolute } from 'node:path'
import { Readable, Writable } from 'node:stream'
import { RedactedTail } from './redacted-tail'
import guardianSource from './guardian.cjs?raw'

export class ProcessFailure extends Error {
  constructor(
    readonly code: 'unsupported-platform' | 'invalid-launch' | 'spawn' | 'cleanup-timeout',
  ) {
    super(`Agent process ${code}`)
  }
}
export interface ProcessLaunch {
  executable: string
  args: string[]
  cwd: string
  environment: Record<string, string>
  secrets?: readonly string[]
}
export interface ProcessResult {
  code: number | null
  signal: NodeJS.Signals | null
  forced: boolean
  outputTruncated: boolean
  failure: 'spawn' | 'io' | null
  stderr: string
  cleanup: 'posix-process-group'
}
interface ProcessLimits {
  graceMs: number
  drainMs: number
  stopTimeoutMs: number
}
type ProcessExit = Omit<ProcessResult, 'stderr' | 'cleanup'>

const ownedProcesses = new Set<ManagedProcess>()
/** Also retains failed-start/readback processes whose immediate caller timed out during cleanup. */
export async function stopOwnedProcesses(): Promise<void> {
  const results = await Promise.allSettled(
    [...ownedProcesses].map((process) => process.terminate()),
  )
  if (ownedProcesses.size || results.some((result) => result.status === 'rejected'))
    throw new ProcessFailure('cleanup-timeout')
}

/** Copy a small OS environment baseline. Provider keys and loader options are never inherited. */
export function baseProcessEnvironment(source: NodeJS.ProcessEnv): Record<string, string> {
  const environment: Record<string, string> = {}
  for (const key of [
    'HOME',
    'USERPROFILE',
    'SYSTEMROOT',
    'WINDIR',
    'PATH',
    'TMPDIR',
    'TEMP',
    'TMP',
    'LANG',
    'LC_ALL',
    'LC_CTYPE',
  ])
    if (source[key] !== undefined) environment[key] = source[key]!
  return environment
}

/** A process group remains owned until its leader, group members, and pipes are gone. */
export class ManagedProcess {
  readonly ready: Promise<void>
  readonly closed: Promise<ProcessResult>
  readonly stdout: ReadableStream<Uint8Array>
  readonly stdin: WritableStream<Uint8Array>
  private readonly child: ChildProcessWithoutNullStreams
  private readonly tail: RedactedTail
  private readonly limits: ProcessLimits
  private nativePid?: number
  private nativeExit = false
  private groupGone = false
  private result: ProcessExit = {
    code: null,
    signal: null,
    forced: false,
    outputTruncated: false,
    failure: null,
  }
  private leaderExited = false
  private pipesClosed = false
  private finished = false
  private shuttingDown = false
  private poll?: ReturnType<typeof setInterval>
  private force?: ReturnType<typeof setTimeout>
  private drain?: ReturnType<typeof setTimeout>
  private finish!: (result: ProcessResult) => void

  constructor(launch: ProcessLaunch, limits: Partial<ProcessLimits> = {}) {
    if (!['darwin', 'linux'].includes(process.platform))
      throw new ProcessFailure('unsupported-platform')
    this.limits = { graceMs: 1000, drainMs: 1000, stopTimeoutMs: 5000, ...limits }
    if (
      Object.values(this.limits).some(
        (value) => !Number.isSafeInteger(value) || value < 10 || value > 30_000,
      ) ||
      this.limits.stopTimeoutMs <= this.limits.graceMs ||
      !isAbsolute(launch.executable) ||
      !isAbsolute(launch.cwd) ||
      [launch.executable, launch.cwd, ...launch.args, ...Object.values(launch.environment)].some(
        (value) => value.includes('\0'),
      ) ||
      Object.keys(launch.environment).some((key) => !/^[A-Za-z_][A-Za-z0-9_]*$/.test(key))
    )
      throw new ProcessFailure('invalid-launch')
    this.tail = new RedactedTail(launch.secrets ?? [])
    this.closed = new Promise((resolve) => {
      this.finish = resolve
    })
    this.child = spawn(process.execPath, ['-e', guardianSource], {
      env: { ...baseProcessEnvironment(process.env), ELECTRON_RUN_AS_NODE: '1' },
      stdio: ['pipe', 'pipe', 'pipe', 'ipc'],
      shell: false,
      detached: true,
    }) as ChildProcessWithoutNullStreams
    ownedProcesses.add(this)
    void this.closed.then(() => ownedProcesses.delete(this))
    this.stdout = Readable.toWeb(this.child.stdout, {
      strategy: { highWaterMark: 65_536, size: (chunk: Uint8Array) => chunk.byteLength },
    }) as ReadableStream<Uint8Array>
    this.stdin = Writable.toWeb(this.child.stdin) as WritableStream<Uint8Array>
    this.ready = new Promise((resolve, reject) => {
      let booted = false
      const startup = setTimeout(() => {
        reject(new ProcessFailure('spawn'))
        this.result.failure = 'spawn'
        this.beginShutdown()
        // No launch was sent before boot, so terminating this failed helper cannot orphan a CLI.
        if (!booted) this.child.kill('SIGKILL')
      }, this.limits.stopTimeoutMs)
      this.child.on('message', (message) => {
        const event = message as {
          kind: string
          pid?: number
          code?: number | null
          signal?: NodeJS.Signals | null
          result?: ProcessExit
        }
        if (event.kind === 'boot') {
          booted = true
          this.child.send?.(
            this.shuttingDown
              ? { kind: 'stop' }
              : {
                  kind: 'launch',
                  limits: this.limits,
                  launch: {
                    executable: launch.executable,
                    args: launch.args,
                    cwd: launch.cwd,
                    environment: launch.environment,
                  },
                },
            () => {},
          )
        } else if (event.kind === 'ready' && Number.isSafeInteger(event.pid) && event.pid! > 0) {
          this.nativePid = event.pid
          clearTimeout(startup)
          resolve()
          if (this.shuttingDown) this.sendSignal('SIGTERM')
        } else if (event.kind === 'exit') {
          this.nativeExit = true
          this.result.code = event.code ?? null
          this.result.signal = event.signal ?? null
          this.beginShutdown()
        } else if (event.kind === 'spawn-error') {
          this.result.failure = 'spawn'
          clearTimeout(startup)
          reject(new ProcessFailure('spawn'))
          this.beginShutdown()
        } else if (event.kind === 'closed' && event.result) {
          this.nativeExit = true
          this.result = {
            ...event.result,
            forced: this.result.forced || event.result.forced,
            outputTruncated: this.result.outputTruncated || event.result.outputTruncated,
            failure: this.result.failure ?? event.result.failure,
          }
        }
      })
      this.child.once('exit', () => {
        clearTimeout(startup)
        reject(new ProcessFailure('spawn'))
      })
      this.child.once('error', () => {
        clearTimeout(startup)
        this.result.failure = 'spawn'
        this.leaderExited = true
        reject(new ProcessFailure('spawn'))
        this.beginShutdown()
      })
    })
    // The owner may observe closed before awaiting ready after a failed launch.
    void this.ready.catch(() => {})
    this.child.stdin.on('error', () => {
      if (!this.shuttingDown) this.result.failure = 'io'
    })
    this.child.stdout.on('error', () => {
      if (!this.shuttingDown) this.result.failure = 'io'
    })
    this.child.stderr.on('error', () => {
      if (!this.shuttingDown) this.result.failure = 'io'
    })
    this.child.stderr.on('data', (bytes: Buffer) => this.tail.push(bytes))
    this.child.stderr.once('end', () => this.tail.finish())
    this.child.once('exit', () => {
      this.leaderExited = true
      if (!this.nativeExit) {
        this.result.code = null
        this.result.signal = null
        this.result.failure ??= 'io'
      }
      this.beginShutdown()
    })
    this.child.once('close', () => {
      this.pipesClosed = true
      this.leaderExited = true
      this.beginShutdown()
      this.checkClosed()
    })
  }

  get pid(): number | undefined {
    return this.nativePid
  }
  get done(): boolean {
    return this.finished
  }
  get diagnostics(): string {
    return this.tail.text
  }

  private groupAlive(): boolean {
    if (!this.nativePid || this.groupGone) return false
    try {
      process.kill(-this.nativePid, 0)
      return true
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ESRCH') return true
      this.groupGone = true
      return false
    }
  }
  private sendSignal(signal: NodeJS.Signals): void {
    if (this.finished || this.groupGone || !this.nativePid) return
    try {
      process.kill(-this.nativePid, signal)
    } catch {
      /* Closed is proven separately; a failed signal must not masquerade as cleanup. */
    }
  }
  private beginShutdown(): void {
    if (this.shuttingDown || this.finished) return
    this.shuttingDown = true
    this.child.stdin.destroy()
    this.child.send?.({ kind: 'stop' }, () => {})
    this.sendSignal('SIGTERM')
    this.force = setTimeout(() => {
      if (this.groupAlive()) {
        this.result.forced = true
        this.sendSignal('SIGKILL')
      }
    }, this.limits.graceMs)
    this.poll = setInterval(() => this.checkClosed(), 25)
    // A crashed guardian may leave no other event-loop handles while its native group survives.
    // Keep cleanup alive until the group is gone, including during application shutdown.
    this.checkClosed()
  }
  private checkClosed(): void {
    if (this.finished || !this.leaderExited || this.groupAlive()) return
    if (!this.pipesClosed) {
      // Allow normal stdout drainage first; a stalled consumer cannot retain dead-process pipes forever.
      this.drain ??= setTimeout(() => {
        this.result.outputTruncated = true
        this.child.stdout.destroy()
        this.child.stderr.destroy()
      }, this.limits.drainMs)
      return
    }
    this.finished = true
    clearInterval(this.poll)
    clearTimeout(this.force)
    clearTimeout(this.drain)
    this.tail.finish()
    this.finish({ ...this.result, stderr: this.tail.text, cleanup: 'posix-process-group' })
  }

  async terminate(): Promise<ProcessResult> {
    if (this.shuttingDown && this.result.forced && !this.finished) this.sendSignal('SIGKILL')
    this.beginShutdown()
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      return await Promise.race([
        this.closed,
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(
            () => reject(new ProcessFailure('cleanup-timeout')),
            this.limits.stopTimeoutMs,
          )
        }),
      ])
    } finally {
      clearTimeout(timer)
    }
  }
}
