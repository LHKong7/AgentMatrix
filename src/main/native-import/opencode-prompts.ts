import type { OpenCodePromptReference } from '../../shared/engines/native-import'
import { childPointer, isObject, type JsonObject } from './jsonc'

/** List supported fields without resolving a path, expanding a macro, or reading another file. */
export function openCodePromptReferences(data: JsonObject): OpenCodePromptReference[] {
  const entries: OpenCodePromptReference[] = []
  if (isObject(data.agent))
    for (const [name, agent] of Object.entries(data.agent))
      if (
        isObject(agent) &&
        typeof agent.prompt === 'string' &&
        /^\{file:[^}]+\}$/.test(agent.prompt) &&
        agent.prompt.length <= 4000
      )
        entries.push({
          path: `${childPointer('/agent', name)}/prompt`,
          reference: agent.prompt,
          mode: 'replace',
        })
  if (Array.isArray(data.instructions))
    for (const [index, value] of data.instructions.entries())
      if (
        typeof value === 'string' &&
        value.trim() &&
        value.length <= 4000 &&
        !/\{(?:file|env):|^https?:\/\//.test(value)
      )
        entries.push({ path: `/instructions/${index}`, reference: value, mode: 'append' })
  return entries
}
