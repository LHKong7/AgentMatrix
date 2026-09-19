import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { GeneratedInputs, RunInputManifest } from '../src/shared/engines/run-inputs'
import {
  planOpenCodeSkillObservation,
  prepareOpenCodeSkillAttachment,
} from '../src/main/engines/adapters/opencode/skills'

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
async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'agentmatrix-opencode-skills-')))
  roots.push(root)
  const paths = { root, inputs: join(root, 'inputs'), state: join(root, 'state') }
  const generated = { files: [] } as unknown as GeneratedInputs
  planOpenCodeSkillObservation(['selected-skill'], 'build', generated)
  generated.files.push(
    {
      path: 'opencode-mappings.json',
      content: JSON.stringify({
        skills: [{ assetId: 'skill', name: 'selected-skill', path: 'skills/selected-skill' }],
      }),
    },
    { path: 'skills/selected-skill/SKILL.md', content: 'PRIVATE_SKILL_BODY' },
  )
  for (const file of generated.files) {
    const target = join(paths.inputs, file.path)
    await mkdir(join(target, '..'), { recursive: true })
    await writeFile(target, file.content)
  }
  const manifest = {
    cwd: root,
    agent: {},
    skills: [{ assetId: 'skill' }],
    files: generated.files,
  } as unknown as RunInputManifest
  const attachment = await prepareOpenCodeSkillAttachment(manifest, paths)
  const session = { id: 'ses_fixture', directory: root }
  const skill = {
    name: 'selected-skill',
    location: join(paths.inputs, 'skills/selected-skill/SKILL.md'),
    content: 'PRIVATE_SKILL_BODY',
  }
  const native = { session, skills: [skill] }
  const fetcher = vi.fn(async (url: URL, options: RequestInit) => {
    options.signal?.throwIfAborted()
    return new Response(JSON.stringify(url.pathname === '/skill' ? native.skills : native.session))
  })
  vi.stubGlobal('fetch', fetcher)
  return {
    attachment,
    native,
    skill,
    fetcher,
    paths,
    manifest,
    verify: () => attachment.verify(process.pid, new AbortController().signal, session.id),
  }
}
const mismatch = {
  diagnostic: { check: 'opencode-instance-skills', reason: 'mismatch', fields: ['skills'] },
}
const unavailable = {
  diagnostic: { check: 'opencode-instance-skills', reason: 'unavailable', fields: ['skills'] },
}
describe('OpenCode ACP server Skill observations', () => {
  it('uses the owned loopback listener, fresh authentication, bounded reads, and captured directory', async () => {
    const f = await fixture()
    expect(f.attachment.args).toEqual(['--hostname', '127.0.0.1', '--port', '49123'])
    await f.verify()
    expect(f.fetcher.mock.calls.map(([url]) => url.pathname)).toEqual([
      '/session/ses_fixture',
      '/skill',
      '/session/ses_fixture',
    ])
    for (const [url, options] of f.fetcher.mock.calls) {
      expect(url.origin).toBe('http://127.0.0.1:49123')
      expect(url.searchParams.get('directory')).toBe(f.manifest.cwd)
      expect(options.redirect).toBe('error')
      expect(options.signal).toBeInstanceOf(AbortSignal)
      const authorization = (options.headers as Record<string, string>).Authorization!
      expect(Buffer.from(authorization.slice(6), 'base64').toString()).toBe(
        `opencode:${f.attachment.environment.OPENCODE_SERVER_PASSWORD}`,
      )
      expect(f.attachment.secrets).toContain(authorization)
      expect(f.attachment.secrets).toContain(authorization.slice(6))
    }
    const second = await prepareOpenCodeSkillAttachment(f.manifest, f.paths)
    expect(second.environment.OPENCODE_SERVER_PASSWORD).not.toBe(
      f.attachment.environment.OPENCODE_SERVER_PASSWORD,
    )
    expect(JSON.stringify(f.manifest)).not.toContain(
      f.attachment.environment.OPENCODE_SERVER_PASSWORD,
    )
  })
  it.each(['foreign', 'relative', 'alias', 'duplicate', 'missing'])(
    'rejects a %s selected Skill entry',
    async (kind) => {
      const f = await fixture()
      if (kind === 'foreign') f.skill.location = '/PRIVATE_FOREIGN_PATH/SKILL.md'
      if (kind === 'relative') f.skill.location = 'skills/selected-skill/SKILL.md'
      if (kind === 'alias')
        f.skill.location = f.skill.location.replace('/SKILL.md', '/absent/../SKILL.md')
      if (kind === 'duplicate') f.native.skills.push({ ...f.skill })
      if (kind === 'missing') f.native.skills = []
      await expect(f.verify()).rejects.toMatchObject(mismatch)
      const error = await f.verify().catch((error: unknown) => error)
      expect(JSON.stringify(error)).not.toContain('PRIVATE')
    },
  )
  it('allows unrelated native Skills without confusing them with a captured selection', async () => {
    const f = await fixture()
    f.native.skills.push({
      name: 'builtin',
      location: '<built-in>',
      content: 'PRIVATE_BUILTIN_BODY',
    })
    await f.verify()
  })
  it.each(['session', 'directory'])(
    'requires the same native %s before and after source readback',
    async (kind) => {
      const f = await fixture(),
        original = f.fetcher.getMockImplementation()!
      f.fetcher.mockImplementation(async (url, options) => {
        const result = await original(url, options)
        if (url.pathname === '/skill')
          f.native.session = {
            ...f.native.session,
            ...(kind === 'session' ? { id: 'ses_other' } : { directory: '/other' }),
          }
        return result
      })
      await expect(f.verify()).rejects.toMatchObject(unavailable)
    },
  )
  it.each(['large', 'malformed', 'http-error', 'network-error'])(
    'bounds and sanitizes %s native output',
    async (kind) => {
      const f = await fixture()
      f.fetcher.mockImplementationOnce(async () => {
        if (kind === 'network-error') throw new Error('PRIVATE_NATIVE_ERROR')
        return new Response(kind === 'large' ? 'x'.repeat(4_194_305) : 'PRIVATE_INVALID_JSON', {
          status: kind === 'http-error' ? 401 : 200,
        })
      })
      await expect(f.verify()).rejects.toMatchObject(unavailable)
    },
  )
  it('honors lifetime cancellation and cleanup before issuing an observation', async () => {
    const f = await fixture(),
      signal = new AbortController()
    signal.abort()
    await expect(
      f.attachment.verify(process.pid, signal.signal, 'ses_fixture'),
    ).rejects.toMatchObject({ code: 'process-exit' })
    await f.attachment.cleanup()
    await expect(f.verify()).rejects.toMatchObject({ code: 'process-exit' })
    expect(f.fetcher).not.toHaveBeenCalled()
  })
  it('rejects inconsistent captured mappings before selecting a native listener', async () => {
    const f = await fixture(),
      path = join(f.paths.inputs, 'observers/opencode-skills.json')
    const plan = JSON.parse(await readFile(path, 'utf8'))
    plan.names = ['foreign']
    await writeFile(path, JSON.stringify(plan))
    await expect(prepareOpenCodeSkillAttachment(f.manifest, f.paths)).rejects.toMatchObject(
      unavailable,
    )
  })
})
