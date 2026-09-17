import { execFile } from 'node:child_process'
import { access, mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { constants } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, isAbsolute, join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { startProbe } from './lib/stdio-probe.mjs'

const exec = promisify(execFile)
const options = Object.fromEntries(
  process.argv.slice(2).map((value) => {
    const match = /^--(opencode|pi|dsh|output)=(.+)$/.exec(value)
    if (!match) throw new Error('Use --opencode=PATH --pi=PATH --dsh=PATH --output=FILE')
    return [match[1], match[2]]
  }),
)
async function locate(name) {
  const candidates = isAbsolute(name)
    ? [name]
    : (process.env.PATH ?? '')
        .split(delimiter)
        .filter(Boolean)
        .map((path) => join(path, name))
  for (const candidate of candidates) {
    try {
      await access(candidate, constants.X_OK)
      return await realpath(candidate)
    } catch {
      /* Try the next PATH entry. */
    }
  }
  return null
}
const root = await mkdtemp(join(tmpdir(), 'agentmatrix-engine-probe-'))
const environment = {}
for (const key of [
  'HOME',
  'USERPROFILE',
  'SYSTEMROOT',
  'WINDIR',
  'PATH',
  'TMPDIR',
  'TEMP',
  'TMP',
]) {
  if (process.env[key]) environment[key] = process.env[key]
}
environment.LANG = 'en_US.UTF-8'
const report = {
  checkedAt: new Date().toISOString(),
  platform: process.platform,
  architecture: process.arch,
  node: process.version,
  modelCalls: false,
  engines: {},
}
try {
  for (const kind of ['opencode', 'pi', 'dsh']) {
    const executable = await locate(options[kind] ?? kind)
    if (!executable) {
      report.engines[kind] = { status: 'missing' }
      continue
    }
    const cwd = join(root, kind)
    await mkdir(cwd, { recursive: true })
    const env = { ...environment }
    for (const key of ['XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_STATE_HOME', 'XDG_CACHE_HOME']) {
      env[key] = join(cwd, key)
      await mkdir(env[key], { recursive: true })
    }
    Object.assign(env, {
      OPENCODE_DISABLE_AUTOUPDATE: 'true',
      OPENCODE_DISABLE_MODELS_FETCH: 'true',
      OPENCODE_DISABLE_DEFAULT_PLUGINS: 'true',
      OPENCODE_DISABLE_CLAUDE_CODE: 'true',
      OPENCODE_CONFIG_CONTENT: JSON.stringify({
        autoupdate: false,
        share: 'disabled',
        enabled_providers: [],
        permission: 'deny',
      }),
      PI_CODING_AGENT_DIR: join(cwd, 'pi-config'),
      PI_OFFLINE: 'true',
      PI_TELEMETRY: 'false',
      DSH_HOME: join(cwd, 'dsh-home'),
    })
    const result = { executable, version: null, checks: {} }
    report.engines[kind] = result
    try {
      result.version = (
        await exec(executable, ['--version'], { cwd, env, timeout: 15_000, maxBuffer: 100_000 })
      ).stdout.trim()
    } catch (error) {
      result.error = error.message
      continue
    }
    const modes = kind === 'dsh' ? ['sdk', 'acp'] : [kind]
    for (const mode of modes) {
      const args =
        kind === 'opencode'
          ? ['acp', '--pure', '--cwd', cwd]
          : kind === 'pi'
            ? [
                '--mode',
                'rpc',
                '--no-session',
                '--no-extensions',
                '--no-skills',
                '--no-prompt-templates',
                '--no-approve',
              ]
            : ['--profile', mode]
      const probe = startProbe(executable, args, { cwd, env })
      const check = { args, responses: [] }
      result.checks[mode] = check
      try {
        if (kind === 'pi') {
          for (const type of ['get_state', 'new_session', 'abort'])
            check.responses.push(await probe.request({ type }))
        } else if (mode === 'sdk') {
          check.responses.push(
            await probe.request({
              jsonrpc: '2.0',
              method: 'initialize',
              params: { cwd, provider: 'deepseek-official', model: 'deepseek-chat' },
            }),
          )
          for (const method of ['session/cancel', 'session/resume']) {
            check.responses.push(
              await probe.request({
                jsonrpc: '2.0',
                method,
                params: { sessionId: 'nonexistent-probe-session' },
              }),
            )
          }
          check.responses.push(
            await probe.request({ jsonrpc: '2.0', method: 'shutdown', params: {} }),
          )
        } else {
          check.responses.push(
            await probe.request({
              jsonrpc: '2.0',
              method: 'initialize',
              params: {
                protocolVersion: 1,
                clientCapabilities: {},
                clientInfo: { name: 'agentmatrix-probe', version: '0.1.0' },
              },
            }),
          )
        }
      } catch (error) {
        check.error = error.message
      } finally {
        check.exit = await probe.stop()
      }
    }
  }
} finally {
  await rm(root, { recursive: true, force: true })
}
// Temporary paths are diagnostic only, not reusable installation/session references.
const output = JSON.stringify(report, null, 2).split(root).join('<isolated-probe-root>') + '\n'
if (options.output) await writeFile(resolve(options.output), output, { mode: 0o600 })
console.log(output)
