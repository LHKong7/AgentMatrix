import { describe, expect, it } from 'vitest'
import { captureCommand } from '../src/main/engines/process/capture-command'
import type { ProcessLaunch } from '../src/main/engines/process/managed-process'

function launch(code: string): ProcessLaunch {
  return { executable: process.execPath, args: ['-e', code], cwd: process.cwd(), environment: {} }
}
describe.skipIf(process.platform === 'win32')('private native command readback', () => {
  it('returns complete UTF-8 output and rejects invalid output without echoing diagnostics', async () => {
    const signal = new AbortController().signal
    expect(await captureCommand(launch("process.stdout.write('完整 configuration')"), signal)).toBe(
      '完整 configuration',
    )
    await expect(
      captureCommand(
        launch("process.stdout.write(Buffer.from([255])); process.stderr.write('private-key')"),
        signal,
      ),
    ).rejects.toMatchObject({ code: 'process-exit', message: 'Agent runtime process-exit' })
    await expect(
      captureCommand(launch("process.stderr.write('private-key'); process.exit(2)"), signal),
    ).rejects.toMatchObject({ code: 'process-exit', message: 'Agent runtime process-exit' })
  })
  it('bounds excessive stdout and ends stalled readback at its deadline', async () => {
    const signal = new AbortController().signal
    await expect(
      captureCommand(
        launch("process.stdout.write('x'.repeat(4_194_305)); setInterval(()=>{},1000)"),
        signal,
      ),
    ).rejects.toMatchObject({ code: 'protocol', field: 'readback.size' })
    await expect(
      captureCommand(launch('setInterval(()=>{},1000)'), signal, 50),
    ).rejects.toMatchObject({ code: 'timeout' })
  })
  it('does not launch an already-aborted request and disposes an active readback on abort', async () => {
    const controller = new AbortController()
    const pending = captureCommand(launch('setInterval(()=>{},1000)'), controller.signal)
    controller.abort()
    await expect(pending).rejects.toMatchObject({ code: 'process-exit' })
    await expect(
      captureCommand({ ...launch(''), executable: '/absent/cli' }, controller.signal),
    ).rejects.toMatchObject({ code: 'process-exit' })
  })
})
