import type { Server } from 'node:http'
import { rm } from 'node:fs/promises'

/** Retain fixture files when a child may still be using them; always stop the loopback server. */
export async function closeNativeFixture(
  attachments: readonly { close(): Promise<unknown> }[],
  server: Server,
  root: string,
): Promise<void> {
  const stopped = await Promise.allSettled(attachments.map((attachment) => attachment.close()))
  server.closeAllConnections()
  await new Promise<void>((resolve) => server.close(() => resolve()))
  const failures = stopped.filter((result) => result.status === 'rejected')
  if (failures.length)
    throw new AggregateError(
      failures.map((result) => result.reason),
      'Native fixture cleanup is unconfirmed; its isolated files were retained',
    )
  await rm(root, { recursive: true, force: true })
}
