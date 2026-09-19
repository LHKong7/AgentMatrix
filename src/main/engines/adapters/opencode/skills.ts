import { createHash, randomBytes } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { join } from 'node:path'
import { z } from 'zod'
import type {
  GeneratedInputs,
  RunInputManifest,
  RunPaths,
} from '../../../../shared/engines/run-inputs'
import { capturedSkillSources, skillSourcesMatch } from '../../skill-readback'
import { RuntimeFailure } from '../../runtime'

export const openCodeSkillPlanPath = 'observers/opencode-skills.json'
const identityOf = (names: string[], agentName: string) =>
  createHash('sha256').update(JSON.stringify({ names, agentName })).digest('hex')
const planSchema = z
  .object({
    identity: z.string(),
    names: z.array(z.string()).min(1).max(1000),
    agentName: z.string(),
  })
  .strict()

export function planOpenCodeSkillObservation(
  names: string[],
  agentName: string,
  generated: GeneratedInputs,
): void {
  if (!names.length) return
  generated.files.push({
    path: openCodeSkillPlanPath,
    content: JSON.stringify({ identity: identityOf(names, agentName), names, agentName }) + '\n',
  })
}

/** Reserve a candidate loopback port. A subsequent bind collision fails native ACP startup. */
async function loopbackPort(): Promise<number> {
  const server = createServer()
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      server.close((error) => {
        if (error) return reject(error)
        if (!address || typeof address === 'string')
          return reject(new Error('Missing listener address'))
        resolve(address.port)
      })
    })
  })
}

/** ACP and this observer use the same owned native HTTP server and directory-scoped Skill service. */
export async function prepareOpenCodeSkillAttachment(manifest: RunInputManifest, paths: RunPaths) {
  const fail = (reason: 'mismatch' | 'unavailable' = 'unavailable'): never => {
    throw new RuntimeFailure('configuration', 'native.instance-skills', {
      check: 'opencode-instance-skills',
      reason,
      fields: ['skills'],
    })
  }
  let expected: Awaited<ReturnType<typeof capturedSkillSources>>, port: number
  try {
    expected = await capturedSkillSources(manifest, paths, 'opencode-mappings.json')
    const plan = planSchema.parse(
      JSON.parse(await readFile(join(paths.inputs, openCodeSkillPlanPath), 'utf8')),
    )
    const names = expected.map((skill) => skill.name)
    const agentName =
      manifest.agent.engineOptions?.kind === 'opencode'
        ? manifest.agent.engineOptions.agent
        : 'build'
    if (
      plan.identity !== identityOf(names, agentName) ||
      plan.agentName !== agentName ||
      JSON.stringify(plan.names) !== JSON.stringify(names)
    )
      return fail()
    port = await loopbackPort()
  } catch {
    return fail()
  }
  const password = randomBytes(32).toString('hex')
  const encoded = Buffer.from(`opencode:${password}`).toString('base64'),
    authorization = `Basic ${encoded}`
  const disposed = new AbortController()
  async function readNative(path: string, signal: AbortSignal): Promise<unknown> {
    const url = new URL(path, `http://127.0.0.1:${port}`)
    url.searchParams.set('directory', manifest.cwd)
    const response = await fetch(url, {
      headers: { Authorization: authorization },
      redirect: 'error',
      signal,
    })
    if (!response.ok || !response.body) {
      await response.body?.cancel()
      return fail()
    }
    const reader = response.body.getReader(),
      chunks: Uint8Array[] = []
    let size = 0
    try {
      for (;;) {
        const part = await reader.read()
        if (part.done) break
        size += part.value.byteLength
        if (size > 4_194_304) return fail()
        chunks.push(part.value)
      }
      return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)))
    } finally {
      await reader.cancel().catch(() => {})
      reader.releaseLock()
    }
  }
  const sessionSchema = z.object({ id: z.string().min(1).max(1000), directory: z.string() })
  const sourcesSchema = z
    .array(z.object({ name: z.string().max(1000), location: z.string().max(4000) }))
    .max(10000)
  return {
    args: ['--hostname', '127.0.0.1', '--port', String(port)],
    environment: { OPENCODE_SERVER_USERNAME: 'opencode', OPENCODE_SERVER_PASSWORD: password },
    secrets: [password, encoded, authorization],
    async verify(pid: number | undefined, signal: AbortSignal, sessionId: string) {
      try {
        if (!pid || !sessionId || sessionId.length > 1000) return fail()
        const lifetime = AbortSignal.any([signal, disposed.signal, AbortSignal.timeout(10000)])
        lifetime.throwIfAborted()
        const sessionPath = `/session/${encodeURIComponent(sessionId)}`
        const checkSession = async () => {
          const session = sessionSchema.parse(await readNative(sessionPath, lifetime))
          if (session.id !== sessionId || session.directory !== manifest.cwd) return fail()
        }
        await checkSession()
        const sources = sourcesSchema.parse(await readNative('/skill', lifetime))
        await checkSession()
        lifetime.throwIfAborted()
        if (
          !skillSourcesMatch(
            expected,
            sources.map((skill) => ({ name: skill.name, path: skill.location })),
            false,
          )
        )
          return fail('mismatch')
      } catch (error) {
        if (signal.aborted || disposed.signal.aborted) throw new RuntimeFailure('process-exit')
        if (error instanceof RuntimeFailure) throw error
        return fail()
      }
    },
    cleanup: async () => {
      disposed.abort()
    },
  }
}
