// Fixed application code, executed by Node or Electron's Node mode before any CLI starts.
// Launch data arrives on the private IPC channel, never in command arguments or stdout.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { spawn } = require('node:child_process')
let child, limits, poll, force, drain
let stopping = false,
  exited = false,
  pipesClosed = false,
  groupGone = false,
  finishing = false
const result = { code: null, signal: null, forced: false, outputTruncated: false, failure: null }
function notify(message) {
  if (!process.connected) return
  process.send(message, (error) => {
    if (error) stop()
  })
}
function groupAlive() {
  if (!child?.pid || groupGone) return false
  try {
    process.kill(-child.pid, 0)
    return true
  } catch (error) {
    if (error.code !== 'ESRCH') return true
    groupGone = true
    return false
  }
}
function signal(value) {
  if (!child?.pid || groupGone) return
  try {
    process.kill(-child.pid, value)
  } catch {
    /* Completion is checked separately. */
  }
}
function finish() {
  if (finishing) return
  finishing = true
  clearInterval(poll)
  clearTimeout(force)
  clearTimeout(drain)
  let outputs = 0,
    sent = false
  const complete = () => {
    if (sent) return
    sent = true
    clearTimeout(timeout)
    if (!process.connected) return process.exit(0)
    process.send({ kind: 'closed', result }, () => process.exit(0))
  }
  const timeout = setTimeout(() => {
    result.outputTruncated = true
    process.stdout.destroy()
    process.stderr.destroy()
    complete()
  }, limits?.drainMs ?? 1000)
  const ended = () => {
    if (++outputs === 2) complete()
  }
  process.stdout.end(ended)
  process.stderr.end(ended)
}
function check() {
  if (finishing || !exited || groupAlive()) return
  if (!pipesClosed) {
    drain ??= setTimeout(() => {
      result.outputTruncated = true
      child.stdout.destroy()
      child.stderr.destroy()
    }, limits.drainMs)
    return
  }
  finish()
}
function stop() {
  if (stopping || finishing) return
  stopping = true
  if (!child) {
    exited = true
    pipesClosed = true
    finish()
    return
  }
  process.stdin.unpipe(child.stdin)
  child.stdin.destroy()
  signal('SIGTERM')
  force = setTimeout(() => {
    if (groupAlive()) {
      result.forced = true
      signal('SIGKILL')
    }
  }, limits.graceMs)
  // Keep this process alive even after its parent and the native leader have exited.
  poll = setInterval(check, 25)
  check()
}
process.on('disconnect', stop)
process.on('SIGTERM', stop)
process.on('SIGINT', stop)
process.stdin.on('end', stop)
process.stdin.on('error', stop)
process.stdout.on('error', stop)
process.stderr.on('error', stop)
process.on('message', (message) => {
  if (message?.kind === 'stop') return stop()
  if (message?.kind !== 'launch' || child || stopping || finishing) return stop()
  limits = message.limits
  const launch = message.launch
  child = spawn(launch.executable, launch.args, {
    cwd: launch.cwd,
    env: launch.environment,
    stdio: 'pipe',
    detached: true,
    shell: false,
  })
  child.once('spawn', () => notify({ kind: 'ready', pid: child.pid }))
  child.once('error', () => {
    result.failure = 'spawn'
    exited = true
    notify({ kind: 'spawn-error' })
    stop()
  })
  for (const stream of [child.stdin, child.stdout, child.stderr])
    stream.on('error', () => {
      if (!stopping) {
        result.failure = 'io'
        stop()
      }
    })
  child.once('exit', (code, nativeSignal) => {
    exited = true
    result.code = code
    result.signal = nativeSignal
    notify({ kind: 'exit', code, signal: nativeSignal })
    stop()
  })
  child.once('close', () => {
    pipesClosed = true
    exited = true
    stop()
    check()
  })
  child.stdout.pipe(process.stdout, { end: false })
  child.stderr.pipe(process.stderr, { end: false })
  process.stdin.pipe(child.stdin)
})
notify({ kind: 'boot' })
