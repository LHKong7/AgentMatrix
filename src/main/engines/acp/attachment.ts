import { AcpClient, type AcpHandlers, type AcpLimits } from './client'
import { ManagedProcess, type ProcessLaunch, type ProcessResult } from '../process/managed-process'

export interface AcpAttachment {
  client: AcpClient
  process: ManagedProcess
  closed: Promise<ProcessResult>
  close(): Promise<ProcessResult>
}

/** One lifetime: protocol failure disposes the process group; process exit closes the peer. */
export async function attachAcpProcess(
  launch: ProcessLaunch,
  handlers: AcpHandlers,
  limits: Partial<AcpLimits> = {},
): Promise<AcpAttachment> {
  const process = new ManagedProcess(launch)
  try {
    await process.ready
  } catch (error) {
    await process.terminate()
    throw error
  }
  let client: AcpClient
  try {
    client = new AcpClient(process.stdout, process.stdin, handlers, limits)
  } catch (error) {
    await process.terminate()
    throw error
  }
  const closed = client.closed.then(() => process.terminate())
  // Keep asynchronous cleanup errors observable through closed without an unhandled rejection.
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
