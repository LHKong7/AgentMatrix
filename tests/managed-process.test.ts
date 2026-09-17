import { afterEach, describe, expect, it } from 'vitest'
import {
  ManagedProcess,
  baseProcessEnvironment,
  stopOwnedProcesses,
} from '../src/main/engines/process/managed-process'
import { RedactedTail } from '../src/main/engines/process/redacted-tail'
import { attachAcpProcess } from '../src/main/engines/acp/attachment'

const processes: ManagedProcess[] = []
afterEach(async () => {
  await Promise.all(processes.splice(0).map((child) => child.terminate()))
})
function fixture(script: string, args: string[] = [], environment: Record<string, string> = {}) {
  const child = new ManagedProcess(
    {
      executable: process.execPath,
      args: ['-e', script, '--', ...args],
      cwd: process.cwd(),
      environment,
    },
    { graceMs: 75, drainMs: 100, stopTimeoutMs: 3000 },
  )
  processes.push(child)
  return child
}
async function output(child: ManagedProcess): Promise<string> {
  const reader = child.stdout.getReader()
  let text = ''
  for (;;) {
    const { value, done } = await reader.read()
    if (done) return text
    text += Buffer.from(value).toString('utf8')
  }
}
function exists(pid: number) {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false
    throw error
  }
}

describe('bounded streaming diagnostic redaction', () => {
  it('handles long repetitive prefixes and invalid UTF-16 without unbounded suffix scans', () => {
    const secret = 'xy'.repeat(25_000) + 'z'
    const tail = new RedactedTail([secret, '\ud800key'])
    tail.push(Buffer.from('q'.repeat(70_000) + secret.slice(0, 45_000)))
    tail.finish()
    expect(tail.text.endsWith('[redacted]')).toBe(true)
    expect(tail.text).not.toContain('xy')
  })
  it('handles every byte split, overlapping secrets, Unicode, JSON escaping, and URL encoding', () => {
    const secret = 'token/中文"abcdef'
    const message = `prefix ${secret} ${JSON.stringify(secret).slice(1, -1)} ${encodeURIComponent(secret)} suffix\n`
    const bytes = Buffer.from(message)
    for (let split = 0; split <= bytes.length; split++) {
      const tail = new RedactedTail([secret, 'abc'])
      tail.push(bytes.subarray(0, split))
      expect(tail.text).not.toContain('token/')
      tail.push(bytes.subarray(split))
      tail.finish()
      expect(tail.text).toBe('prefix [redacted] [redacted] [redacted] suffix\n')
    }
  })
  it('does not reprocess replacement markers or reveal truncated secret prefixes', () => {
    const tail = new RedactedTail(['e', 'secret-long-value'], 64)
    for (let index = 0; index < 100; index++) tail.push(Buffer.from('e'))
    tail.push(Buffer.from(' secret-lo'))
    tail.finish()
    expect(tail.text.length).toBeLessThanOrEqual(64)
    expect(tail.text).toMatch(/\[redacted\] \[redacted\]$/)
    const bounded = new RedactedTail([], 20)
    bounded.push(Buffer.from('x'.repeat(100_000) + 'tail'))
    bounded.finish()
    expect(bounded.text).toBe('x'.repeat(16) + 'tail')
  })
})

