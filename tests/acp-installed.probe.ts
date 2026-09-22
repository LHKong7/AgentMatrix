import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { isAbsolute, join } from 'node:path'
import { afterAll, expect, it } from 'vitest'
import { attachAcpProcess } from '../src/main/engines/acp/attachment'
import { baseProcessEnvironment } from '../src/main/engines/process/managed-process'

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
      const env = baseProcessEnvironment(process.env)
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
      const attachment = await attachAcpProcess(
        { executable, args, cwd: root, environment: env },
        { update: async () => {}, permission: async () => ({ outcome: { outcome: 'cancelled' } }) },
        { requestTimeoutMs: 15_000 },
      )
      try {
        const response = await attachment.client.initialize('0.1.0')
        expect(response.protocolVersion).toBe(1)
        expect(response.agentInfo?.name).toBeTruthy()
        const cleanup = await attachment.close()
        expect(cleanup.cleanup).toBe('posix-process-group')
        expect(cleanup.failure).toBeNull()
        expect(attachment.process.done).toBe(true)
        results.push({
          kind,
          executable: executable.replace(process.env.HOME ?? '\0', '<user-home>'),
          response,
          cleanup: {
            code: cleanup.code,
            signal: cleanup.signal,
            forced: cleanup.forced,
            scope: cleanup.cleanup,
            outputTruncated: cleanup.outputTruncated,
          },
        })
      } finally {
        try {
          await attachment.close()
        } finally {
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
          scope: 'Application ACP initialization and owned process-group cleanup; no turns',
          engines: results,
        },
        null,
        2,
      ) + '\n',
    )
  }
})
