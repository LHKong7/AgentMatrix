import { previewLibraryImpact } from '../engines/library-impact'
import type { LibraryImpactQuery } from '../../shared/engines/impact'
import { createHash } from 'node:crypto'
import { lstat, mkdir, mkdtemp, readFile, realpath, rm } from 'node:fs/promises'
import { homedir, userInfo } from 'node:os'
import { join } from 'node:path'
import { z } from 'zod'
import { entityId, type SecretReference } from '../../shared/engines/schema'
import type { EngineWorkspace } from '../../shared/engines/workspace'
import type { SessionCommand, SessionSnapshot } from '../../shared/sessions/schema'
import { appError, getErrorKey } from '../../shared/errors'
import type { SkillDirectoryStore } from '../assets/skill-directory-store'
import { RunInputStore } from '../engines/run-input-store'
import { planOpenCode, openCodeContract } from '../engines/adapters/opencode/configuration'
import {
  inspectOpenCodeSources,
  type OpenCodeNativeLocations,
} from '../engines/adapters/opencode/sources'
import { connectOpenCode } from '../engines/adapters/opencode/runtime'
import { planPi, piContract } from '../engines/adapters/pi/configuration'
import { inspectPiSources } from '../engines/adapters/pi/sources'
import { connectPi } from '../engines/adapters/pi/runtime'
import { dshContract, inspectDshComposition } from '../engines/adapters/dsh/composition'
import { planDsh } from '../engines/adapters/dsh/configuration'
import { connectDsh } from '../engines/adapters/dsh/runtime'
import type { ResolvedSkill } from '../../shared/engines/resolution'
import { baseProcessEnvironment } from '../engines/process/managed-process'
import { captureCommand } from '../engines/process/capture-command'
import { RuntimeFailure } from '../engines/runtime'
import type { SessionRuntimeFactory } from './coordinator'
import { buildConfigurationReport } from '../engines/configuration-report'

interface Dependencies {
  workspace: {
    load(): Promise<EngineWorkspace>
    save(value: EngineWorkspace): Promise<EngineWorkspace>
  }
  runs: RunInputStore
  skills: SkillDirectoryStore
  resolveSecret(reference: SecretReference): Promise<string>
  dataDirectory: string
  environment: NodeJS.ProcessEnv
}
export function openCodeNativeLocations(environment: NodeJS.ProcessEnv): OpenCodeNativeLocations {
  const home = environment.HOME || homedir()
  const locations: OpenCodeNativeLocations = {
    home,
    configHome: environment.XDG_CONFIG_HOME || join(home, '.config'),
    managedDirectory:
      process.platform === 'darwin' ? '/Library/Application Support/opencode' : '/etc/opencode',
  }
  if (process.platform === 'darwin') {
    let user = 'user'
    try {
      user = userInfo().username || user
    } catch {
      /* Match the native fallback. */
    }
    locations.managedPreferences = [
      join('/Library/Managed Preferences', user, 'ai.opencode.managed.plist'),
      '/Library/Managed Preferences/ai.opencode.managed.plist',
    ]
  }
  return locations
}

/** Renderer input selects saved definitions; it never supplies executable arguments or credentials. */
export class DesktopSessionFactory implements SessionRuntimeFactory {
  private readonly lifetime = new AbortController()
  private readonly probes = new Set<Promise<unknown>>()
  constructor(private readonly dependencies: Dependencies) {}

