// Copied into captured inputs and imported only by the owned native OpenCode process.
import { randomUUID } from 'node:crypto'
import { writeFileSync, renameSync } from 'node:fs'
import { join } from 'node:path'

const contexts = new WeakMap()
const descriptions = new WeakMap()
const nonce = process.env.AGENT_MATRIX_PLUGIN_NONCE
const receiptDirectory = process.env.AGENT_MATRIX_PLUGIN_RECEIPTS
const enabled = Boolean(nonce && receiptDirectory)
const fail = () => {
  throw new Error('AgentMatrix plugin contract failed')
}
function context(input) {
  let value = contexts.get(input)
  if (!value) {
    value = {
      nonce,
      token: randomUUID(),
      pid: process.pid,
      cwd: input.directory,
      bindings: Object.create(null),
      sentinel: false,
      disposed: false,
    }
    contexts.set(input, value)
  }
  return value
}
function save(value) {
  const path = join(receiptDirectory, `${value.token}.json`)
  writeFileSync(`${path}.tmp`, JSON.stringify(value), { mode: 0o600 })
  renameSync(`${path}.tmp`, path)
}

// A facade avoids Proxy invariants on frozen hooks. Nested tool/auth objects retain identity.
// Methods invoked with the facade as receiver execute with their original receiver.
function facade(original, replacements) {
  const cached = new Map()
  let result
  result = new Proxy(
    {},
    {
      get(_target, key) {
        if (Object.hasOwn(replacements, key)) return replacements[key]
        const value = Reflect.get(original, key, original)
        if (typeof value !== 'function') return value
        if (!cached.has(value))
          cached.set(value, function (...args) {
            return Reflect.apply(value, this === result ? original : this, args)
          })
        return cached.get(value)
      },
      has: (_target, key) => Object.hasOwn(replacements, key) || Reflect.has(original, key),
      ownKeys: () => [...new Set([...Reflect.ownKeys(original), ...Reflect.ownKeys(replacements)])],
      getOwnPropertyDescriptor: (_target, key) =>
        Object.hasOwn(replacements, key) || Reflect.has(original, key)
          ? { configurable: true, enumerable: true, writable: true, value: result[key] }
          : undefined,
      getPrototypeOf: () => Reflect.getPrototypeOf(original),
      set: (_target, key, value) => Reflect.set(original, key, value, original),
    },
  )
  return result
}

export function bind(module, binding) {
  if (JSON.stringify(Object.keys(module).sort()) !== JSON.stringify(binding.exports)) fail()
  const primary = module.default
  const isV1 =
    primary &&
    typeof primary === 'object' &&
    !Array.isArray(primary) &&
    ['id', 'server', 'tui'].some((key) => key in primary)
  if (
    isV1 &&
    (typeof primary.id !== 'string' ||
      primary.id.trim() !== binding.nativeId ||
      typeof primary.server !== 'function' ||
      primary.tui !== undefined)
  )
    fail()
  const values = isV1 ? [primary] : [...new Set(Object.values(module))]
  if (
    !values.length ||
    values.some(
      (value) =>
        typeof value !== 'function' &&
        (!value || typeof value !== 'object' || typeof value.server !== 'function'),
    )
  )
    fail()
  // Debug config has its own process. It cannot write receipts for an ACP attachment.
  if (!enabled) return module
  const projected = new Map()
  values.forEach((value, index) => {
    const initialize = typeof value === 'function' ? value : value.server
    const wrapped = async function (input, ...args) {
      const state = context(input)
      const status = (state.bindings[binding.id] ??= {
        identity: binding.identity,
        initializers: values.map(() => ({
          initialized: false,
          configured: false,
          failed: false,
          disposed: false,
        })),
      })
      const item = status.initializers[index]
      if (item.initialized || item.failed) {
        item.failed = true
        save(state)
        fail()
      }
      try {
        const hooks = await Reflect.apply(initialize, isV1 ? value : undefined, [input, ...args])
        if (!hooks || typeof hooks !== 'object') fail()
        item.initialized = true
        save(state)
        return facade(hooks, {
          async config(...parameters) {
            try {
              await hooks.config?.(...parameters)
              item.configured = true
              save(state)
            } catch (error) {
              item.failed = true
              save(state)
              throw error
            }
          },
          async dispose(...parameters) {
            item.disposed = true
            save(state)
            return hooks.dispose?.(...parameters)
          },
        })
      } catch (error) {
        item.failed = true
        save(state)
        throw error
      }
    }
    projected.set(value, typeof value === 'function' ? wrapped : facade(value, { server: wrapped }))
  })
  return Object.fromEntries(
    Object.entries(module).map(([key, value]) => [key, projected.get(value) ?? value]),
  )
}

export function sentinel(input, agentName) {
  if (!enabled) return {}
  const state = context(input)
  return {
    config(config) {
      const agent = config.agent?.[agentName]
      if (!agent || (agent.description !== undefined && typeof agent.description !== 'string'))
        fail()
      const marker = `[AgentMatrix plugin instance ${nonce}:${state.token}]`
      const previous = descriptions.get(agent)
      const description = agent.description ?? ''
      const original =
        previous && description.endsWith(previous)
          ? description.slice(0, -previous.length)
          : description
      const suffix = `\n${marker}`
      agent.description = original + suffix
      descriptions.set(agent, suffix)
      state.sentinel = true
      save(state)
    },
    dispose() {
      state.disposed = true
      save(state)
    },
  }
}
