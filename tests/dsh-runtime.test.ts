import { randomUUID } from 'node:crypto'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { SessionConfigOption } from '@agentclientprotocol/sdk'
import type { AcpHandlers } from '../src/main/engines/acp/client'
import { attachAcpProcess } from '../src/main/engines/acp/attachment'
import { AcpFailure } from '../src/main/engines/acp/stream'
import { prepareDshLaunch, verifyDshHome } from '../src/main/engines/adapters/dsh/launch'
import { verifyDshOptions } from '../src/main/engines/adapters/dsh/readback'
import { connectDsh } from '../src/main/engines/adapters/dsh/runtime'
import type { RunInputStore } from '../src/main/engines/run-input-store'
import type { RunInputManifest } from '../src/shared/engines/run-inputs'
import { RuntimeFailure, type RuntimeTurnHandlers } from '../src/main/engines/runtime'
import { dshWorkspace } from './helpers/dsh-fixture'

vi.mock('../src/main/engines/adapters/dsh/launch', () => ({
  prepareDshLaunch: vi.fn(),
  verifyDshHome: vi.fn(),
}))
vi.mock('../src/main/engines/acp/attachment', () => ({ attachAcpProcess: vi.fn() }))
afterEach(() => vi.resetAllMocks())

function fixture() {
  const workspace = dshWorkspace('/fixture/dsh', '/fixture/project')
  const manifest = {
    agent: workspace.agents[0]!,
    connection: workspace.connections[0]!,
    model: workspace.models[0]!,
    cwd: '/fixture/project',
    nativePlugins: [],
  } as unknown as RunInputManifest
  let choices: SessionConfigOption[] = [
    {
      id: 'model',
      name: 'Model',
      type: 'select',
      currentValue: JSON.stringify(['agentmatrix-local', 'fixture-model']),
      options: [],
    },
  ]
  const nativeId = randomUUID()
  const signal = new AbortController(),
    nativeSignal = new AbortController()
  const output = vi.fn<RuntimeTurnHandlers['output']>().mockResolvedValue()
  const handlers: RuntimeTurnHandlers = { output, interaction: async () => ({ kind: 'cancelled' }) }
  const verify = vi.fn().mockResolvedValue(manifest)
  let acp: AcpHandlers
  const result = {
    code: 0,
    signal: null,
    forced: false,
    cleanup: 'group',
    failure: null,
    stderr: '',
  }
  let settle: (value: unknown) => void
  const closed = new Promise((resolve) => {
    settle = resolve
  })
  const client = {
    signal: nativeSignal.signal,
    initialize: vi.fn().mockResolvedValue({
      agentInfo: { name: 'deepseek-harness-acp', version: '0.0.1' },
      agentCapabilities: { sessionCapabilities: { resume: {} } },
    }),
    newSession: vi.fn(async () => ({ sessionId: nativeId, configOptions: choices })),
    resumeSession: vi.fn(async () => ({ configOptions: choices })),
    setSessionConfigOption: vi.fn(async () => ({ configOptions: choices })),
    prompt: vi.fn().mockResolvedValue({ stopReason: 'end_turn' }),
    cancel: vi.fn().mockResolvedValue(undefined),
    close: vi.fn(() => nativeSignal.abort()),
  }
  const close = vi.fn(async () => {
    nativeSignal.abort()
    settle(result)
    return result
  })
  vi.mocked(prepareDshLaunch).mockResolvedValue({
    manifest,
    launch: {
      executable: '/fixture/dsh',
      args: [],
      cwd: manifest.cwd,
      environment: {},
      secrets: ['synthetic-secret'],
    },
  })
  vi.mocked(verifyDshHome).mockResolvedValue()
  vi.mocked(attachAcpProcess).mockImplementation(async (_launch, received) => {
    acp = received
    return { client, close, closed } as unknown as Awaited<ReturnType<typeof attachAcpProcess>>
  })
  const options = {
    store: { verifyForReuse: verify } as unknown as RunInputStore,
    snapshotId: 'inputs',
    environment: {},
    resolveSecret: async () => 'synthetic-secret',
    signal: signal.signal,
  }
  return {
    manifest,
    options,
    client,
    nativeId,
    close,
    signal,
    handlers,
    output,
    verify,
    choices: () => choices,
    replaceChoices: (value: SessionConfigOption[]) => {
      choices = value
    },
    acp: () => acp,
    connect: (previousNativeSessionId?: string) =>
      connectDsh({ ...options, previousNativeSessionId }),
  }
}