  probe(input: unknown): Promise<EngineWorkspace> {
    const { installationId } = z.object({ installationId: entityId }).strict().parse(input)
    if (this.lifetime.signal.aborted) return Promise.reject(appError('error.sessionStopping'))
    const task = this.checkInstallation(installationId)
    this.probes.add(task)
    void task.finally(() => this.probes.delete(task)).catch(() => {})
    return task
  }
  private async checkInstallation(installationId: string): Promise<EngineWorkspace> {
    const { workspace, dataDirectory, environment } = this.dependencies
    const state = await workspace.load()
    const installation = state.installations.find((item) => item.id === installationId)
    if (
      !installation ||
      !['opencode', 'pi', 'deepseek-harness'].includes(installation.kind) ||
      installation.platform !== process.platform ||
      !['darwin', 'linux'].includes(process.platform)
    )
      throw appError('error.runtimeUnsupported')
    const parent = join(dataDirectory, 'probes')
    await mkdir(parent, { recursive: true, mode: 0o700 })
    const root = await mkdtemp(join(parent, `${installation.kind}-`))
    try {
      const version = (
        await captureCommand(
          {
            executable: installation.executable,
            args: [...installation.prefixArgs, '--version'],
            cwd: root,
            environment: {
              ...baseProcessEnvironment(environment),
              XDG_CONFIG_HOME: join(root, 'config'),
              XDG_DATA_HOME: join(root, 'data'),
              XDG_CACHE_HOME: join(root, 'cache'),
              XDG_STATE_HOME: join(root, 'state'),
              OPENCODE_DISABLE_AUTOUPDATE: 'true',
              PI_CODING_AGENT_DIR: join(root, 'pi'),
              DSH_HOME: join(root, 'dsh'),
              DSH_TELEMETRY_DISABLED: '1',
            },
          },
          this.lifetime.signal,
        )
      ).trim()
      if (!/^[0-9][0-9A-Za-z.+-]{0,99}$/.test(version)) throw appError('error.runtimeProbe')
      installation.version = version
      installation.probedAt = new Date().toISOString()
      installation.modes =
        installation.kind === 'opencode'
          ? version === openCodeContract.engineVersion
            ? ['acp']
            : []
          : installation.kind === 'pi'
            ? version === piContract.engineVersion
              ? ['pi-rpc']
              : []
            : version === dshContract.engineVersion
              ? ['acp']
              : []
      // Optimistic workspace revision prevents overwriting edits made during the probe.
      return await workspace.save(state)
    } catch (error) {
      if (getErrorKey(error)) throw error
      throw appError('error.runtimeProbe')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  }

  async create(sessionId: string, command: Extract<SessionCommand, { kind: 'create' }>) {
    if (this.lifetime.signal.aborted) throw appError('error.sessionStopping')
    const { runs, workspace, skills, environment } = this.dependencies
    // Retry an unpublished session using the inputs from that exact creation request.
    const snapshotId = `inputs-${createHash('sha256')
      .update(JSON.stringify([sessionId, command.agentId, command.cwd ?? null]))
      .digest('hex')}`
    const exists = await lstat(runs.paths(snapshotId).root).catch(
      (error: NodeJS.ErrnoException) => {
        if (error.code !== 'ENOENT') throw error
        return null
      },
    )
    let manifest
    if (exists) manifest = await runs.verifyForReuse(snapshotId)
    else {
      const state = await workspace.load()
      const profile = state.agents.find((item) => item.id === command.agentId)
      const installation = state.installations.find(
        (item) => item.id === profile?.engineInstallationId,
      )
      if (!profile) throw appError('error.runConfiguration')
      if (!installation || !['opencode', 'pi', 'deepseek-harness'].includes(installation.kind))
        throw appError('error.runtimeUnsupported')
      if (command.cwd) profile.execution.cwd = command.cwd
      if (!profile.execution.cwd) throw appError('error.runtimeCwd')
      const cwd = await realpath(profile.execution.cwd).catch(() => {
        throw appError('error.runtimeCwd')
      })
      const readSkillEntry = async (skill: ResolvedSkill) => {
        if (skill.revision.kind !== 'directory') throw appError('error.skillCaptureInvalid')
        return readFile(join(await skills.verify(skill.revision), 'SKILL.md'), 'utf8')
      }
      if (installation.kind === 'deepseek-harness') {
        const composition = await inspectDshComposition(installation.executable, cwd)
        manifest = await runs.create(snapshotId, state, profile.id, (configuration, paths) =>
          planDsh(configuration, paths, { composition, readSkillEntry }),
        )
      } else if (installation.kind === 'pi') {
        const sources = await inspectPiSources(cwd)
        manifest = await runs.create(snapshotId, state, profile.id, (configuration, paths) =>
          planPi(configuration, paths, { sources, readSkillEntry }),
        )
      } else {
        const locations = openCodeNativeLocations(environment)
        const sources = await inspectOpenCodeSources(cwd, locations)
        manifest = await runs.create(snapshotId, state, profile.id, (configuration, paths) =>
          planOpenCode(configuration, paths, {
            configHome: locations.configHome,
            sources,
            readSkillEntry,
          }),
        )
      }
    }
    if (
      manifest.agent.id !== command.agentId ||
      (command.cwd && manifest.agent.execution.cwd !== command.cwd)
    )
      throw appError('error.runIntegrity')
    return {
      agentId: manifest.agent.id,
      installationId: manifest.installation.id,
      engineVersion: manifest.installation.version!,
      mode: manifest.launch.mode,
      cwd: manifest.cwd,
      snapshotId,
      snapshotDigest: manifest.digest,
    }
  }

  async connect(snapshot: SessionSnapshot, signal: AbortSignal) {
    const { runs, resolveSecret, environment } = this.dependencies
    try {
      const manifest = await runs.read(snapshot.snapshotId)
      if (
        manifest.digest !== snapshot.snapshotDigest ||
        manifest.agent.id !== snapshot.agentId ||
        manifest.installation.id !== snapshot.installationId ||
        manifest.installation.version !== snapshot.engineVersion ||
        manifest.cwd !== snapshot.cwd ||
        manifest.launch.mode !== snapshot.mode
      )
        throw new RuntimeFailure('configuration')
      const connect =
        manifest.installation.kind === 'pi'
          ? connectPi
          : manifest.installation.kind === 'opencode'
            ? connectOpenCode
            : manifest.installation.kind === 'deepseek-harness'
              ? connectDsh
              : null
      if (!connect) throw new RuntimeFailure('unsupported')
      return await connect({
        store: runs,
        snapshotId: snapshot.snapshotId,
        environment,
        resolveSecret,
        signal: AbortSignal.any([signal, this.lifetime.signal]),
        ...(snapshot.status === 'resuming'
          ? { previousNativeSessionId: snapshot.nativeSessionId! }
          : {}),
      })
    } catch (error) {
      if (error instanceof RuntimeFailure) throw error
      throw new RuntimeFailure(
        getErrorKey(error)?.startsWith('error.credential') ? 'credentials' : 'configuration',
      )
    }
  }
  async impact(query: LibraryImpactQuery, snapshots: SessionSnapshot[]) {
    return previewLibraryImpact(
      query,
      snapshots,
      this.dependencies.workspace,
      this.dependencies.runs,
    )
  }
  async configuration(snapshot: SessionSnapshot) {
    const { runs, workspace } = this.dependencies
    return buildConfigurationReport(
      await runs.read(snapshot.snapshotId),
      snapshot,
      await workspace.load(),
    )
  }
  async shutdown(): Promise<void> {
    this.lifetime.abort()
    await Promise.allSettled([...this.probes])
  }
}
