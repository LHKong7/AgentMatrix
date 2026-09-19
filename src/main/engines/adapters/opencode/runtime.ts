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
import { openCodeSkillPlanPath, prepareOpenCodeSkillAttachment } from './skills'
import { openCodeConfigPlanPath, prepareOpenCodeConfigurationAttachment } from './instance-config'
import { observeOpenCodeMcp } from './mcp'
import { verifyInstructionSources } from '../../instruction-sources'

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
  const hasConfigObserver = manifest.files.some((file) => file.path === openCodeConfigPlanPath)
  const hasSkillObserver = manifest.files.some((file) => file.path === openCodeSkillPlanPath)
  if (!hasSkillObserver)
    await verifyOpenCodeSkillReadback(manifest, store.paths(snapshotId), launch, signal)
  // Native config loading can itself migrate files. Such changes invalidate this captured plan.
  await store.verifyForReuse(snapshotId)
  if (signal.aborted) throw new RuntimeFailure('process-exit')
  let plugins: Awaited<ReturnType<typeof prepareOpenCodePluginAttachment>> = null
  let instance: Awaited<ReturnType<typeof prepareOpenCodeSkillAttachment>> | null = null
  let active: AcpTurn | null = null
  let submitted = false,
    cancelled = false
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
    plugins = await prepareOpenCodePluginAttachment(manifest, store.paths(snapshotId))
    if (plugins) Object.assign(launch.environment, plugins.environment)
    if (hasConfigObserver || hasSkillObserver) {
      instance = hasConfigObserver
        ? await prepareOpenCodeConfigurationAttachment(
            manifest,
            store.paths(snapshotId),
            launch.environment,
          )
        : await prepareOpenCodeSkillAttachment(manifest, store.paths(snapshotId))
      Object.assign(launch.environment, instance.environment)
      launch.args.push(...instance.args)
      launch.secrets = [...(launch.secrets ?? []), ...instance.secrets]
      // Internal HTTP credentials must fit the same redaction bounds before any child starts.
      try {
        redactText('', launch.secrets)
      } catch {
        throw new RuntimeFailure('configuration', 'credentials.redaction-limit')
      }
      if (manifest.redactionHistoryVersion) {
        try {
          launch.secrets = await store.retainRedactions(manifest, launch.secrets)
        } catch {
          throw new RuntimeFailure('credentials')
        }
      }
    }
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
      await Promise.all([plugins?.cleanup(), instance?.cleanup()])
    })
    void closed.catch(() => {})
    const initialization = await owned.client.initialize('0.1.0')
    if (initialization.agentInfo?.version !== manifest.installation.version)
      throw new RuntimeFailure('configuration', 'installation.version', {
        check: 'installation',
        reason: 'mismatch',
        fields: ['installation'],
      })
    const lifetime = AbortSignal.any([signal, owned.client.signal])
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
    const verifyInstructions = async () => {
      if (!manifest.externalSources.instructionSources) return
      try {
        await verifyInstructionSources(manifest.externalSources.instructionSources)
      } catch {
        throw new RuntimeFailure('configuration', 'native.instruction-sources', {
          check: 'sources',
          reason: 'changed',
          fields: ['prompts'],
        })
      }
    }
    await verifyInstructions()
    await instance?.verify(owned.process.pid, lifetime, id)
    const mcpConnections =
      hasConfigObserver && instance && manifest.mcpServers.length
        ? await observeOpenCodeMcp(
            instance,
            manifest.mcpServers.map((server) => server.id),
            owned.process.pid,
            lifetime,
            id,
          )
        : undefined
    if (mcpConnections) await instance!.verify(owned.process.pid, lifetime, id)
    if (signal.aborted || owned.client.signal.aborted) throw new RuntimeFailure('process-exit')
    return {
      ...(mcpConnections ? { mcpConnections } : {}),
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
        ...(hasConfigObserver ? ['opencode.instance-config' as const] : []),
        ...(hasSkillObserver
          ? ['opencode.instance-skills' as const]
          : manifest.skills.length
            ? ['opencode.skill-sources' as const]
            : []),
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
        submitted = false
        cancelled = false
        try {
          await plugins?.verify(owned.process.pid)
          await verifyInstructions()
          await instance?.verify(owned.process.pid, lifetime, id)
          if (cancelled) return { outcome: 'cancelled', nativeStopReason: null, usage: null }
          submitted = true
          const result = await owned.client.prompt(
            { sessionId: id, prompt: [{ type: 'text', text }] },
            manifest.agent.execution.timeoutMs ?? 600_000,
          )
          await turn.finish()
          await verifyInstructions()
          await instance?.verify(owned.process.pid, lifetime, id)
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
          submitted = false
        }
      },
      async cancel() {
        if (!active) return
        cancelled = true
        if (submitted) await owned.client.cancel(id)
      },
      dispose: () => owned.close(),
    }
  } catch (error) {
    signal.removeEventListener('abort', abort)
    await attachment?.close()
    await Promise.all([plugins?.cleanup(), instance?.cleanup()])
    if (error instanceof RuntimeFailure) throw error
    throw new RuntimeFailure(
      error instanceof AcpFailure && error.code === 'timeout' ? 'timeout' : 'protocol',
    )
  }
}
