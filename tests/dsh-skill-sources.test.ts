import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { GeneratedInputs, RunInputManifest } from '../src/shared/engines/run-inputs'
import {
  planDshSkillObservation,
  prepareDshSkillAttachment,
} from '../src/main/engines/adapters/dsh/skills'
import type { DshRow } from '../src/main/engines/adapters/dsh/composition'
import monitorSource from '../src/main/engines/adapters/dsh/skill-monitor.mjs?raw'

const roots: string[] = [],
  disposers: (() => void)[] = []
afterEach(async () => {
  for (const dispose of disposers.splice(0).reverse()) dispose()
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})
async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'agentmatrix-dsh-skills-')))
  roots.push(root)
  const paths = { root, inputs: join(root, 'inputs'), state: join(root, 'state') }
  await mkdir(paths.state)
  const generated = { files: [] } as unknown as GeneratedInputs
  const rows: DshRow[] = []
  planDshSkillObservation(['selected-skill'], paths, generated, rows)
  generated.files.push(
    {
      path: 'dsh-mappings.json',
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
    skills: [{ assetId: 'skill' }],
    files: generated.files,
  } as unknown as RunInputManifest
  const attachment = await prepareDshSkillAttachment(manifest, paths)
  const source = monitorSource
    .replace(
      'process.env.AGENT_MATRIX_DSH_SKILL_NONCE',
      JSON.stringify(attachment.environment.AGENT_MATRIX_DSH_SKILL_NONCE),
    )
    .replace(
      'process.env.AGENT_MATRIX_DSH_SKILL_RECEIPTS',
      JSON.stringify(attachment.environment.AGENT_MATRIX_DSH_SKILL_RECEIPTS),
    )
    .replaceAll('process.cwd()', JSON.stringify(root))
  const monitor = await import(
    /* @vite-ignore */ `data:text/javascript;base64,${Buffer.from(source).toString('base64')}`
  )
  const session = { id: randomUUID(), header: { cwd: root } },
    agent = { session }
  const native = {
    name: 'selected-skill',
    path: join(paths.inputs, 'skills/selected-skill/SKILL.md'),
    provider: 'filesystem',
    source: 'custom',
    content: 'PRIVATE_SKILL_BODY',
  }
  const get = vi.fn(async () => native)
  const snapshot = vi.fn(async () => ({ complete: true, skills: [native] }))
  let ready = () => {},
    change = () => {}
  const ctx = {
    fiber: { state: 2 },
    root: { fiber: { state: 2 } },
    skills: { get, snapshot },
    agents: { get: vi.fn(() => agent) },
    sessions: { get: () => session },
    appReady: {
      onReady: (handler: () => void) => {
        ready = handler
        return () => {}
      },
    },
    effect: (callback: () => () => void) => disposers.push(callback()),
    on: (_event: string, handler: () => void) => {
      change = handler
    },
  }
  monitor.apply(ctx, rows[0]!.config)
  ready()
  return {
    attachment,
    native,
    get,
    snapshot,
    ctx,
    agent,
    session,
    paths,
    manifest,
    change: () => change(),
    verify: (pid = process.pid, sessionId = session.id) =>
      attachment.verify(pid, new AbortController().signal, sessionId),
  }
}
const mismatch = { diagnostic: { check: 'dsh-skills', reason: 'mismatch', fields: ['skills'] } }
const unavailable = {
  diagnostic: { check: 'dsh-skills', reason: 'unavailable', fields: ['skills'] },
}
describe('DSH session-scoped Skill observations', () => {
  it('reads the current agent scope and removes private receipts after every successful verification', async () => {
    const f = await fixture()
    await f.verify()
    expect(f.get).toHaveBeenCalledWith(
      'selected-skill',
      expect.objectContaining({
        scope: f.agent,
        cwd: f.manifest.cwd,
        signal: expect.any(AbortSignal),
      }),
    )
    await f.verify()
    expect(f.snapshot).toHaveBeenCalledTimes(2)
    expect(f.get).toHaveBeenCalledTimes(2)
    await f.attachment.cleanup()
    await expect(
      readFile(join(f.attachment.environment.AGENT_MATRIX_DSH_SKILL_RECEIPTS, 'request.json')),
    ).rejects.toMatchObject({ code: 'ENOENT' })
  })
  it.each(['foreign', 'relative', 'alias', 'provider', 'source', 'missing'])(
    'rejects a selected name with a different %s source',
    async (kind) => {
      const f = await fixture()
      if (kind === 'foreign') f.native.path = '/PRIVATE_FOREIGN_PATH/SKILL.md'
      if (kind === 'relative') f.native.path = 'skills/selected-skill/SKILL.md'
      if (kind === 'alias')
        f.native.path = f.native.path.replace('/SKILL.md', '/absent/../SKILL.md')
      if (kind === 'provider') f.native.provider = 'runtime'
      if (kind === 'source') f.native.source = 'user-dsh'
      if (kind === 'missing') f.snapshot.mockResolvedValue({ complete: true, skills: [] })
      await expect(f.verify()).rejects.toMatchObject(mismatch)
      const error = await f.verify().catch((error: unknown) => error)
      expect(JSON.stringify(error)).not.toContain('PRIVATE')
    },
  )
  it('fails closed on incomplete or changing catalogs and native exceptions', async () => {
    const f = await fixture()
    f.snapshot.mockResolvedValueOnce({ complete: false, skills: [f.native] })
    await expect(f.verify()).rejects.toMatchObject(unavailable)
    f.get.mockImplementationOnce(async () => {
      f.change()
      return f.native
    })
    await expect(f.verify()).rejects.toMatchObject(unavailable)
    f.get.mockRejectedValueOnce(new Error('PRIVATE_NATIVE_ERROR'))
    await expect(f.verify()).rejects.toMatchObject(unavailable)
    await f.verify()
    f.get.mockImplementationOnce(async () => {
      f.ctx.fiber.state = 5
      return f.native
    })
    await expect(f.verify()).rejects.toMatchObject(unavailable)
  })
  it('rejects receipts from another process, session, or inactive native scope', async () => {
    const f = await fixture()
    await expect(f.verify(process.pid + 1)).rejects.toMatchObject(unavailable)
    await expect(f.verify(process.pid, randomUUID())).rejects.toMatchObject(unavailable)
    f.ctx.fiber.state = 5
    await expect(f.verify()).rejects.toMatchObject(unavailable)
  })
  it('requires the captured mapping and plan to agree before creating an attachment', async () => {
    const f = await fixture()
    const file = join(f.paths.inputs, 'observers/dsh-skills.json')
    const plan = JSON.parse(await readFile(file, 'utf8'))
    plan.names = ['foreign']
    await writeFile(file, JSON.stringify(plan))
    await expect(prepareDshSkillAttachment(f.manifest, f.paths)).rejects.toMatchObject(unavailable)
  })
  it('does not install a monitor for an empty Skill selection', () => {
    const generated = { files: [] } as unknown as GeneratedInputs,
      rows: DshRow[] = []
    planDshSkillObservation(
      [],
      { root: '/root', inputs: '/root/inputs', state: '/root/state' },
      generated,
      rows,
    )
    expect(generated.files).toEqual([])
    expect(rows).toEqual([])
  })
})
