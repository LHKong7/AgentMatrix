import { ManagedProcess, type ProcessLaunch, type ProcessResult } from '../process/managed-process'
import { PiClient, type PiHandlers } from './client'

export interface PiAttachment {
  client: PiClient
  process: ManagedProcess
  closed: Promise<ProcessResult>
  close(): Promise<ProcessResult>
}
export async function attachPiProcess(
  launch: ProcessLaunch,
  handlers: PiHandlers,
  limits: ConstructorParameters<typeof PiClient>[3] = {},
): Promise<PiAttachment> {
  const process = new ManagedProcess(launch)
  let client: PiClient
  try {
    await process.ready
    client = new PiClient(process.stdout, process.stdin, handlers, limits)
  } catch (error) {
    await process.terminate()
    throw error
  }
  const closed = client.closed.then(() => process.terminate())
  void closed.catch(() => {})
  void process.closed.then(() => client.close())
  return {
    client,
    process,
    closed,
    close: () => {
      const stopping = process.terminate()
      client.close()
      return stopping
    },
  }
}
