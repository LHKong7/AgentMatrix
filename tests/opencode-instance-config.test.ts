import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import type { RunInputManifest } from '../src/shared/engines/run-inputs'
import {
  prepareOpenCodeConfigurationAttachment,
  openCodeConfigPlanPath,
} from '../src/main/engines/adapters/opencode/instance-config'

vi.mock('node:net', () => ({
  createServer: () => ({
    once: vi.fn(),
    listen: (_port: number, _host: string, callback: () => void) => callback(),
    address: () => ({ port: 49123 }),
    close: (callback: () => void) => callback(),
  }),
}))
const roots: string[] = []
afterEach(async () => {
  vi.unstubAllGlobals()
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})
const privateKey = 'PRIVATE_KEY_"\\中文'
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'agentmatrix-instance-config-'))
  roots.push(root)
  const paths = { root, inputs: join(root, 'inputs'), state: join(root, 'state') }
  await mkdir(join(paths.inputs, 'observers'), { recursive: true })
  await writeFile(join(paths.inputs, openCodeConfigPlanPath), '{"version":1}')
  await writeFile(join(paths.inputs, 'role.md'), '  PRIVATE_PROMPT {env:NEVER_READ}\n')
  const expected = {
    provider: {
      privateProvider: { options: { baseURL: 'https://example.test/v1', apiKey: '{env:SECRET}' } },
    },
    agent: { build: { prompt: '{file:role.md}', permission: 'ask' } },
    model: 'selected',
    instructions: ['selected-instruction.md'],
  }
  await writeFile(join(paths.inputs, 'opencode.json'), JSON.stringify(expected))
  const manifest = {
    cwd: root,
    agent: {},
    prompts: [{ path: 'role.md' }],
    skills: [],
    files: [{ path: openCodeConfigPlanPath }],
  } as unknown as RunInputManifest
  const environment = { SECRET: JSON.stringify(privateKey).slice(1, -1) }
  const attachment = await prepareOpenCodeConfigurationAttachment(manifest, paths, environment)
  const actual = structuredClone(expected)
  actual.provider.privateProvider.options.apiKey = privateKey
  actual.agent.build.prompt = 'PRIVATE_PROMPT {env:NEVER_READ}'
  const session = { id: 'ses_fixture', directory: root }
  const fetcher = vi.fn(async (url: URL, options: RequestInit) => {
    options.signal?.throwIfAborted()
    return new Response(JSON.stringify(url.pathname === '/config' ? actual : session))
  })
  vi.stubGlobal('fetch', fetcher)
  return {
    attachment,
    actual,
    session,
    fetcher,
    manifest,
    paths,
    environment,
    verify: () => attachment.verify(process.pid, new AbortController().signal, 'ses_fixture'),
  }
}
const unavailable = {
  diagnostic: { check: 'opencode-instance-config', reason: 'unavailable', fields: [] },
}
it('verifies generated requirements with decoded credentials and literal nested Prompt macros in the acknowledged ACP server', async () => {
  const f = await fixture()
  f.actual.instructions.unshift('native-extra.md')
  await f.verify()
  expect(f.fetcher.mock.calls.map(([url]) => url.pathname)).toEqual([
    '/session/ses_fixture',
    '/config',
    '/session/ses_fixture',
  ])
  for (const [url, options] of f.fetcher.mock.calls) {
    expect(url.origin).toBe('http://127.0.0.1:49123')
    expect(url.searchParams.get('directory')).toBe(f.manifest.cwd)
    expect(options.redirect).toBe('error')
    expect(options.headers).toEqual({ Authorization: f.attachment.secrets[2] })
  }
  expect(f.attachment.secrets).not.toContain(privateKey)
  await f.attachment.cleanup()
  await expect(f.verify()).rejects.toMatchObject({ code: 'process-exit' })
})
it('attributes simultaneous current-instance overrides without leaking actual or expected values', async () => {
  const f = await fixture()
  f.actual.provider.privateProvider.options.baseURL = 'https://PRIVATE_OVERRIDE.invalid'
  f.actual.provider.privateProvider.options.apiKey = 'PRIVATE_OTHER_KEY'
  f.actual.agent.build.prompt = 'PRIVATE_OTHER_BODY'
  const error = await f.verify().catch((error: unknown) => error)
  expect(error).toMatchObject({
    diagnostic: {
      check: 'opencode-instance-config',
      reason: 'mismatch',
      fields: ['connection', 'authentication', 'prompts'],
    },
  })
  expect(JSON.stringify(error)).not.toMatch(/PRIVATE|privateProvider|example.test/)
})
it.each(['array', 'null', 'json', 'utf8', 'size', 'http', 'redirect', 'network'])(
  'rejects %s config responses as unavailable',
  async (kind) => {
    const f = await fixture(),
      original = f.fetcher.getMockImplementation()!
    f.fetcher.mockImplementation(async (url, options) => {
      if (url.pathname !== '/config') return original(url, options)
      if (kind === 'network' || kind === 'redirect') throw new Error('PRIVATE_HTTP_ERROR')
      return new Response(
        kind === 'utf8'
          ? new Uint8Array([0xff])
          : kind === 'array'
            ? '[]'
            : kind === 'null'
              ? 'null'
              : kind === 'size'
                ? 'x'.repeat(4_194_305)
                : 'PRIVATE_INVALID_JSON',
        { status: kind === 'http' ? 401 : 200 },
      )
    })
    await expect(f.verify()).rejects.toMatchObject(unavailable)
  },
)
it.each(['session', 'directory'])(
  'rejects %s changes during the native read window',
  async (kind) => {
    const f = await fixture(),
      original = f.fetcher.getMockImplementation()!
    f.fetcher.mockImplementation(async (url, options) => {
      const response = await original(url, options)
      if (url.pathname === '/config') {
        if (kind === 'session') f.session.id = 'ses_other'
        else f.session.directory = '/other'
      }
      return response
    })
    await expect(f.verify()).rejects.toMatchObject(unavailable)
  },
)
it.each(['marker', 'unknown-file', 'missing-secret'])(
  'rejects invalid captured %s input before native reads',
  async (kind) => {
    const f = await fixture()
    if (kind === 'marker')
      await writeFile(join(f.paths.inputs, openCodeConfigPlanPath), '{"version":2}')
    if (kind === 'unknown-file')
      await writeFile(
        join(f.paths.inputs, 'opencode.json'),
        '{"prompt":"{file:/PRIVATE_UNSELECTED}"}',
      )
    await expect(
      prepareOpenCodeConfigurationAttachment(
        f.manifest,
        f.paths,
        kind === 'missing-secret' ? {} : f.environment,
      ),
    ).rejects.toMatchObject(unavailable)
    expect(f.fetcher).not.toHaveBeenCalled()
  },
)
