import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import type { GeneratedInputs, RunInputManifest } from '../src/shared/engines/run-inputs'
import {
  dshMcpPlanPath,
  dshMcpRowId,
  planDshMcpObservation,
  prepareDshMcpAttachment,
} from '../src/main/engines/adapters/dsh/mcp'
import {
  DshExpression,
  parseDshYaml,
  writeDshYaml,
  type DshRow,
} from '../src/main/engines/adapters/dsh/composition'
import { inspectDshPluginFramework } from '../src/main/engines/adapters/dsh/plugins'

vi.mock('../src/main/engines/adapters/dsh/plugins', async (original) => ({
  ...(await original<typeof import('../src/main/engines/adapters/dsh/plugins')>()),
  inspectDshPluginFramework: vi.fn().mockResolvedValue([]),
}))
const roots: string[] = [],
  disposers: (() => void)[] = []
afterEach(async () => {
  for (const dispose of disposers.splice(0).reverse()) dispose()
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
  vi.mocked(inspectDshPluginFramework).mockResolvedValue([])
})
async function fixture(booted = true) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'agentmatrix-dsh-mcp-')))
  roots.push(root)
  const paths = { root, inputs: join(root, 'inputs'), state: join(root, 'state') }
  await mkdir(paths.state)
  const selected = ['one', 'two'].map((id) => ({
    id: dshMcpRowId(id),
    name: 'file:///fixture/mcp.js',
    config: {
      serverName: id,
      transport: 'streamable-http',
      url: 'https://PRIVATE.invalid/mcp',
      headers: { Authorization: new DshExpression('process.env.SECRET') },
      failOnStartupError: true,
      reconnect: { enabled: false },
    },
  }))
  const generated = {
    files: [],
    externalSources: { coverage: 'partial', files: [] },
  } as unknown as GeneratedInputs
  const rows: DshRow[] = [...selected]
  await planDshMcpObservation('/fixture/dsh', selected, paths, generated, rows)
  const profile = writeDshYaml([{ insert: rows }])
  // Distinct copies preserve native expressions while avoiding YAML aliases.
  expect(() => parseDshYaml(profile)).not.toThrow()
  expect(profile.match(/process.env.SECRET/g)).toHaveLength(4)
  generated.files.push({ path: 'profile/cordis.patch.yml', content: profile })
  for (const file of generated.files) {
    const target = join(paths.inputs, file.path)
    await mkdir(join(target, '..'), { recursive: true })
    await writeFile(target, file.content)
  }
  const manifest = {
    cwd: root,
    mcpServers: [{ id: 'one' }, { id: 'two' }],
    files: generated.files,
    installation: { executable: '/fixture/dsh' },
  } as unknown as RunInputManifest
  const attachment = await prepareDshMcpAttachment(manifest, paths)
  const source = generated.files
    .find((file) => file.path === 'observers/dsh-mcp.mjs')!
    .content.replace(
      'process.env.AGENT_MATRIX_DSH_MCP_NONCE',
      JSON.stringify(attachment.environment.AGENT_MATRIX_DSH_MCP_NONCE),
    )
    .replace(
      'process.env.AGENT_MATRIX_DSH_MCP_RECEIPTS',
      JSON.stringify(attachment.environment.AGENT_MATRIX_DSH_MCP_RECEIPTS),
    )
    .replaceAll('process.cwd()', JSON.stringify(root))
  const monitor = await import(
    /* @vite-ignore */ `data:text/javascript;base64,${Buffer.from(source).toString('base64')}`
  )
  const entries = selected.map((row, index) => ({
    options: JSON.parse(
      JSON.stringify(row, (_key, value) =>
        value instanceof DshExpression ? { __jsExpr: value.source } : value,
      ),
    ) as typeof row,
    fiber: { state: 2, uid: index + 1 },
    disabled: false,
  }))
  const session = { id: randomUUID(), header: { cwd: root } }
  let ready = () => {},
    status: (fiber: unknown) => void = () => {}
  const ctx = {
    fiber: { state: 2 },
    root: { fiber: { state: 2 } },
    loader: { entries: () => entries.values() },
    sessions: { get: () => session },
    appReady: {
      onReady: (callback: () => void) => {
        ready = callback
        return () => {}
      },
    },
    effect: (callback: () => () => void) => disposers.push(callback()),
    on: (_event: string, callback: (fiber: unknown) => void) => {
      status = callback
    },
  }
  monitor.apply(ctx, rows.at(-1)!.config)
  if (booted) ready()
  return {
    attachment,
    entries,
    session,
    ctx,
    paths,
    manifest,
    ready,
    status,
    verify: (pid = process.pid, id = session.id) =>
      attachment.verify(pid, new AbortController().signal, id),
  }
}
const unavailable = { diagnostic: { check: 'dsh-mcp', reason: 'unavailable', fields: ['mcp'] } }
it('records completed native initialization without inventing connection state or retaining native fields', async () => {
  const f = await fixture()
  const receipt = await f.attachment.observe(
    process.pid,
    new AbortController().signal,
    f.session.id,
  )
  expect(receipt).toEqual({
    source: 'dsh-mcp-startup',
    checkedAt: expect.any(String),
    statuses: ['startup-complete', 'startup-complete'],
  })
  expect(JSON.stringify(receipt)).not.toMatch(/PRIVATE|SECRET|one|two|connected/)
  await f.verify()
  await f.attachment.cleanup()
})
it.each(['name', 'config', 'disabled', 'state', 'duplicate', 'uid', 'pid', 'session', 'cwd'])(
  'rejects mismatched native %s evidence',
  async (kind) => {
    const f = await fixture()
    if (kind === 'name') f.entries[0]!.options.name = 'file:///PRIVATE_REPLACEMENT.mjs'
    if (kind === 'config') f.entries[0]!.options.config.url = 'https://PRIVATE_OTHER.invalid'
    if (kind === 'disabled') f.entries[0]!.disabled = true
    if (kind === 'state') f.entries[0]!.fiber.state = 0
    if (kind === 'duplicate') f.entries.push(f.entries[0]!)
    if (kind === 'uid') f.entries[1]!.fiber.uid = f.entries[0]!.fiber.uid
    if (kind === 'cwd') f.session.header.cwd = '/PRIVATE_OTHER'
    const error = await f
      .verify(
        kind === 'pid' ? process.pid + 1 : process.pid,
        kind === 'session' ? randomUUID() : f.session.id,
      )
      .catch((error: unknown) => error)
    expect(error).toMatchObject(unavailable)
    expect(JSON.stringify(error)).not.toMatch(/PRIVATE|SECRET/)
  },
)
it('latches a component lifecycle failure even if the same fiber reports running later', async () => {
  const f = await fixture()
  f.entries[0]!.fiber.state = 0
  f.status(f.entries[0]!.fiber)
  f.entries[0]!.fiber.state = 2
  await expect(f.verify()).rejects.toMatchObject(unavailable)
})
it('waits for native boot and cancels without publishing an initialization receipt', async () => {
  const f = await fixture(false),
    controller = new AbortController()
  const waiting = f.attachment.verify(process.pid, controller.signal, null, true)
  const rejection = expect(waiting).rejects.toMatchObject({ code: 'process-exit' })
  controller.abort()
  await rejection
  f.ready()
  await f.verify()
})
it.each(['manifest-order', 'framework', 'plan'] as const)(
  'rejects a changed %s before attaching a monitor',
  async (kind) => {
    const f = await fixture()
    if (kind === 'manifest-order') f.manifest.mcpServers.reverse()
    if (kind === 'framework')
      vi.mocked(inspectDshPluginFramework).mockRejectedValueOnce(new Error('PRIVATE_CHANGE'))
    if (kind === 'plan') await writeFile(join(f.paths.inputs, dshMcpPlanPath), '{}')
    await expect(prepareDshMcpAttachment(f.manifest, f.paths)).rejects.toMatchObject(unavailable)
  },
)
