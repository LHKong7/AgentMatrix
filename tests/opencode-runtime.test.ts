import { afterEach, expect, it, vi } from 'vitest'
import { connectOpenCode } from '../src/main/engines/adapters/opencode/runtime'
import {
  openCodeSkillPlanPath,
  prepareOpenCodeSkillAttachment,
} from '../src/main/engines/adapters/opencode/skills'
import { prepareOpenCodePluginAttachment } from '../src/main/engines/adapters/opencode/plugins'
import { verifyOpenCodeSkillReadback } from '../src/main/engines/adapters/opencode/readback'
import { prepareRunLaunch } from '../src/main/engines/run-launch'
import { attachAcpProcess } from '../src/main/engines/acp/attachment'
import type { RunInputStore } from '../src/main/engines/run-input-store'
import type { RunInputManifest } from '../src/shared/engines/run-inputs'
import { RuntimeFailure } from '../src/main/engines/runtime'
import type { ProcessLaunch } from '../src/main/engines/process/managed-process'

vi.mock('../src/main/engines/run-launch', () => ({ prepareRunLaunch: vi.fn() }))
vi.mock('../src/main/engines/acp/attachment', () => ({ attachAcpProcess: vi.fn() }))
vi.mock('../src/main/engines/adapters/opencode/plugins', () => ({
  prepareOpenCodePluginAttachment: vi.fn(),
}))
vi.mock('../src/main/engines/adapters/opencode/readback', () => ({
  verifyOpenCodeReadback: vi.fn(),
  verifyOpenCodeSkillReadback: vi.fn(),
}))
vi.mock('../src/main/engines/adapters/opencode/skills', async (original) => ({
  ...(await original<typeof import('../src/main/engines/adapters/opencode/skills')>()),
  prepareOpenCodeSkillAttachment: vi.fn(),
}))
afterEach(() => vi.resetAllMocks())

