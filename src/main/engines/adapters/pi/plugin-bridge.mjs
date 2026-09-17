// Executed by Pi's native jiti loader, never imported into Electron.
import { randomUUID } from 'node:crypto'
import { writeFileSync, renameSync } from 'node:fs'
import { join } from 'node:path'

export async function activate(factory, api, binding) {
  const nonce = process.env.AGENT_MATRIX_PI_PLUGIN_NONCE
  const directory = process.env.AGENT_MATRIX_PI_PLUGIN_RECEIPTS
  if (!nonce || !directory || typeof factory !== 'function')
    throw new Error('AgentMatrix Pi extension contract failed')
  const state = {
    nonce,
    pid: process.pid,
    token: randomUUID(),
    identity: binding.identity,
    entry: binding.entry,
    initialized: false,
    failed: false,
    session: null,
    handled: 0,
  }
  const save = () => {
    const file = join(directory, `${state.token}.json`)
    writeFileSync(`${file}.tmp`, JSON.stringify(state), { mode: 0o600 })
    renameSync(`${file}.tmp`, file)
  }
  const sessionIdentity = (ctx) => ({
    id: ctx.sessionManager.getSessionId(),
    file: ctx.sessionManager.getSessionFile(),
    cwd: ctx.cwd,
  })
  api.on('session_start', (_event, ctx) => {
    state.session = { ...sessionIdentity(ctx), ready: false, shutdown: false }
    save()
  })
  api.on('session_shutdown', () => {
    if (state.session) {
      state.session.shutdown = true
      save()
    }
  })
  // Keep native event order, receiver and return values, including resource discovery results.
  const on = (event, handler) =>
    api.on(event, async (...args) => {
      try {
        const result = await Reflect.apply(handler, undefined, args)
        if (event === 'input' && result?.action === 'handled') {
          state.handled++
          save()
        }
        return result
      } catch (error) {
        state.failed = true
        save()
        throw error
      }
    })
  const registerCommand = (name, options) => {
    if (name.startsWith('agentmatrix-witness-')) throw new Error('Reserved AgentMatrix command')
    api.registerCommand(name, {
      ...options,
      async handler(...args) {
        try {
          const result = await Reflect.apply(options.handler, this, args)
          state.handled++
          save()
          return result
        } catch (error) {
          state.failed = true
          save()
          throw error
        }
      },
    })
  }
  const projected = new Proxy(api, {
    get(target, key, receiver) {
      if (key === 'on') return on
      if (key === 'registerCommand') return registerCommand
      return Reflect.get(target, key, receiver)
    },
  })
  try {
    await factory(projected)
    state.initialized = true
    save()
    api.on('session_start', (_event, ctx) => {
      const current = sessionIdentity(ctx)
      if (
        !state.session ||
        current.id !== state.session.id ||
        current.file !== state.session.file ||
        current.cwd !== state.session.cwd
      )
        throw new Error('Extension session changed during startup')
      state.session.ready = true
      save()
    })
    api.registerCommand(binding.command, {
      description: `AgentMatrix extension instance ${nonce}:${state.token}`,
      handler() {
        throw new Error('AgentMatrix inspection command cannot be invoked')
      },
    })
  } catch (error) {
    state.failed = true
    save()
    throw error
  }
}
