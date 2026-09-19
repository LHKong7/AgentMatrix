export type PiSecretValue =
  | { kind: 'literal'; value: string }
  | { kind: 'environment'; name: string }
  | { kind: 'unresolved' }

/** Parse Pi's templates as data. No environment access or command execution. */
export function parsePiSecretValue(input: string): PiSecretValue {
  if (input.startsWith('!')) return { kind: 'unresolved' }
  const parts: { kind: 'literal' | 'environment'; value: string }[] = []
  const append = (value: string) => {
    if (!value) return
    const previous = parts.at(-1)
    if (previous?.kind === 'literal') previous.value += value
    else parts.push({ kind: 'literal', value })
  }
  for (let index = 0; index < input.length;) {
    const char = input[index]!
    if (char !== '$') {
      append(char)
      index++
      continue
    }
    const next = input[index + 1]
    if (next === '$' || next === '!') {
      append(next)
      index += 2
      continue
    }
    if (next === '{') {
      const end = input.indexOf('}', index + 2)
      if (end >= 0) {
        const name = input.slice(index + 2, end)
        if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) parts.push({ kind: 'environment', value: name })
        else append(input.slice(index, end + 1))
        index = end + 1
        continue
      }
    } else {
      const name = /^[A-Za-z_][A-Za-z0-9_]*/.exec(input.slice(index + 1))?.[0]
      if (name) {
        parts.push({ kind: 'environment', value: name })
        index += name.length + 1
        continue
      }
    }
    append('$')
    index++
  }
  if (parts.length === 1 && parts[0]!.kind === 'environment')
    return { kind: 'environment', name: parts[0]!.value }
  if (parts.some((part) => part.kind === 'environment')) return { kind: 'unresolved' }
  return { kind: 'literal', value: parts.map((part) => part.value).join('') }
}
