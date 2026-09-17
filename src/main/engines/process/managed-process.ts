import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { isAbsolute } from 'node:path'
import { Readable, Writable } from 'node:stream'
import { RedactedTail } from './redacted-tail'

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
  private result: Omit<ProcessResult, 'stderr' | 'cleanup'> = {
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
    this.child = spawn(launch.executable, launch.args, {
      cwd: launch.cwd,
      env: { ...launch.environment },
      stdio: 'pipe',
      shell: false,
      detached: true,
    })
    this.stdout = Readable.toWeb(this.child.stdout, {
      strategy: { highWaterMark: 65_536, size: (chunk: Uint8Array) => chunk.byteLength },
    }) as ReadableStream<Uint8Array>
    this.stdin = Writable.toWeb(this.child.stdin) as WritableStream<Uint8Array>
    this.ready = new Promise((resolve, reject) => {
      this.child.once('spawn', resolve)
      this.child.once('error', () => {
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
    this.child.once('exit', (code, signal) => {
      this.leaderExited = true
      this.result.code = code
      this.result.signal = signal
      this.beginShutdown()
    })
    this.child.once('close', (code, signal) => {
      this.pipesClosed = true
      this.leaderExited = true
      this.result.code = code
      this.result.signal = signal
      this.beginShutdown()
      this.checkClosed()
    })
  }

  get pid(): number | undefined {
    return this.child.pid
  }
  get done(): boolean {
    return this.finished
  }
  get diagnostics(): string {
    return this.tail.text
  }

  private groupAlive(): boolean {
    if (!this.child.pid) return false
    try {
      process.kill(-this.child.pid, 0)
      return true
    } catch (error) {
      return (error as NodeJS.ErrnoException).code !== 'ESRCH'
    }
  }
  private sendSignal(signal: NodeJS.Signals): void {
    if (this.finished || !this.child.pid) return
    try {
      process.kill(-this.child.pid, signal)
    } catch {
      /* Closed is proven separately; a failed signal must not masquerade as cleanup. */
    }
  }
  private beginShutdown(): void {
    if (this.shuttingDown || this.finished) return
    this.shuttingDown = true
    this.child.stdin.destroy()
    this.sendSignal('SIGTERM')
    this.force = setTimeout(() => {
      if (this.groupAlive()) {
        this.result.forced = true
        this.sendSignal('SIGKILL')
      }
    }, this.limits.graceMs)
    this.poll = setInterval(() => this.checkClosed(), 25)
    this.poll.unref()
    this.force.unref()
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
