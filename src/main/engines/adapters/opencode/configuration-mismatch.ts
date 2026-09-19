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

/** In-memory traversal only. Callers must persist only the fixed field groups, never paths or values. */
export function openCodeMismatches(expected: unknown, actual: unknown) {
  const mismatches: { path: string[]; actual: unknown; fields: ConfigurationField[] }[] = []
  const classify = (path: string[], actual: unknown) => {
    const fields = new Set<ConfigurationField>()
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
    mismatches.push({
      path,
      actual,
      fields: configurationFieldSchema.options.filter((field) => fields.has(field)),
    })
  }
  const visit = (wanted: unknown, found: unknown, path: string[]) => {
    if (wanted !== null && typeof wanted === 'object' && !Array.isArray(wanted)) {
      const object =
        found !== null && typeof found === 'object' && !Array.isArray(found)
          ? (found as Record<string, unknown>)
          : {}
      const entries = Object.entries(wanted)
      if (!entries.length && configurationMismatch(wanted, found, path.join('.')) !== null)
        classify(path, found)
      for (const [key, value] of entries) visit(value, object[key], [...path, key])
    } else if (configurationMismatch(wanted, found, path.join('.')) !== null) classify(path, found)
  }
  visit(expected, actual, [])
  return mismatches
}

export function openCodeMismatchFields(expected: unknown, actual: unknown): ConfigurationField[] {
  const fields = new Set(openCodeMismatches(expected, actual).flatMap((entry) => entry.fields))
  return configurationFieldSchema.options.filter((field) => fields.has(field))
}
