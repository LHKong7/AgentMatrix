// Loaded inside the captured DSH ACP process; Electron never imports native engine code.
import { watchFile, unwatchFile, readFileSync, writeFileSync, renameSync, lstatSync } from 'node:fs'
import { join } from 'node:path'

export const inject = ['skills', 'agents', 'sessions', 'appReady']
export function apply(ctx, config) {
  const nonce = process.env.AGENT_MATRIX_DSH_SKILL_NONCE
  const directory = process.env.AGENT_MATRIX_DSH_SKILL_RECEIPTS
  if (!nonce || !directory) throw new Error('AgentMatrix DSH Skill observation unavailable')
  const disposed = new AbortController()
  let ready = false,
    revision = 0,
    lastChallenge = null,
    queue = Promise.resolve()
  ctx.effect(() =>
    ctx.appReady.onReady(() => {
      ready = true
    }),
  )
  ctx.on(
    'skills/change',
    () => {
      revision++
    },
    { global: true },
  )
  const respond = async () => {
    try {
      const requestPath = join(directory, 'request.json')
      const stat = lstatSync(requestPath)
      if (!stat.isFile() || stat.size > 4096) return
      const request = JSON.parse(readFileSync(requestPath, 'utf8'))
      if (
        request.nonce !== nonce ||
        !/^[a-f0-9-]{36}$/.test(request.challenge) ||
        !/^[a-f0-9-]{36}$/.test(request.sessionId) ||
        request.challenge === lastChallenge
      )
        return
      lastChallenge = request.challenge
      const agent = ctx.agents.get(request.sessionId)
      const session = ctx.sessions.get(request.sessionId)
      let sources = null
      if (
        ready &&
        ctx.fiber.state === 2 &&
        ctx.root.fiber.state === 2 &&
        agent &&
        agent.session === session &&
        session.header.cwd === process.cwd()
      ) {
        try {
          const before = revision
          const lookup = {
            cwd: session.header.cwd,
            scope: agent,
            signal: AbortSignal.any([disposed.signal, AbortSignal.timeout(10000)]),
          }
          const catalog = await ctx.skills.snapshot(lookup)
          if (!catalog.complete || catalog.skills.length > 10000)
            throw new Error('Incomplete catalog')
          const selected = []
          for (const name of config.names) {
            const summary = catalog.skills.filter((skill) => skill.name === name)
            const skill = summary.length === 1 ? await ctx.skills.get(name, lookup) : undefined
            if (
              skill &&
              (skill.name !== name ||
                typeof skill.path !== 'string' ||
                skill.path.length > 4000 ||
                typeof skill.provider !== 'string' ||
                skill.provider.length > 1000 ||
                typeof skill.source !== 'string' ||
                skill.source.length > 1000)
            )
              throw new Error('Invalid source')
            selected.push({
              name,
              path: skill?.path ?? '',
              provider: skill?.provider ?? '',
              source: skill?.source ?? '',
            })
          }
          if (
            revision !== before ||
            ctx.agents.get(request.sessionId) !== agent ||
            ctx.sessions.get(request.sessionId) !== session ||
            ctx.fiber.state !== 2 ||
            ctx.root.fiber.state !== 2
          )
            throw new Error('Changed catalog')
          sources = selected
        } catch {
          /* Fixed unavailable evidence; native errors and bodies never leave the process. */
        }
      }
      if (disposed.signal.aborted) return
      const receipt = {
        nonce,
        challenge: request.challenge,
        pid: process.pid,
        identity: config.identity,
        cwd: process.cwd(),
        ready,
        session: session ? { id: session.id, cwd: session.header.cwd } : null,
        sources,
      }
      const file = join(directory, `${request.challenge}.json`)
      writeFileSync(`${file}.tmp`, JSON.stringify(receipt), { mode: 0o600 })
      renameSync(`${file}.tmp`, file)
    } catch {
      /* The caller's bounded wait fails closed if the witness cannot respond. */
    }
  }
  ctx.effect(() => {
    const requestPath = join(directory, 'request.json')
    const changed = (current) => {
      if (current.nlink) queue = queue.then(respond).catch(() => {})
    }
    watchFile(requestPath, { interval: 50 }, changed)
    try {
      changed(lstatSync(requestPath))
    } catch {
      /* no request yet */
    }
    return () => {
      disposed.abort()
      unwatchFile(requestPath, changed)
    }
  })
}
