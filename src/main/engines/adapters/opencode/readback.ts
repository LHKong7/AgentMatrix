import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { RunInputManifest, RunPaths } from '../../../../shared/engines/run-inputs'
import type { ProcessLaunch } from '../../process/managed-process'
import { captureCommand } from '../../process/capture-command'
import { RuntimeFailure } from '../../runtime'
import {
  configurationFieldSchema,
  type ConfigurationField,
} from '../../../../shared/engines/configuration-report'

/** Native parsing may add defaults, but cannot change values explicitly requested by this plan. */
export function configurationMismatch(
  expected: unknown,
  actual: unknown,
  path = '',
): string | null {
  if (path.startsWith('agent.') && path.endsWith('.permission') && typeof expected === 'string') {
    if (actual === expected) return null
    if (actual && typeof actual === 'object' && !Array.isArray(actual)) {
      const rules = actual as Record<string, unknown>
      if (rules['*'] === expected && Object.values(rules).every((value) => value === expected))
        return null
    }
    return path
  }
  if (Array.isArray(expected)) {
    if (!Array.isArray(actual)) return path
    if (path === 'instructions') {
      let index = 0
      for (const item of actual) if (index < expected.length && item === expected[index]) index++
      return index === expected.length ? null : path
    }
    return JSON.stringify(expected) === JSON.stringify(actual) ? null : path
  }
  if (expected !== null && typeof expected === 'object') {
    if (!actual || typeof actual !== 'object' || Array.isArray(actual)) return path
    for (const [key, value] of Object.entries(expected)) {
      const mismatch = configurationMismatch(
        value,
        (actual as Record<string, unknown>)[key],
        path ? `${path}.${key}` : key,
      )
      if (mismatch !== null) return mismatch
    }
    return null
  }
  return expected === actual ? null : path
}

/** Classify requested mismatches in memory. Dynamic provider/agent/header names never leave this function. */
export function openCodeMismatchFields(expected: unknown, actual: unknown): ConfigurationField[] {
  const fields = new Set<ConfigurationField>()
  const classify = (path: string[]) => {
    const [root, , leaf, option] = path
    const add = (...values: ConfigurationField[]) => values.forEach((value) => fields.add(value))
    if (root === 'provider') {
      if (leaf === 'models') add(path.at(-1) === 'temperature' ? 'sampling' : 'model')
      else if (leaf === 'options' && option === 'apiKey') add('authentication')
      else if (leaf === 'options' && option === 'headers') add('connection', 'authentication')
      else add('connection')
    } else if (root === 'agent') {
      if (leaf === 'prompt') add('prompts')
      else if (leaf === 'permission') add('execution')
      else if (leaf === 'temperature' || leaf === 'top_p') add('sampling')
      else add('engine-options')
    } else if (root === 'model' || root === 'small_model') add('model')
    else if (root === 'instructions') add('prompts')
    else if (root === 'skills') add('skills')
    else if (root === 'mcp') add('mcp')
    else if (root === 'plugin') add('plugins')
    else add('engine-options')
  }
  const visit = (wanted: unknown, found: unknown, path: string[]) => {
    if (wanted !== null && typeof wanted === 'object' && !Array.isArray(wanted)) {
      const object =
        found !== null && typeof found === 'object' && !Array.isArray(found)
          ? (found as Record<string, unknown>)
          : {}
      const entries = Object.entries(wanted)
      if (!entries.length && configurationMismatch(wanted, found, path.join('.')) !== null)
        classify(path)
      for (const [key, value] of entries) visit(value, object[key], [...path, key])
    } else if (configurationMismatch(wanted, found, path.join('.')) !== null) classify(path)
  }
  visit(expected, actual, [])
  return configurationFieldSchema.options.filter((field) => fields.has(field))
}

/** Compare in memory only: native config readback can include plaintext credentials. */
export async function verifyOpenCodeReadback(
  manifest: RunInputManifest,
  paths: RunPaths,
  launch: ProcessLaunch,
  signal: AbortSignal,
): Promise<void> {
  const prefix = manifest.installation.prefixArgs
  const version = (
    await captureCommand({ ...launch, args: [...prefix, '--version'] }, signal)
  ).trim()
  if (version !== manifest.installation.version)
    throw new RuntimeFailure('configuration', 'installation.version', {
      check: 'installation',
      reason: 'mismatch',
      fields: ['installation'],
    })
  try {
    let text = await readFile(join(paths.inputs, 'opencode.json'), 'utf8')
    text = text.replace(/\{env:([^}]+)\}/g, (_match, name: string) => {
      if (!Object.hasOwn(launch.environment, name)) throw new RuntimeFailure('configuration')
      return launch.environment[name]!
    })
    // Expand only known copied Prompt references; native/user files cannot be read here.
    for (const match of [...text.matchAll(/\{file:([^}]+)\}/g)]) {
      const path = match[1]!.replace(/^\.\//, '')
      if (!manifest.prompts.some((prompt) => prompt.path === path))
        throw new RuntimeFailure('configuration')
      const value = (await readFile(join(paths.inputs, path), 'utf8')).trim()
      text = text.replace(match[0], () => JSON.stringify(value).slice(1, -1))
    }
    const expected: unknown = JSON.parse(text)
    const actual: unknown = JSON.parse(
      await captureCommand({ ...launch, args: [...prefix, 'debug', 'config'] }, signal),
    )
    // The path is intentionally not copied from untrusted native objects into diagnostics.
    if (configurationMismatch(expected, actual) !== null)
      throw new RuntimeFailure('configuration', 'native.override', {
        check: 'opencode-config',
        reason: 'mismatch',
        fields: openCodeMismatchFields(expected, actual),
      })
  } catch (error) {
    if (error instanceof RuntimeFailure) throw error
    throw new RuntimeFailure('configuration', 'native.readback', {
      check: 'opencode-config',
      reason: 'unavailable',
      fields: [],
    })
  }
}