describe('DSH runtime contract', () => {
  it('checks the ACP component version separately and leaves billing unknown', async () => {
    const f = fixture(),
      runtime = await f.connect()
    f.client.prompt.mockImplementationOnce(async () => {
      await f.acp().update(
        {
          sessionId: f.nativeId,
          update: {
            sessionUpdate: 'agent_message_chunk',
            content: { type: 'text', text: 'hello synthetic-secret' },
          },
        },
        f.signal.signal,
      )
      return {
        stopReason: 'end_turn',
        usage: { inputTokens: 10, outputTokens: 4, totalTokens: 14 },
      }
    })
    expect(runtime.nativeSessionId).toBe(f.nativeId)
    expect(await runtime.send('Hello', f.handlers)).toEqual({
      outcome: 'completed',
      nativeStopReason: 'end_turn',
      usage: null,
    })
    expect(
      f.output.mock.calls
        .flatMap(([event]) => (event.kind === 'message.delta' ? [event.text] : []))
        .join(''),
    ).toBe('hello [redacted]')
    expect(f.verify).toHaveBeenCalledTimes(2)
    await runtime.dispose()
  })
  it('does not accept a CLI version in place of the ACP contract version', async () => {
    const f = fixture()
    f.client.initialize.mockResolvedValueOnce({
      agentInfo: { name: 'deepseek-harness-acp', version: '0.1.5-rc.2' },
    })
    await expect(f.connect()).rejects.toMatchObject({ field: 'dsh.acp-version' })
    expect(f.close).toHaveBeenCalledOnce()
    expect(f.client.newSession).not.toHaveBeenCalled()
  })
  it('restores the exact native ID without creating a replacement after resume failure', async () => {
    const f = fixture()
    const runtime = await f.connect(f.nativeId)
    expect(f.client.resumeSession).toHaveBeenCalledWith({
      sessionId: f.nativeId,
      cwd: f.manifest.cwd,
      mcpServers: [],
    })
    expect(f.client.newSession).not.toHaveBeenCalled()
    await runtime.dispose()
    const missing = fixture()
    missing.client.resumeSession.mockRejectedValueOnce(new AcpFailure('engine'))
    await expect(missing.connect(missing.nativeId)).rejects.toMatchObject({ code: 'engine' })
    expect(missing.client.newSession).not.toHaveBeenCalled()
    expect(missing.close).toHaveBeenCalledOnce()
  })
  it('rejects malformed resume IDs before native activation', async () => {
    const f = fixture()
    await expect(f.connect('../other-session')).rejects.toMatchObject({
      field: 'dsh.session-identity',
    })
    expect(f.client.resumeSession).not.toHaveBeenCalled()
    expect(f.client.newSession).not.toHaveBeenCalled()
  })
  it('blocks changed captured sources and native controls before another provider turn', async () => {
    const f = fixture(),
      runtime = await f.connect()
    f.verify.mockRejectedValueOnce(new Error('Changed inputs'))
    await expect(runtime.send('Hello', f.handlers)).rejects.toMatchObject({ code: 'configuration' })
    vi.mocked(verifyDshHome).mockRejectedValueOnce(
      new RuntimeFailure('configuration', 'dsh.native-home'),
    )
    await expect(runtime.send('Hello', f.handlers)).rejects.toMatchObject({
      field: 'dsh.native-home',
    })
    expect(f.client.prompt).not.toHaveBeenCalled()
    await runtime.dispose()
  })
  it('cancels preflight without submitting a prompt and allows the next turn', async () => {
    const f = fixture(),
      runtime = await f.connect()
    let release: () => void = () => {}
    f.verify.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          release = resolve
        }),
    )
    const turn = runtime.send('Hello', f.handlers)
    await runtime.cancel()
    release()
    expect((await turn).outcome).toBe('cancelled')
    expect(f.client.prompt).not.toHaveBeenCalled()
    expect(f.client.cancel).not.toHaveBeenCalled()
    expect((await runtime.send('Next', f.handlers)).outcome).toBe('completed')
    await runtime.dispose()
  })
  it('waits for the native terminal response after a submitted cancellation', async () => {
    const f = fixture(),
      runtime = await f.connect()
    let terminal: (value: { stopReason: string }) => void = () => {}
    f.client.prompt.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          terminal = resolve
        }),
    )
    const finished = vi.fn()
    const turn = runtime.send('Hello', f.handlers).then((value) => {
      finished()
      return value
    })
    await vi.waitFor(() => expect(f.client.prompt).toHaveBeenCalled())
    await runtime.cancel()
    expect(f.client.cancel).toHaveBeenCalledWith(f.nativeId)
    expect(finished).not.toHaveBeenCalled()
    terminal({ stopReason: 'cancelled' })
    expect((await turn).outcome).toBe('cancelled')
    await runtime.dispose()
  })
  it('reports provider rejection and protocol timeout as failed operations', async () => {
    const f = fixture(),
      runtime = await f.connect()
    f.client.prompt.mockRejectedValueOnce(new AcpFailure('engine'))
    await expect(runtime.send('Hello', f.handlers)).rejects.toMatchObject({ code: 'engine' })
    f.client.prompt.mockRejectedValueOnce(new AcpFailure('timeout'))
    await expect(runtime.send('Again', f.handlers)).rejects.toMatchObject({ code: 'timeout' })
    await runtime.dispose()
  })
  it('closes on model drift updates even while idle', async () => {
    const f = fixture(),
      runtime = await f.connect()
    const changed = structuredClone(f.choices())
    if (changed[0]?.type !== 'select') throw new Error('Expected select')
    changed[0].currentValue = JSON.stringify(['foreign', 'model'])
    await expect(
      f.acp().update(
        {
          sessionId: f.nativeId,
          update: { sessionUpdate: 'config_option_update', configOptions: changed },
        },
        f.signal.signal,
      ),
    ).rejects.toMatchObject({ field: 'dsh.session-options' })
    expect(f.client.close).toHaveBeenCalled()
    await runtime.dispose()
  })
  it('cleans up when the owner aborts', async () => {
    const f = fixture(),
      runtime = await f.connect()
    f.signal.abort()
    await runtime.closed
    expect(f.close).toHaveBeenCalledOnce()
  })
})