describe.skipIf(process.platform === 'win32')('owned POSIX process groups', () => {
  it('retains all owned commands for application-level cleanup', async () => {
    const first = fixture('setInterval(()=>{},1000)')
    const second = fixture('setInterval(()=>{},1000)')
    await Promise.all([first.ready, second.ready])
    await stopOwnedProcesses()
    expect(first.done && second.done).toBe(true)
    expect(exists(first.pid!) || exists(second.pid!)).toBe(false)
    await stopOwnedProcesses()
  })
  it('automatically disposes a live process after malformed ACP output', async () => {
    const attachment = await attachAcpProcess(
      {
        executable: process.execPath,
        args: [
          '-e',
          "process.stdin.once('data',()=>process.stdout.write('not JSON\\n')); setInterval(()=>{},1000)",
        ],
        cwd: process.cwd(),
        environment: {},
      },
      { update: async () => {}, permission: async () => ({ outcome: { outcome: 'cancelled' } }) },
    )
    processes.push(attachment.process)
    await expect(attachment.client.initialize('0.1.0')).rejects.toMatchObject({ code: 'protocol' })
    await attachment.closed
    expect(attachment.process.done).toBe(true)
    expect(exists(attachment.process.pid!)).toBe(false)
  })
  it('passes arguments literally and inherits only an explicit environment baseline', async () => {
    const environment = baseProcessEnvironment({
      PATH: '/usr/bin:/bin',
      HOME: '/tmp/home',
      NODE_OPTIONS: '--inspect',
      API_KEY: 'parent-secret',
      LANG: 'en_US.UTF-8',
    })
    expect(environment).toEqual({ PATH: '/usr/bin:/bin', HOME: '/tmp/home', LANG: 'en_US.UTF-8' })
    const literal = '$(touch should-not-exist); `echo nope` * spaces'
    const child = fixture(
      'process.stdout.write(JSON.stringify({args:process.argv.slice(1),key:process.env.API_KEY,loader:process.env.NODE_OPTIONS,home:process.env.HOME}))',
      [literal],
      environment,
    )
    await child.ready
    expect(JSON.parse(await output(child))).toEqual({ args: [literal], home: '/tmp/home' })
    expect(await child.closed).toMatchObject({
      code: 0,
      forced: false,
      outputTruncated: false,
      cleanup: 'posix-process-group',
    })
    expect(child.done).toBe(true)
  })
  it('reports missing executables without exposing environment values', async () => {
    const child = new ManagedProcess({
      executable: '/no-such-agentmatrix-executable',
      args: [],
      cwd: process.cwd(),
      environment: { API_KEY: 'private-value' },
    })
    processes.push(child)
    await expect(child.ready).rejects.toMatchObject({
      code: 'spawn',
      message: 'Agent process spawn',
    })
    expect(await child.closed).toMatchObject({ failure: 'spawn', stderr: '' })
  })
  it('forces termination when the leader ignores SIGTERM and makes repeated cleanup harmless', async () => {
    const child = fixture(
      "process.on('SIGTERM',()=>{}); process.stdout.write('ready'); setInterval(()=>{},1000)",
    )
    await child.ready
    const reader = child.stdout.getReader()
    await reader.read()
    const result = await child.terminate()
    expect(result).toMatchObject({ forced: true, signal: 'SIGKILL' })
    expect(exists(child.pid!)).toBe(false)
    expect(await child.terminate()).toEqual(result)
  })
  it('cleans a resistant descendant even after its leader has exited', async () => {
    const child = fixture(`
      const {spawn}=require('node:child_process');
      const grandchild=spawn(process.execPath,['-e',"process.on('SIGTERM',()=>{}); process.stdout.write(String(process.pid)); setInterval(()=>{},1000)"],{stdio:['ignore','pipe','inherit']});
      grandchild.stdout.once('data',chunk=>{process.stdout.write(chunk,()=>process.exit(0))});
    `)
    await child.ready
    const { value } = await child.stdout.getReader().read()
    const grandchild = Number(Buffer.from(value!).toString('utf8'))
    expect(Number.isInteger(grandchild) && grandchild > 0).toBe(true)
    const result = await child.closed
    expect(result).toMatchObject({ code: 0, forced: true })
    expect(exists(grandchild)).toBe(false)
    expect(() => process.kill(-child.pid!, 0)).toThrow()
  })
  it('redacts real stderr chunks before exposing a bounded diagnostic tail', async () => {
    const secret = 'synthetic-test-secret'
    const child = new ManagedProcess({
      executable: process.execPath,
      args: [
        '-e',
        "const key=process.env.API_KEY; process.stderr.write('x'.repeat(20000)+key.slice(0,7)); setTimeout(()=>{process.stderr.write(key.slice(7)+' end\\n')},10)",
      ],
      cwd: process.cwd(),
      environment: { API_KEY: secret },
      secrets: [secret],
    })
    processes.push(child)
    await child.ready
    await output(child)
    const result = await child.closed
    expect(result.stderr.length).toBeLessThanOrEqual(8192)
    expect(result.stderr).toContain('[redacted] end')
    expect(result.stderr).not.toContain(secret)
  })
})
