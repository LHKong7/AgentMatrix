import type { SessionConfigOption } from '@agentclientprotocol/sdk'
import type { SecretReference } from '../../../../shared/engines/schema'
import type { RunInputStore } from '../../run-input-store'
import { prepareRunLaunch } from '../../run-launch'
import { attachAcpProcess, type AcpAttachment } from '../../acp/attachment'
import { AcpTurn } from '../../acp/turn'
import { AcpFailure } from '../../acp/stream'
import {
  RuntimeFailure,
  type RuntimeSession,
  type RuntimeTurnHandlers,
  type RuntimeTurnResult,
} from '../../runtime'
import { openCodeContract } from './configuration'
import { verifyOpenCodeReadback, verifyOpenCodeSkillReadback } from './readback'
import { redactText } from '../../process/redacted-tail'
import { prepareOpenCodePluginAttachment } from './plugins'

interface ConnectOptions {
  store: RunInputStore
  snapshotId: string
  resolveSecret(reference: SecretReference): Promise<string>
  environment: NodeJS.ProcessEnv
  signal: AbortSignal
  previousNativeSessionId?: string
}

/** A ready result requires verified inputs, native readback, ACP negotiation, and session acknowledgment. */
export async function connectOpenCode(options: ConnectOptions): Promise<RuntimeSession> {
  const { store, snapshotId, signal } = options
  if (signal.aborted) throw new RuntimeFailure('process-exit')
  const { manifest, launch } = await prepareRunLaunch(
    store,
    snapshotId,
    options.resolveSecret,
    options.environment,
  )
  if (
    manifest.adapter.id !== openCodeContract.id ||
    manifest.adapter.version !== openCodeContract.version ||
    manifest.installation.kind !== 'opencode' ||
    manifest.installation.version !== openCodeContract.engineVersion ||
    manifest.launch.mode !== 'acp'
  )
    throw new RuntimeFailure('unsupported')
  await verifyOpenCodeReadback(manifest, store.paths(snapshotId), launch, signal)
  await verifyOpenCodeSkillReadback(manifest, store.paths(snapshotId), launch, signal)
  // Native config loading can itself migrate files. Such changes invalidate this captured plan.
  await store.verifyForReuse(snapshotId)
  if (signal.aborted) throw new RuntimeFailure('process-exit')
  const plugins = await prepareOpenCodePluginAttachment(manifest, store.paths(snapshotId))
  if (plugins) Object.assign(launch.environment, plugins.environment)
  let active: AcpTurn | null = null
  let handlerFailure: RuntimeFailure | null = null
  let attachment: AcpAttachment | undefined
  const abort = () => {
    void attachment?.close().catch(() => {})
  }
  signal.addEventListener('abort', abort, { once: true })
  const checkedConfig = (choices: SessionConfigOption[] | null | undefined) => {
    const model = choices?.find((choice) => choice.id === 'model')
    const agent = choices?.find((choice) => choice.id === 'mode')
    const expectedAgent =
      manifest.agent.engineOptions?.kind === 'opencode'
        ? manifest.agent.engineOptions.agent
        : 'build'
    const fields: ('model' | 'engine-options')[] = []
    if (
      model?.type !== 'select' ||
      model.currentValue !== `agentmatrix-${manifest.connection.id}/selected`
    )
      fields.push('model')
    if (agent?.type !== 'select' || agent.currentValue !== expectedAgent)
      fields.push('engine-options')
    if (fields.length)
      throw new RuntimeFailure('configuration', 'native.session-options', {
        check: 'opencode-session',
        reason: model?.type === 'select' && agent?.type === 'select' ? 'mismatch' : 'unavailable',
        fields,
      })
  }
  try {
    attachment = await attachAcpProcess(launch, {
      update: async (notification) => {
        try {
          await active?.update(notification)
        } catch (error) {
          handlerFailure = error instanceof RuntimeFailure ? error : new RuntimeFailure('protocol')
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
          handlerFailure = error instanceof RuntimeFailure ? error : new RuntimeFailure('protocol')
          attachment?.client.close()
          throw handlerFailure
        }
      },
    })
    if (signal.aborted) {
      await attachment.close()
      throw new RuntimeFailure('process-exit')
    }
    const owned = attachment
    const closed = owned.closed.finally(async () => {
      signal.removeEventListener('abort', abort)
      await plugins?.cleanup()
    })
    void closed.catch(() => {})
    const initialization = await owned.client.initialize('0.1.0')
    if (initialization.agentInfo?.version !== manifest.installation.version)
      throw new RuntimeFailure('configuration', 'installation.version', {
        check: 'installation',
        reason: 'mismatch',
        fields: ['installation'],
      })
    let nativeSessionId = options.previousNativeSessionId
    if (nativeSessionId) {
      if (launch.secrets?.some((secret) => nativeSessionId!.includes(secret)))
        throw new RuntimeFailure('protocol')
      const params = { sessionId: nativeSessionId, cwd: manifest.cwd, mcpServers: [] }
      const response = initialization.agentCapabilities?.sessionCapabilities?.resume
        ? await owned.client.resumeSession(params)
        : initialization.agentCapabilities?.loadSession
          ? await owned.client.loadSession(params)
          : null
      if (!response) throw new RuntimeFailure('unsupported', 'resume')
      checkedConfig(response.configOptions)
      await plugins?.verify(owned.process.pid, response.configOptions)
    } else {
      const created = await owned.client.newSession({ cwd: manifest.cwd, mcpServers: [] })
      checkedConfig(created.configOptions)
      await plugins?.verify(owned.process.pid, created.configOptions)
      nativeSessionId = created.sessionId
    }
    if (
      !nativeSessionId ||
      nativeSessionId.length > 1000 ||
      launch.secrets?.some((secret) => nativeSessionId!.includes(secret))
    )
      throw new RuntimeFailure('protocol')
    if (signal.aborted || owned.client.signal.aborted) throw new RuntimeFailure('process-exit')
    const id = nativeSessionId
    return {
      nativeRuntime: {
        protocol: 'acp',
        version: 1,
        restoration: initialization.agentCapabilities?.sessionCapabilities?.resume
          ? 'resume'
          : initialization.agentCapabilities?.loadSession
            ? 'load'
            : 'unavailable',
        restored: Boolean(options.previousNativeSessionId),
      },
      configurationChecks: [
        'inputs.integrity',
        'sources.unchanged',
        'cli.version',
        'opencode.config',
        ...(manifest.skills.length ? ['opencode.skill-sources' as const] : []),
        'opencode.session-model',
        'opencode.session-agent',
        ...(plugins ? ['opencode.plugins' as const] : []),
      ],
      nativeSessionId: id,
      closed,
      redact: (text) => redactText(text, launch.secrets ?? []),
      async send(text: string, handlers: RuntimeTurnHandlers): Promise<RuntimeTurnResult> {
        if (active || signal.aborted || owned.client.signal.aborted)
          throw new RuntimeFailure('protocol', 'turn.state')
        if (!text.trim() || text.length > 65_536)
          throw new RuntimeFailure('configuration', 'turn.text')
        const turn = new AcpTurn(id, launch.secrets ?? [], handlers)
        active = turn
        try {
          await plugins?.verify(owned.process.pid)
          const result = await owned.client.prompt(
            { sessionId: id, prompt: [{ type: 'text', text }] },
            manifest.agent.execution.timeoutMs ?? 600_000,
          )
          await turn.finish()
          return turn.result(result)
        } catch (error) {
          await turn.finish()
          if (handlerFailure) throw handlerFailure
          if (error instanceof RuntimeFailure) throw error
          throw new RuntimeFailure(
            error instanceof AcpFailure && error.code === 'timeout' ? 'timeout' : 'engine',
          )
        } finally {
          active = null
        }
      },
      cancel: () => owned.client.cancel(id),
      dispose: () => owned.close(),
    }
  } catch (error) {
    signal.removeEventListener('abort', abort)
    await attachment?.close()
    await plugins?.cleanup()
    if (error instanceof RuntimeFailure) throw error
    throw new RuntimeFailure(
      error instanceof AcpFailure && error.code === 'timeout' ? 'timeout' : 'protocol',
    )
  }
}