describe('DSH native model readback', () => {
  it('requires the exact full route tuple', () => {
    const f = fixture()
    for (const value of [
      'agentmatrix-local/fixture-model',
      '[]',
      JSON.stringify(['wrong', 'fixture-model']),
      JSON.stringify(['agentmatrix-local', 'wrong']),
      JSON.stringify(['agentmatrix-local', 'fixture-model', 'extra']),
    ]) {
      const option = f.choices()[0]!
      if (option.type !== 'select') throw new Error('Expected select')
      expect(() => verifyDshOptions([{ ...option, currentValue: value }], f.manifest)).toThrow(
        'dsh.session-options',
      )
    }
    expect(() => verifyDshOptions([...f.choices(), ...f.choices()], f.manifest)).toThrow(
      'dsh.session-options',
    )
  })
  it('checks native DeepSeek reasoning without confusing the generic provider route', () => {
    const f = fixture()
    f.manifest.connection.protocol = 'deepseek-official'
    f.manifest.model.parameters.reasoning = 'high'
    const options: SessionConfigOption[] = [
      {
        id: 'model',
        name: 'Model',
        type: 'select',
        currentValue: JSON.stringify(['deepseek-official', 'fixture-model']),
        options: [],
      },
      {
        id: 'reasoning_effort',
        name: 'Reasoning',
        type: 'select',
        currentValue: 'high',
        options: [],
      },
    ]
    expect(verifyDshOptions(options, f.manifest)).toBe(
      JSON.stringify(['deepseek-official', 'fixture-model']),
    )
    options.pop()
    expect(() => verifyDshOptions(options, f.manifest)).toThrow('dsh.session-options')
  })
})
