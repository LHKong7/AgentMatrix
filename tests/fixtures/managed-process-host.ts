import { ManagedProcess } from '../../src/main/engines/process/managed-process'

const child = new ManagedProcess({
  executable: process.execPath,
  args: [
    '-e',
    `
    const { spawn } = require('node:child_process');
    const worker = spawn(process.execPath, ['-e', "process.on('SIGTERM', () => {}); process.stdout.write(String(process.pid)); setInterval(() => {}, 1000)"], { stdio: ['ignore', 'pipe', 'inherit'] });
    worker.stdout.once('data', value => process.stdout.write(JSON.stringify({ descendant: Number(value), guardian: process.ppid, pid: process.pid })));
    process.stdin.resume();
    setInterval(() => {}, 1000);
  `,
  ],
  cwd: process.cwd(),
  environment: {},
})
await child.ready
const reader = child.stdout.getReader()
const value = await reader.read()
process.send?.({ ...JSON.parse(Buffer.from(value.value!).toString()), observedPid: child.pid })
process.send?.({ result: await child.closed })
