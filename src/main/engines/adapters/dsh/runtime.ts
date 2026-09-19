import { z } from 'zod'
import type { SecretReference } from '../../../../shared/engines/schema'
import type { RunInputStore } from '../../run-input-store'
import { attachAcpProcess, type AcpAttachment } from '../../acp/attachment'
import { AcpTurn } from '../../acp/turn'
import { AcpFailure } from '../../acp/stream'
import { RuntimeFailure, type RuntimeSession } from '../../runtime'
import { redactText } from '../../process/redacted-tail'
import { prepareDshLaunch, verifyDshHome } from './launch'
import { verifyDshOptions } from './readback'
import { prepareDshPluginAttachment } from './plugins'

interface ConnectOptions {
  store: RunInputStore
  snapshotId: string
  resolveSecret(reference: SecretReference): Promise<string>
  environment: NodeJS.ProcessEnv
  signal: AbortSignal
  previousNativeSessionId?: string
}
const failureOf = (error: unknown) =>
  error instanceof RuntimeFailure
    ? error
    : new RuntimeFailure(
        error instanceof AcpFailure
          ? error.code === 'timeout'
            ? 'timeout'
            : error.code === 'engine'
              ? 'engine'
              : 'protocol'
          : 'configuration',
      )

/** Pinned DSH ACP: committed messages, one-shot approvals, and native resume without replay. */
export async function connectDsh(options: ConnectOptions): Promise<RuntimeSession> {
  const { store, snapshotId, signal } = options
  if (signal.aborted) throw new RuntimeFailure('process-exit')
  const { manifest, launch } = await prepareDshLaunch(
    store,
    snapshotId,
    options.resolveSecret,
    options.environment,
    signal,
  )
  const plugins = manifest.nativePlugins.length
    ? await prepareDshPluginAttachment(manifest, store.paths(snapshotId))
    : null
  if (plugins) Object.assign(launch.environment, plugins.environment)
  let active: AcpTurn | null = null
  let submitted = false
  let cancelled = false
  let nativeSessionId: string | undefined
  let attachment: AcpAttachment | undefined
  let handlerFailure: RuntimeFailure | null = null
  const abort = () => {
    void attachment?.close().catch(() => {})
  }
  signal.addEventListener('abort', abort, { once: true })
  try {
    attachment = await attachAcpProcess(launch, {
      update: async (notification) => {
        try {
          if (
            nativeSessionId === notification.sessionId &&
            notification.update.sessionUpdate === 'config_option_update'
          )
            verifyDshOptions(notification.update.configOptions, manifest)
          await active?.update(notification)
        } catch (error) {
          handlerFailure = failureOf(error)
          attachment?.client.close()
          throw handlerFailure
        }
      },
      permission: async (request, permissionSignal) => {
        try {
          return (
            (await active?.permission(request, permissionSignal)) ?? {
              outcome: { outcome: 'cancelled' as const },
            }
          )
        } catch (error) {
          handlerFailure = failureOf(error)
          attachment?.client.close()
          throw handlerFailure
        }
      },
    })
    const owned = attachment
    const closed = owned.closed.finally(async () => {
      signal.removeEventListener('abort', abort)
      await plugins?.cleanup()
    })
    void closed.catch(() => {})
    const lifetime = AbortSignal.any([signal, owned.client.signal])
    if (signal.aborted) throw new RuntimeFailure('process-exit')
    const initialized = await owned.client.initialize('0.1.0')
    // The ACP component's own version is deliberately different from the CLI package version.
    if (
      initialized.agentInfo?.name !== 'deepseek-harness-acp' ||
      initialized.agentInfo.version !== '0.0.1'
    )
      throw new RuntimeFailure('configuration', 'dsh.acp-version')
    if (!initialized.agentCapabilities?.sessionCapabilities?.resume)
      throw new RuntimeFailure('unsupported', 'resume')
    // ACP may acknowledge initialization while native plugins are still loading.
    await plugins?.verify(owned.process.pid, lifetime, null, true)
    const previous = options.previousNativeSessionId
    if (previous !== undefined && !z.uuid().safeParse(previous).success)
      throw new RuntimeFailure('configuration', 'dsh.session-identity')
    const response = previous
      ? await owned.client.resumeSession({ sessionId: previous, cwd: manifest.cwd, mcpServers: [] })
      : await owned.client.newSession({ cwd: manifest.cwd, mcpServers: [] })
    nativeSessionId = previous ?? ('sessionId' in response ? String(response.sessionId) : '')
    if (
      !z.uuid().safeParse(nativeSessionId).success ||
      launch.secrets?.some((secret) => nativeSessionId!.includes(secret))
    )
      throw new RuntimeFailure('protocol', 'dsh.session-identity')
    const id = nativeSessionId
    const modelValue = verifyDshOptions(response.configOptions, manifest)
    const verify = async () => {
      await store.verifyForReuse(snapshotId)
      await verifyDshHome(store, snapshotId)
      const state = await owned.client.setSessionConfigOption({
        sessionId: id,
        configId: 'model',
        value: modelValue,
      })
      verifyDshOptions(state.configOptions, manifest)
      await plugins?.verify(owned.process.pid, lifetime, id)
      if (handlerFailure) throw handlerFailure
      if (signal.aborted || owned.client.signal.aborted) throw new RuntimeFailure('process-exit')
    }
    await verify()
    return {
      nativeRuntime: {
        protocol: 'acp',
        version: 1,
        restoration: 'resume',
        restored: Boolean(previous),
      },
      configurationChecks: [
        'inputs.integrity',
        'sources.unchanged',
        'cli.version',
        'dsh.composition',
        'dsh.session-model',
        ...(plugins ? ['dsh.plugins' as const] : []),
        ...(manifest.connection.protocol === 'deepseek-official'
          ? ['dsh.session-reasoning' as const]
          : []),
      ],
      nativeSessionId: id,
      closed,
      redact: (text) => redactText(text, launch.secrets ?? []),
      async send(text, handlers) {
        if (active || signal.aborted || owned.client.signal.aborted)
          throw new RuntimeFailure('protocol', 'turn.state')
        if (!text.trim() || text.length > 65_536)
          throw new RuntimeFailure('configuration', 'turn.text')
        const turn = new AcpTurn(id, launch.secrets ?? [], handlers)
        active = turn
        submitted = false
        cancelled = false
        try {
          await verify()
          // Cancel during preflight must not run the provider after cancellation was acknowledged.
          if (cancelled) return { outcome: 'cancelled', nativeStopReason: null, usage: null }
          submitted = true
          const result = await owned.client.prompt(
            { sessionId: id, prompt: [{ type: 'text', text }] },
            manifest.agent.execution.timeoutMs ?? 600_000,
          )
          await turn.finish()
          if (handlerFailure) throw handlerFailure
          await plugins?.verify(owned.process.pid, lifetime, id)
          // usage_update is context occupancy; DSH does not report billable prompt usage.
          return { ...turn.result({ stopReason: result.stopReason }), usage: null }
        } catch (error) {
          throw handlerFailure ?? failureOf(error)
        } finally {
          try {
            await turn.finish()
          } finally {
            active = null
            submitted = false
          }
        }
      },
      async cancel() {
        if (!active) return
        cancelled = true
        if (submitted) await owned.client.cancel(id)
      },
      // Terminating the owned bridge retains durable native history; resume never creates a replacement.
      dispose: () => owned.close(),
    }
  } catch (error) {
    signal.removeEventListener('abort', abort)
    await attachment?.close()
    await plugins?.cleanup()
    throw handlerFailure ?? failureOf(error)
  }
}
