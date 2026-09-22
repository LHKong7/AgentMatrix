import { assertEngineConfiguration } from '../../shared/engines/validation'
import { resolveWorkingDirectory } from './working-directory'
import { resolveAgentProfile } from '../../shared/engines/resolution'
import { previewLibraryImpact } from '../engines/library-impact'
import type { LibraryImpactQuery } from '../../shared/engines/impact'
import { createHash } from 'node:crypto'
import { lstat, mkdir, mkdtemp, readFile, rm } from 'node:fs/promises'
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
import {
  fingerprintFor,
  type EvidenceKind,
  type EvidenceSubject,
} from '../../shared/engines/evidence'
import { adapterVersionFor, bindingFor } from '../../shared/engines/provider'
import { buildConfigurationReport } from '../engines/configuration-report'
import { trackCredentialResolution } from '../engines/credential-report'
import type { CredentialVersions, ResolvedCredential } from '../credentials/vault'
import { capturedSkillSources } from '../engines/skill-readback'
import type { RunDataQuery, RunDataRemoval } from '../../shared/sessions/run-data'

interface Observation {
  subject: EvidenceSubject
  fingerprint: string
  adapterVersion: string
}
interface Dependencies {
  workspace: {
    load(): Promise<EngineWorkspace>
    save(value: EngineWorkspace): Promise<EngineWorkspace>
    observe?(entry: {
      subject: EvidenceSubject
      kind: EvidenceKind
      result: 'pass' | 'fail'
      fingerprint: string
      adapterVersion: string
    }): Promise<void>
  }
  runs: RunInputStore
  skills: SkillDirectoryStore
  resolveSecret(reference: SecretReference): Promise<string>
  resolveSecretVersioned?(reference: SecretReference): Promise<ResolvedCredential>
  credentialVersions?(): Promise<CredentialVersions>
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
  unusedRunData(references: ReadonlySet<string>, query: RunDataQuery) {
    return this.dependencies.runs.unused(references, query)
  }
  removeUnusedRunData(query: RunDataRemoval, references: ReadonlySet<string>) {
    return this.dependencies.runs.removeUnused(query, references)
  }
  removeSnapshot(snapshotId: string): Promise<void> {
    return this.dependencies.runs.remove(snapshotId)
  }
  private readonly lifetime = new AbortController()
  private readonly probes = new Set<Promise<unknown>>()
  /** What each prepared session's configuration was, so a later result is filed against it. */
  private readonly prepared = new Map<string, Observation[]>()
  constructor(private readonly dependencies: Dependencies) {}

  /**
   * The agent's configuration and the grant it runs on, as they stand in the saved workspace.
   *
   * Taken before the per-launch working directory is applied, because that override is this run's
   * and not what was saved. A run that started from an override files nothing about the saved
   * configuration: the store drops an observation whose fingerprint has moved on.
   */
  private observations(workspace: EngineWorkspace, agentId: string): Observation[] {
    const agent = workspace.agents.find((item) => item.id === agentId)
    const installation = workspace.installations.find(
      (item) => item.id === agent?.engineInstallationId,
    )
    const model = workspace.models.find((item) => item.id === agent?.modelProfileId)
    const grant = bindingFor(workspace, installation?.id ?? null, model?.connectionId ?? null)
    const adapterVersion = adapterVersionFor(installation?.kind ?? '')
    const subjects: EvidenceSubject[] = [
      { kind: 'agent', id: agentId },
      ...(grant ? [{ kind: 'binding' as const, id: grant.id }] : []),
    ]
    return subjects.flatMap((subject) => {
      const fingerprint = fingerprintFor(workspace, subject)
      return fingerprint ? [{ subject, fingerprint, adapterVersion }] : []
    })
  }
  private file(observations: Observation[], kind: EvidenceKind): void {
    const { workspace } = this.dependencies
    if (!workspace.observe) return
    for (const observation of observations)
      void workspace.observe({ ...observation, kind, result: 'pass' }).catch(() => {})
  }
  async observe(snapshot: SessionSnapshot, kind: 'session-ready' | 'model-response') {
    this.file(this.prepared.get(snapshot.id) ?? [], kind)
  }

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
      const observations = this.observations(state, command.agentId)
      const profile = state.agents.find((item) => item.id === command.agentId)
      const installation = state.installations.find(
        (item) => item.id === profile?.engineInstallationId,
      )
      if (!profile) throw appError('error.runConfiguration')
      if (!installation || !['opencode', 'pi', 'deepseek-harness'].includes(installation.kind))
        throw appError('error.runtimeUnsupported')
      if (command.cwd) profile.execution.cwd = command.cwd
      if (!profile.execution.cwd) throw appError('error.runtimeCwd')
      const resolved = resolveAgentProfile(state, profile.id)
      if (resolved.status !== 'resolved') throw appError('error.runConfiguration')
      assertEngineConfiguration(resolved.configuration, { platform: process.platform })
      // The adapter accepted these values. Whether the provider does is a separate observation.
      this.file(observations, 'configuration-valid')
      // Keep only what a running session might still report on.
      if (this.prepared.size > 200) this.prepared.clear()
      this.prepared.set(sessionId, observations)
      const cwd = await resolveWorkingDirectory(profile.execution.cwd)
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
      const tracker = this.dependencies.resolveSecretVersioned
        ? trackCredentialResolution(manifest, this.dependencies.resolveSecretVersioned)
        : null
      try {
        const runtime = await connect({
          store: runs,
          snapshotId: snapshot.snapshotId,
          environment,
          resolveSecret: tracker ? (reference) => tracker.resolve(reference) : resolveSecret,
          signal: AbortSignal.any([signal, this.lifetime.signal]),
          ...(snapshot.status === 'resuming'
            ? { previousNativeSessionId: snapshot.nativeSessionId! }
            : {}),
        })
        if (tracker) {
          try {
            Object.defineProperty(runtime, 'credentialResolutions', { value: tracker.complete() })
          } catch (error) {
            await runtime.dispose()
            throw error
          }
        }
        return runtime
      } finally {
        tracker?.clear()
      }
    } catch (error) {
      if (error instanceof RuntimeFailure) throw error
      throw new RuntimeFailure(
        getErrorKey(error)?.startsWith('error.credential') ? 'credentials' : 'configuration',
        '',
        getErrorKey(error) === 'error.runSourceChanged'
          ? { check: 'sources', reason: 'changed', fields: [] }
          : getErrorKey(error) === 'error.runIntegrity'
            ? { check: 'snapshot', reason: 'mismatch', fields: [] }
            : undefined,
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
    const manifest = await runs.read(snapshot.snapshotId)
    const kind = manifest.installation.kind
    const mappings =
      kind === 'pi' || kind === 'opencode' || kind === 'deepseek-harness'
        ? await capturedSkillSources(
            manifest,
            runs.paths(snapshot.snapshotId),
            kind === 'pi'
              ? 'pi-mappings.json'
              : kind === 'opencode'
                ? 'opencode-mappings.json'
                : 'dsh-mappings.json',
          ).catch(() => [])
        : []
    return buildConfigurationReport(
      manifest,
      snapshot,
      await workspace.load(),
      undefined,
      (await this.dependencies.credentialVersions?.().catch(() => null)) ?? null,
      Object.fromEntries(mappings.map((skill) => [skill.assetId, skill.inputPath])),
    )
  }
  async shutdown(): Promise<void> {
    this.lifetime.abort()
    await Promise.allSettled([...this.probes])
  }
}
