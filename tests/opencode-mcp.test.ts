import { afterEach, expect, it, vi } from 'vitest'
import { prepareOpenCodeInstanceHttp } from '../src/main/engines/adapters/opencode/instance-http'
import { observeOpenCodeMcp } from '../src/main/engines/adapters/opencode/mcp'

vi.mock('node:net', () => ({
  createServer: () => ({
    once: vi.fn(),
    listen: (_port: number, _host: string, callback: () => void) => callback(),
    address: () => ({ port: 49123 }),
    close: (callback: () => void) => callback(),
  }),
}))
afterEach(() => {
  vi.unstubAllGlobals()
  vi.useRealTimers()
  vi.restoreAllMocks()
})
async function fixture() {
  const instance = await prepareOpenCodeInstanceHttp('/project', [
    {
      check: 'opencode-instance-config',
      fields: [],
      observe: async () => {},
    },
  ])
  const data: Record<string, unknown> = {
    'agentmatrix-one': { status: 'connected' },
    'agentmatrix-two': { status: 'failed', error: 'PRIVATE_NATIVE_ERROR https://private/key' },
    PRIVATE_UNSELECTED_NAME: { status: 'connected' },
  }
  const session = { id: 'session', directory: '/project' }
  const controller = new AbortController()
  const fetcher = vi.fn(async (url: URL, options: RequestInit) => {
    options.signal?.throwIfAborted()
    return new Response(JSON.stringify(url.pathname === '/mcp' ? data : session))
  })
  vi.stubGlobal('fetch', fetcher)
  return {
    instance,
    data,
    session,
    controller,
    fetcher,
    observe: () =>
      observeOpenCodeMcp(instance, ['one', 'two'], process.pid, controller.signal, 'session'),
  }
}
it('samples selected services in manifest order within an authenticated session window and drops native values', async () => {
  const f = await fixture()
  const result = await f.observe()
  expect(result).toEqual({
    source: 'opencode-acp',
    checkedAt: expect.any(String),
    statuses: ['connected', 'failed'],
  })
  expect(JSON.stringify(result)).not.toMatch(/PRIVATE|https|one|two/)
  expect(f.fetcher.mock.calls.map(([url]) => url.pathname)).toEqual([
    '/session/session',
    '/mcp',
    '/session/session',
  ])
  for (const [url, options] of f.fetcher.mock.calls) {
    expect(url.origin).toBe('http://127.0.0.1:49123')
    expect(url.searchParams.get('directory')).toBe('/project')
    expect(options.redirect).toBe('error')
    expect(options.headers).toEqual({ Authorization: f.instance.secrets[2] })
  }
})
it.each([
  ['disabled', 'disabled'],
  ['needs_auth', 'authentication-required'],
  ['needs_client_registration', 'registration-required'],
  ['new-native-status', 'unknown'],
])(
  'maps %s to a bounded status without returning registration details',
  async (native, expected) => {
    const f = await fixture()
    f.data['agentmatrix-one'] = { status: native, error: 'PRIVATE' }
    expect((await f.observe()).statuses).toEqual([expected, 'failed'])
  },
)
it.each([null, {}, 'connected', { status: true }])(
  'does not infer connectivity from an invalid selected entry: %j',
  async (value) => {
    const f = await fixture()
    f.data['agentmatrix-one'] = value
    expect((await f.observe()).statuses).toEqual(['unknown', 'failed'])
  },
)
it('does not replace a missing selected service with an unselected native service', async () => {
  const f = await fixture()
  delete f.data['agentmatrix-one']
  expect((await f.observe()).statuses).toEqual(['unknown', 'failed'])
})
it.each(['network', 'http', 'json', 'utf8', 'oversized', 'array', 'session', 'directory'])(
  'records unknown instead of blocking the conversation when the %s observation is unavailable',
  async (kind) => {
    const f = await fixture(),
      original = f.fetcher.getMockImplementation()!
    f.fetcher.mockImplementation(async (url, options) => {
      if (url.pathname !== '/mcp') return original(url, options)
      if (kind === 'network') throw new Error('PRIVATE_NATIVE_ERROR')
      if (kind === 'session' || kind === 'directory') {
        f.session[kind === 'session' ? 'id' : 'directory'] = 'OTHER'
        return new Response(JSON.stringify(f.data))
      }
      return new Response(
        kind === 'utf8'
          ? new Uint8Array([0xff])
          : kind === 'oversized'
            ? 'x'.repeat(4_194_305)
            : kind === 'array'
              ? '[]'
              : 'PRIVATE_INVALID_JSON',
        { status: kind === 'http' ? 401 : 200 },
      )
    })
    expect((await f.observe()).statuses).toEqual(['unknown', 'unknown'])
  },
)
it.each(['timeout', 'cancel', 'dispose'])(
  'bounds a stalled status read and handles %s without stale successful evidence',
  async (mode) => {
    vi.useFakeTimers()
    vi.spyOn(AbortSignal, 'timeout').mockImplementation((delay) => {
      const controller = new AbortController()
      setTimeout(() => controller.abort(), delay)
      return controller.signal
    })
    const f = await fixture(),
      original = f.fetcher.getMockImplementation()!
    let entered!: () => void
    const reading = new Promise<void>((resolve) => {
      entered = resolve
    })
    f.fetcher.mockImplementation(async (url, options) => {
      if (url.pathname !== '/mcp') return original(url, options)
      return new Promise<Response>((_resolve, reject) => {
        options.signal!.addEventListener('abort', () => reject(new Error('PRIVATE_ABORT')), {
          once: true,
        })
        entered()
      })
    })
    const observed = f.observe().catch((error: unknown) => error)
    await reading
    if (mode === 'timeout') await vi.advanceTimersByTimeAsync(10_001)
    else if (mode === 'cancel') f.controller.abort()
    else await f.instance.cleanup()
    expect(await observed).toMatchObject(
      mode === 'timeout' ? { statuses: ['unknown', 'unknown'] } : { code: 'process-exit' },
    )
  },
)
