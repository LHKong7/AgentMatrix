import { z } from 'zod'
import type { SecretReference } from '../../../../shared/engines/schema'
import type { RunInputStore } from '../../run-input-store'
import { attachPiProcess, type PiAttachment } from '../../pi/attachment'
import { PiFailure } from '../../pi/protocol'
import { PiTurn, piIdleEvents } from '../../pi/turn'
import { RuntimeFailure, type RuntimeSession } from '../../runtime'
import { redactText } from '../../process/redacted-tail'
import { preparePiLaunch, verifyPiHome } from './launch'
import { verifyPiReadback } from './readback'
import { rememberPiSession, restorePiSession } from './session-state'
import { preparePiPluginAttachment } from './plugins'

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
        error instanceof PiFailure
          ? error.code === 'timeout'
            ? 'timeout'
            : error.code === 'engine'
              ? 'engine'
              : 'protocol'
          : 'engine',
      )

export async function connectPi(options: ConnectOptions): Promise<RuntimeSession> {
  const { store, snapshotId, signal } = options
  if (signal.aborted) throw new RuntimeFailure('process-exit')
  const { manifest, launch } = await preparePiLaunch(
    store,
    snapshotId,
    options.resolveSecret,
    options.environment,
    signal,
  )
  const paths = store.paths(snapshotId)
  const previous = options.previousNativeSessionId
    ? await restorePiSession(paths, manifest, options.previousNativeSessionId)
    : undefined
  const plugins = await preparePiPluginAttachment(manifest, paths)
  if (plugins) Object.assign(launch.environment, plugins.environment)
  let active: PiTurn | null = null
  let submitted: Promise<unknown> | null = null
  let attachment: PiAttachment | undefined
  let handlerFailure: RuntimeFailure | null = null
  const abort = () => {
    void attachment?.close().catch(() => {})
  }
  signal.addEventListener('abort', abort, { once: true })
  try {
    attachment = await attachPiProcess(launch, {
      event: async (event) => {
        try {
          if (active) await active.event(event)
          else if (plugins && event.type === 'extension_error')
            throw new RuntimeFailure('configuration', 'pi.plugins.startup')
          else if (!piIdleEvents.has(event.type))
            throw new RuntimeFailure('protocol', 'pi.unowned-event')
        } catch (error) {
          handlerFailure = failureOf(error)
          active?.fail(handlerFailure)
          throw handlerFailure
        }
      },
      dialog: async (dialog, dialogSignal) => {
        try {
          return active ? await active.dialog(dialog, dialogSignal) : { cancelled: true }
        } catch (error) {
          handlerFailure = failureOf(error)
          active?.fail(handlerFailure)
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
    if (signal.aborted) throw new RuntimeFailure('process-exit')
    // Project settings may override the global defaults; pin supported continuation policy explicitly.
    const configure = async () => {
      await owned.client.request({ type: 'set_auto_retry', enabled: false })
      await owned.client.request({ type: 'set_auto_compaction', enabled: false })
    }
    await configure()
    if (previous) {
      const switched = z
        .object({ cancelled: z.boolean() })
        .parse(
          await owned.client.request({ type: 'switch_session', sessionPath: previous.sessionPath }),
        )
      if (switched.cancelled) throw new RuntimeFailure('configuration', 'pi.resume-cancelled')
      await configure()
    }
    const state = await verifyPiReadback(owned.client, manifest, paths)
    await plugins?.verify(owned.client, owned.process.pid, state)
    if (
      launch.secrets?.some(
        (secret) => state.sessionId.includes(secret) || state.sessionFile.includes(secret),
      )
    )
      throw new RuntimeFailure('protocol')
    if (previous) {
      if (
        state.sessionId !== options.previousNativeSessionId ||
        state.sessionFile !== previous.sessionPath
      )
        throw new RuntimeFailure('configuration', 'pi.session-identity')
    } else await rememberPiSession(paths, manifest, state.sessionId, state.sessionFile)
    await store.verifyForReuse(snapshotId)
    await verifyPiHome(store, snapshotId)
    const id = state.sessionId
    let nativeHistoryRequired = Boolean(previous)
    void owned.client.closed.then(() =>
      active?.fail(handlerFailure ?? new RuntimeFailure('process-exit')),
    )
    return {
      nativeRuntime: {
        protocol: 'pi-rpc',
        restoration: 'switch-session',
        restored: Boolean(previous),
      },
      configurationChecks: [
        'inputs.integrity',
        'sources.unchanged',
        'cli.version',
        'pi.state',
        'pi.skills',
        ...(plugins ? ['pi.plugins' as const] : []),
      ],
      nativeSessionId: id,
      closed,
      redact: (text) => redactText(text, launch.secrets ?? []),
      async send(text, handlers) {
        if (active || signal.aborted || owned.client.signal.aborted)
          throw new RuntimeFailure('protocol', 'turn.state')
        if (!text.trim() || text.length > 65_536)
          throw new RuntimeFailure('configuration', 'turn.text')
        const turn = new PiTurn(launch.secrets ?? [], handlers)
        active = turn
        const timer = setTimeout(() => {
          handlerFailure = new RuntimeFailure('timeout')
          turn.fail(handlerFailure)
          owned.client.close(new PiFailure('timeout'))
        }, manifest.agent.execution.timeoutMs ?? 600_000)
        try {
          await store.verifyForReuse(snapshotId)
          await verifyPiHome(store, snapshotId)
          const current = await verifyPiReadback(owned.client, manifest, paths)
          if (current.sessionId !== id || current.sessionFile !== state.sessionFile)
            throw new RuntimeFailure('configuration', 'pi.session-identity')
          const saved = await restorePiSession(paths, manifest, id, {
            allowUnwritten: !nativeHistoryRequired,
          })
          nativeHistoryRequired ||= saved.persisted
          const handledBefore = await plugins?.verify(owned.client, owned.process.pid, current)
          // Only selected, witnessed extensions can finish without agent_settled.
          if (text.startsWith('/')) {
            const commands = z
              .object({ commands: z.array(z.object({ name: z.string(), source: z.string() })) })
              .parse(await owned.client.request({ type: 'get_commands' }))
            const name = text.slice(1).split(' ')[0]
            if (
              name?.startsWith('agentmatrix-witness-') ||
              (!plugins &&
                commands.commands.some(
                  (command) => command.source === 'extension' && command.name === name,
                ))
            )
              throw new RuntimeFailure('unsupported', 'pi.extension-command')
          }
          if (turn.cancelled) return { outcome: 'cancelled', nativeStopReason: null, usage: null }
          submitted = owned.client.request({ type: 'prompt', message: text })
          await submitted
          if (plugins) {
            const handledAfter = await plugins.verify(owned.client, owned.process.pid, state)
            if (handledAfter > handledBefore!) turn.finishExtensionOnly()
          }
          const result = await turn.settled
          const final = await verifyPiReadback(owned.client, manifest, paths)
          if (final.sessionId !== id || final.sessionFile !== state.sessionFile)
            throw new RuntimeFailure('configuration', 'pi.session-identity')
          const persisted = await restorePiSession(paths, manifest, id, {
            allowUnwritten:
              result.nativeStopReason === 'extension-handled' && !nativeHistoryRequired,
          })
          nativeHistoryRequired ||= persisted.persisted
          await verifyPiHome(store, snapshotId)
          await plugins?.verify(owned.client, owned.process.pid, final)
          return result
        } catch (error) {
          const failure = handlerFailure ?? failureOf(error)
          turn.fail(failure)
          throw failure
        } finally {
          clearTimeout(timer)
          active = null
          submitted = null
        }
      },
      async cancel() {
        const turn = active
        if (!turn) return
        turn.cancel()
        // Wait for prompt preflight so abort cannot race ahead of an accepted model run.
        if (!submitted) return
        await submitted
        if (active !== turn || owned.client.signal.aborted) return
        await owned.client.request({ type: 'clear_queue' })
        await owned.client.request({ type: 'abort' })
      },
      dispose: () => owned.close(),
    }
  } catch (error) {
    signal.removeEventListener('abort', abort)
    await attachment?.close()
    await plugins?.cleanup()
    throw failureOf(error)
  }
}
