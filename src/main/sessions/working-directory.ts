import { realpath, stat } from 'node:fs/promises'
import { isAbsolute } from 'node:path'
import { absolutePath } from '../../shared/engines/schema'
import { appError } from '../../shared/errors'

/** Validate on the host before inspecting native configuration or invoking a CLI. */
export async function resolveWorkingDirectory(input: unknown): Promise<string> {
  const parsed = absolutePath.safeParse(input)
  if (!parsed.success || !isAbsolute(parsed.data)) throw appError('error.runtimeCwd')
  try {
    const directory = await realpath(parsed.data)
    if (!(await stat(directory)).isDirectory()) throw appError('error.runtimeCwd')
    return directory
  } catch {
    throw appError('error.runtimeCwd')
  }
}
