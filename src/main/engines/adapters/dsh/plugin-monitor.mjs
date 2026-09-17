// Loaded only by native DSH. Selected plugins retain their own Loader rows and export shapes.
import { watchFile, unwatchFile, readFileSync, writeFileSync, renameSync, lstatSync } from 'node:fs'
import { join } from 'node:path'

export const inject = ['loader', 'sessions', 'appReady']
export function apply(ctx, config) {
  const nonce = process.env.AGENT_MATRIX_DSH_PLUGIN_NONCE
  const directory = process.env.AGENT_MATRIX_DSH_PLUGIN_RECEIPTS
  if (!nonce || !directory) throw new Error('AgentMatrix DSH observation unavailable')
  let ready = false,
    failed = false
  const fibers = new Map()
  const entries = () =>
    config.rows.map((row) => {
      const matches = [...ctx.loader.entries()].filter((entry) => entry.options.id === row.id)
      const entry = matches.length === 1 ? matches[0] : undefined
      return { row, entry }
    })
  ctx.effect(() =>
    ctx.appReady.onReady(() => {
      for (const { row, entry } of entries()) {
        if (!entry?.fiber || entry.disabled || entry.fiber.state !== 2) failed = true
        else fibers.set(row.id, entry.fiber)
      }
      ready = true
    }),
  )
  ctx.on(
    'internal/status',
    (fiber) => {
      if (ready && [...fibers.values()].includes(fiber) && fiber.state !== 2) failed = true
    },
    { global: true },
  )
  const respond = () => {
    try {
      const path = join(directory, 'request.json')
      const stat = lstatSync(path)
      if (!stat.isFile() || stat.size > 4096) return
      const request = JSON.parse(readFileSync(path, 'utf8'))
      if (
        request.nonce !== nonce ||
        !/^[a-f0-9-]{36}$/.test(request.challenge) ||
        !(request.sessionId === null || /^[a-f0-9-]{36}$/.test(request.sessionId))
      )
        return
      const selected = entries()
      const healthy =
        ready &&
        !failed &&
        ctx.fiber.state === 2 &&
        ctx.root.fiber.state === 2 &&
        selected.every(
          ({ row, entry }) =>
            entry &&
            !entry.disabled &&
            entry.fiber === fibers.get(row.id) &&
            entry.fiber.state === 2 &&
            entry.options.name === row.name &&
            JSON.stringify(entry.options.config ?? {}) === JSON.stringify(row.config),
        )
      if (ready && !healthy) failed = true
      const session = request.sessionId === null ? null : ctx.sessions.get(request.sessionId)
      const receipt = {
        nonce,
        challenge: request.challenge,
        pid: process.pid,
        identity: config.identity,
        cwd: process.cwd(),
        ready,
        healthy,
        session: session ? { id: session.id, cwd: session.header.cwd } : null,
        plugins: selected.map(({ row, entry }) => ({ id: row.id, uid: entry?.fiber?.uid ?? null })),
      }
      const file = join(directory, `${request.challenge}.json`)
      writeFileSync(`${file}.tmp`, JSON.stringify(receipt), { mode: 0o600 })
      renameSync(`${file}.tmp`, file)
    } catch {
      failed = true
    }
  }
  ctx.effect(() => {
    // Stat polling also works when native directory event watchers are unavailable.
    const requestPath = join(directory, 'request.json')
    const changed = (current) => {
      if (current.nlink) respond()
    }
    watchFile(requestPath, { interval: 50 }, changed)
    // Catch a request created before the observer started watching.
    try {
      if (lstatSync(join(directory, 'request.json')).isFile()) respond()
    } catch {
      /* no request yet */
    }
    return () => unwatchFile(requestPath, changed)
  })
}