function fixture(legacy = false) {
  const manifest = {
    adapter: { id: 'opencode-acp', version: '1' },
    installation: { kind: 'opencode', version: '1.18.16' },
    launch: { mode: 'acp' },
    agent: { execution: {} },
    connection: { id: 'local' },
    cwd: '/fixture/project',
    skills: [{}],
    files: legacy ? [] : [{ path: openCodeSkillPlanPath }],
    nativePlugins: [],
  } as unknown as RunInputManifest
  const signal = new AbortController(),
    lifetime = new AbortController()
  const choices = [
    {
      id: 'model',
      type: 'select',
      currentValue: 'agentmatrix-local/selected',
      name: 'Model',
      options: [],
    },
    { id: 'mode', type: 'select', currentValue: 'build', name: 'Mode', options: [] },
  ]
  let settle: (value: unknown) => void = () => {}
  const closed = new Promise((resolve) => {
    settle = resolve
  })
  const close = vi.fn(async () => {
    lifetime.abort()
    settle({ code: 0 })
    return { code: 0 }
  })
  const client = {
    signal: lifetime.signal,
    initialize: vi.fn().mockResolvedValue({
      agentInfo: { version: '1.18.16' },
      agentCapabilities: { sessionCapabilities: { resume: {} } },
    }),
    newSession: vi.fn().mockResolvedValue({ sessionId: 'ses_fixture', configOptions: choices }),
    resumeSession: vi.fn().mockResolvedValue({ configOptions: choices }),
    prompt: vi.fn().mockResolvedValue({ stopReason: 'end_turn' }),
    cancel: vi.fn(),
    close: vi.fn(),
  }
  const launch: ProcessLaunch = {
    executable: '/fixture/oc',
    args: [],
    cwd: manifest.cwd,
    environment: {},
  }
  vi.mocked(prepareRunLaunch).mockResolvedValue({ manifest, launch })
  vi.mocked(attachAcpProcess).mockResolvedValue({
    client,
    close,
    closed,
    process: { pid: process.pid },
  } as unknown as Awaited<ReturnType<typeof attachAcpProcess>>)
  vi.mocked(prepareOpenCodePluginAttachment).mockResolvedValue(null)
  const observer = {
    environment: {
      OPENCODE_SERVER_USERNAME: 'opencode',
      OPENCODE_SERVER_PASSWORD: 'ephemeral-secret',
    },
    args: ['--hostname', '127.0.0.1', '--port', '49123'],
    secrets: ['ephemeral-secret'],
    verify: vi.fn().mockResolvedValue(undefined),
    cleanup: vi.fn().mockResolvedValue(undefined),
  }
  vi.mocked(prepareOpenCodeSkillAttachment).mockResolvedValue(observer)
  const paths = { root: '/fixture', inputs: '/fixture/inputs', state: '/fixture/state' }
  const store = {
    paths: () => paths,
    verifyForReuse: vi.fn().mockResolvedValue(manifest),
  } as unknown as RunInputStore
  return {
    launch,
    observer,
    client,
    close,
    signal,
    choices,
    connect: (previousNativeSessionId?: string) =>
      connectOpenCode({
        store,
        snapshotId: 'capture',
        resolveSecret: async () => '',
        environment: {},
        signal: signal.signal,
        previousNativeSessionId,
      }),
  }
}
const handlers = {
  output: async () => {},
  interaction: async () => ({ kind: 'cancelled' as const }),
}
it('checks the current instance on start/resume and before and after turns', async () => {
  const f = fixture(),
    runtime = await f.connect('ses_fixture')
  expect(runtime.configurationChecks).toContain('opencode.instance-skills')
  expect(runtime.configurationChecks).not.toContain('opencode.skill-sources')
  expect(verifyOpenCodeSkillReadback).not.toHaveBeenCalled()
  expect(f.observer.verify).toHaveBeenCalledWith(
    process.pid,
    expect.any(AbortSignal),
    'ses_fixture',
  )
  await runtime.send('Hello', handlers)
  expect(f.observer.verify).toHaveBeenCalledTimes(3)
  f.observer.verify.mockRejectedValueOnce(
    new RuntimeFailure('configuration', 'native.instance-skills'),
  )
  await expect(runtime.send('Rejected', handlers)).rejects.toThrow('native.instance-skills')
  expect(f.client.prompt).toHaveBeenCalledTimes(1)
  await runtime.dispose()
  await runtime.closed
  expect(f.observer.cleanup).toHaveBeenCalled()
})
it('does not submit a prompt when cancellation happens during instance readback', async () => {
  const f = fixture(),
    runtime = await f.connect()
  let release = () => {}
  f.observer.verify.mockImplementationOnce(
    () =>
      new Promise<void>((resolve) => {
        release = resolve
      }),
  )
  const turn = runtime.send('Cancelled before submission', handlers)
  await vi.waitFor(() => expect(f.observer.verify).toHaveBeenCalledTimes(2))
  await runtime.cancel()
  release()
  expect((await turn).outcome).toBe('cancelled')
  expect(f.client.prompt).not.toHaveBeenCalled()
  expect(f.client.cancel).not.toHaveBeenCalled()
  await runtime.send('Next turn', handlers)
  expect(f.client.prompt).toHaveBeenCalledTimes(1)
  await runtime.dispose()
})
it('cleans up when a startup source check rejects and never reports Ready', async () => {
  const f = fixture()
  f.observer.verify.mockRejectedValueOnce(
    new RuntimeFailure('configuration', 'native.instance-skills'),
  )
  await expect(f.connect()).rejects.toThrow('native.instance-skills')
  expect(f.close).toHaveBeenCalled()
  expect(f.observer.cleanup).toHaveBeenCalled()
  expect(f.client.prompt).not.toHaveBeenCalled()
})
it('rejects combined credential redaction overflow before starting the ACP child', async () => {
  const f = fixture()
  f.launch.secrets = Array.from({ length: 256 }, (_, index) => `secret-${index}`)
  await expect(f.connect()).rejects.toMatchObject({ code: 'configuration' })
  expect(attachAcpProcess).not.toHaveBeenCalled()
  expect(f.observer.cleanup).toHaveBeenCalled()
})
it('retains legacy separate-process evidence without claiming instance verification', async () => {
  const f = fixture(true),
    runtime = await f.connect()
  expect(verifyOpenCodeSkillReadback).toHaveBeenCalledOnce()
  expect(prepareOpenCodeSkillAttachment).not.toHaveBeenCalled()
  expect(runtime.configurationChecks).toContain('opencode.skill-sources')
  expect(runtime.configurationChecks).not.toContain('opencode.instance-skills')
  await runtime.dispose()
})
