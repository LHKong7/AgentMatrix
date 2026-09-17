import { afterEach, describe, expect, it } from 'vitest'
import { startProbe } from '../scripts/lib/stdio-probe.mjs'

const probes: ReturnType<typeof startProbe>[] = []
function fixture(script: string, timeoutMs = 2000) {
  const probe = startProbe(process.execPath, ['-e', script], {
    cwd: process.cwd(),
    env: {},
    timeoutMs,
  })
  probes.push(probe)
  return probe
}
afterEach(async () => {
  await Promise.all(probes.splice(0).map((probe) => probe.stop()))
})

describe('isolated engine discovery transport', () => {
  it('correlates out-of-order responses and preserves UTF-8 across chunks and Unicode separators', async () => {
    const probe = fixture(`
      let buffer = '', messages = [];
      process.stdin.on('data', chunk => {
        buffer += chunk;
        let index;
        while ((index = buffer.indexOf('\\n')) >= 0) {
          messages.push(JSON.parse(buffer.slice(0,index))); buffer = buffer.slice(index+1);
        }
        if (messages.length === 2) {
          const data = Buffer.from(messages.reverse().map(({id}) => JSON.stringify({id,result:'汉\\u2028字\\u2029'})+'\\r\\n').join(''));
          for (const byte of data) process.stdout.write(Buffer.from([byte]));
          messages = [];
        }
      });
    `)
    const [one, two] = await Promise.all([
      probe.request({ type: 'first' }),
      probe.request({ type: 'second' }),
    ])
    expect(one).toEqual({ id: 1, result: '汉\u2028字\u2029' })
    expect(two).toEqual({ id: 2, result: '汉\u2028字\u2029' })
  })

  it('does not approve incoming agent requests during a discovery probe', async () => {
    const probe = fixture(`
      let buffer = '', outgoing;
      process.stdin.on('data', chunk => {
        buffer += chunk;
        let i;
        while((i = buffer.indexOf('\\n')) >= 0) {
          const message = JSON.parse(buffer.slice(0,i)); buffer = buffer.slice(i+1);
          if(message.method) {
            outgoing = message.id;
            process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:99,method:'session/request_permission',params:{}})+'\\n');
          } else {
            process.stdout.write(JSON.stringify({id:outgoing,result:message})+'\\n');
          }
        }
      });
    `)
    const result = await probe.request({ method: 'initialize' })
    expect(result.result).toMatchObject({ id: 99, error: { code: -32601 } })
  })

  it('bounds unanswered requests and cleans up a live process', async () => {
    const probe = fixture('process.stdin.resume()', 50)
    await expect(probe.request({ method: 'unknown' })).rejects.toThrow('timed out')
    await expect(probe.stop()).resolves.toMatchObject({ stderr: '' })
  })

  it.each([
    ["process.stdout.write('not json\\n')", 'Non-JSON'],
    ["process.stdout.write('x'.repeat(2_100_000))", 'exceeded limit'],
    ['process.exit(7)', 'Process exited'],
  ])('rejects broken engine output and exits: %s', async (script, error) => {
    const probe = fixture(`process.stdin.once('data', () => { ${script} })`)
    await expect(probe.request({ method: 'initialize' })).rejects.toThrow(error)
  })
})
