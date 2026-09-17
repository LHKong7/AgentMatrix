import { randomUUID } from 'node:crypto'
import type { IpcMain, IpcMainInvokeEvent, WebContents } from 'electron'
import { z } from 'zod'
import { appError, getErrorKey } from '../../shared/errors'
import { sessionChannels } from '../../shared/sessions/channels'
import { sessionSubscriptionSchema } from '../../shared/sessions/schema'
import { entityId } from '../../shared/engines/schema'
import type { SessionCoordinator } from './coordinator'

export function verifyRenderer(
  event: IpcMainInvokeEvent,
  contents: WebContents | null,
  rendererUrl: string,
): void {
  if (
    !contents ||
    event.sender !== contents ||
    event.senderFrame !== contents.mainFrame ||
    event.senderFrame.url !== rendererUrl
  )
    throw appError('error.untrusted')
}

export async function safeSessionOperation<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation()
  } catch (error) {
    if (getErrorKey(error)) throw error
    throw appError(error instanceof z.ZodError ? 'error.invalidData' : 'error.runtimeOperation')
  }
}
export function registerSessionIpc(
  ipc: Pick<IpcMain, 'handle'>,
  coordinator: SessionCoordinator,
  verify: (event: IpcMainInvokeEvent) => void,
) {
  const owners = new Map<WebContents, string>()
  const owner = (event: IpcMainInvokeEvent) => {
    verify(event)
    const value = owners.get(event.sender)
    if (!value) throw appError('error.untrusted')
    return value
  }
  const handle = (
    channel: string,
    operation: (event: IpcMainInvokeEvent, input: unknown) => Promise<unknown>,
  ) => {
    ipc.handle(channel, (event, input) =>
      safeSessionOperation(async () => {
        owner(event)
        return operation(event, input)
      }),
    )
  }
  handle(sessionChannels.command, (_event, input) => coordinator.command(input))
  handle(sessionChannels.get, (_event, input) => coordinator.get(input))
  handle(sessionChannels.list, () => coordinator.list())
  handle(sessionChannels.events, (_event, input) => coordinator.readEvents(input))
  handle(sessionChannels.subscribe, async (event, input) => {
    const query = sessionSubscriptionSchema.parse(input)
    const identity = owner(event)
    const subscription = await coordinator.subscribe(identity, query, (delivery) => {
      if (owners.get(event.sender) !== identity) return
      verify(event)
      event.senderFrame!.send(sessionChannels.delivery, delivery)
    })
    try {
      if (owner(event) !== identity) throw appError('error.untrusted')
      return { snapshot: subscription.snapshot }
    } catch (error) {
      subscription.unsubscribe()
      throw error
    }
  })
  handle(sessionChannels.unsubscribe, async (event, input) => {
    const query = z.object({ sessionId: entityId, subscriptionId: entityId }).strict().parse(input)
    coordinator.unsubscribe(owner(event), query.sessionId, query.subscriptionId)
  })
  return {
    attach(contents: WebContents): void {
      const reset = () => {
        const identity = owners.get(contents)
        if (identity) coordinator.removeOwner(identity)
        owners.set(contents, randomUUID())
      }
      reset()
      contents.on('did-start-navigation', (_event, _url, inPlace, mainFrame) => {
        if (mainFrame && !inPlace) reset()
      })
      contents.once('destroyed', () => {
        const identity = owners.get(contents)
        if (identity) coordinator.removeOwner(identity)
        owners.delete(contents)
      })
    },
  }
}
