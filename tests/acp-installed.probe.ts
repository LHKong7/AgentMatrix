import { spawn } from 'node:child_process'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { isAbsolute, join } from 'node:path'
import { Readable, Writable } from 'node:stream'
import { afterAll, expect, it } from 'vitest'
import { AcpClient } from '../src/main/engines/acp/client'

const results: object[] = []
const installations = [
  { kind: 'opencode', executable: process.env.AGENT_MATRIX_TEST_OPENCODE },
  { kind: 'deepseek-harness', executable: process.env.AGENT_MATRIX_TEST_DSH },
]

for (const { kind, executable } of installations) {
  it.runIf(Boolean(executable))(
    `initializes installed ${kind} through the application ACP client without model calls`,
    async () => {
      if (!executable || !isAbsolute(executable))
        throw new Error('An absolute CLI path is required')
      const root = await mkdtemp(join(tmpdir(), 'agentmatrix-acp-client-'))
      const env: NodeJS.ProcessEnv = {}
      for (const key of [
        'HOME',
        'USERPROFILE',
        'SYSTEMROOT',
        'WINDIR',
        'PATH',
        'TMPDIR',
        'TEMP',
        'TMP',
      ]) {
        if (process.env[key]) env[key] = process.env[key]
      }
      env.LANG = 'en_US.UTF-8'
      for (const key of ['XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_STATE_HOME', 'XDG_CACHE_HOME']) {
        env[key] = join(root, key)
        await mkdir(env[key]!, { recursive: true })
      }
      Object.assign(env, {
        OPENCODE_DISABLE_AUTOUPDATE: 'true',
        OPENCODE_DISABLE_MODELS_FETCH: 'true',
        OPENCODE_DISABLE_DEFAULT_PLUGINS: 'true',
        OPENCODE_DISABLE_CLAUDE_CODE: 'true',
        OPENCODE_CONFIG_CONTENT: JSON.stringify({
          autoupdate: false,
          share: 'disabled',
          enabled_providers: [],
          permission: 'deny',
        }),
        DSH_HOME: join(root, 'dsh-home'),
      })
      const args = kind === 'opencode' ? ['acp', '--pure', '--cwd', root] : ['--profile', 'acp']
      const child = spawn(executable, args, {
        cwd: root,
        env,
        stdio: 'pipe',
        detached: process.platform !== 'win32',
      })
      const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
        (resolve) => {
          child.once('close', (code, signal) => resolve({ code, signal }))
        },
      )
      let processError: Error | undefined
      child.on('error', (error) => {
        processError = error
      })
      child.stdin.on('error', () => {})
      child.stderr.resume()
      const peer = new AcpClient(
        Readable.toWeb(child.stdout) as ReadableStream<Uint8Array>,
        Writable.toWeb(child.stdin) as WritableStream<Uint8Array>,
        { update: async () => {}, permission: async () => ({ outcome: { outcome: 'cancelled' } }) },
        { requestTimeoutMs: 15_000 },
      )
      const signal = (value: NodeJS.Signals) => {
        try {
          if (process.platform !== 'win32' && child.pid) process.kill(-child.pid, value)
          else child.kill(value)
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error
        }
      }
      try {
        const response = await peer.initialize('0.1.0')
        expect(processError).toBeUndefined()
        expect(response.protocolVersion).toBe(1)
        expect(response.agentInfo?.name).toBeTruthy()
        results.push({
          kind,
          executable: executable.replace(process.env.HOME ?? '\0', '<user-home>'),
          response,
        })
      } finally {
        peer.close()
        signal('SIGTERM')
        const force = setTimeout(() => signal('SIGKILL'), 1500)
        try {
          await exited
        } finally {
          clearTimeout(force)
          await rm(root, { recursive: true, force: true })
        }
      }
    },
  )
}

afterAll(async () => {
  if (process.env.AGENT_MATRIX_ACP_REPORT) {
    await writeFile(
      process.env.AGENT_MATRIX_ACP_REPORT,
      JSON.stringify(
        {
          checkedAt: new Date().toISOString(),
          platform: process.platform,
          architecture: process.arch,
          sdkVersion: '1.4.0',
          modelCalls: false,
          scope: 'Application ACP client initialization only',
          engines: results,
        },
        null,
        2,
      ) + '\n',
    )
  }
})
