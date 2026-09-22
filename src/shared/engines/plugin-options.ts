import { z } from 'zod'

type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue }
export type PluginConfiguration = { [key: string]: JsonValue }

/** Bound plain configuration and exclude the native Loader's executable-expression sentinel. */
export const pluginConfigurationSchema = z
  .custom<PluginConfiguration>((input) => {
    let count = 0
    const seen = new Set<object>()
    const visit = (value: unknown, depth: number): boolean => {
      if (++count > 4096 || depth > 12) return false
      if (value === null || typeof value === 'boolean') return true
      if (typeof value === 'number') return Number.isFinite(value)
      if (typeof value === 'string') return value.length <= 16_384
      if (typeof value !== 'object' || seen.has(value)) return false
      seen.add(value)
      if (Array.isArray(value)) return value.every((item) => visit(item, depth + 1))
      if (![Object.prototype, null].includes(Object.getPrototypeOf(value))) return false
      return Object.entries(Object.getOwnPropertyDescriptors(value)).every(
        ([key, descriptor]) =>
          key.length <= 200 &&
          !['__jsExpr', '__proto__', 'constructor', 'prototype'].includes(key) &&
          'value' in descriptor &&
          visit(descriptor.value, depth + 1),
      )
    }
    try {
      return (
        input !== null &&
        typeof input === 'object' &&
        !Array.isArray(input) &&
        visit(input, 0) &&
        new TextEncoder().encode(JSON.stringify(input)).byteLength <= 65_536
      )
    } catch {
      return false
    }
  }, 'Invalid or oversized plugin configuration')
  .transform((value) => structuredClone(value))
