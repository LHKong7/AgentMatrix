import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtemp, mkdir, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { _electron as electron } from 'playwright'
import { openCodeWorkspace } from '../tests/helpers/opencode-fixture.ts'

const engine = process.env.AGENT_MATRIX_SESSION_ENGINE || 'opencode'
assert.ok(['opencode', 'pi'].includes(engine), 'Select opencode or pi')
const isPi = engine === 'pi'
const version = isPi ? '0.85.1' : '1.18.16'
const executable = isPi ? process.env.AGENT_MATRIX_TEST_PI : process.env.AGENT_MATRIX_TEST_OPENCODE
assert.ok(
  executable,
  `Set AGENT_MATRIX_TEST_${isPi ? 'PI' : 'OPENCODE'} to the installed ${engine} ${version} executable`,
)
const root = await realpath(await mkdtemp(join(tmpdir(), 'agentmatrix-desktop-session-')))
const dataDirectory = join(root, 'data'),
  cwd = join(root, 'project'),
  home = join(root, 'home')
await mkdir(dataDirectory)
await mkdir(join(cwd, '.git'), { recursive: true })
await mkdir(home)
await writeFile(join(cwd, 'fixture.txt'), 'SMOKE_FILE_MARKER')
const secret = 'agentmatrix-synthetic-desktop-secret'
let behavior = 'tool',
  streamStarted = false
const calls = []
const server = createServer(async (request, response) => {
  try {
    let body = ''
    for await (const chunk of request) {
      body += String(chunk)
      if (body.length > 2_097_152) throw new Error('Request limit')
    }
    const input = JSON.parse(body)
    const main = input.tools?.some((tool) => tool.function?.name === 'read')
    const read = input.messages.some(
      (message) =>
        message.role === 'tool' && JSON.stringify(message.content).includes('SMOKE_FILE_MARKER'),
    )
    if (main)
      calls.push({
        authenticated: request.headers.authorization === `Bearer ${secret}`,
        model: input.model,
        role: body.includes('NEW_ROLE_MARKER') ? 'new' : 'original',
        read,
      })
    if (!input.stream) {
      response.writeHead(200, { 'Content-Type': 'application/json' })
      response.end(
        JSON.stringify({
          id: 'fixture',
          object: 'chat.completion',
          created: 1,
          model: input.model,
          choices: [
            {
              index: 0,
              message: { role: 'assistant', content: 'Session smoke' },
              finish_reason: 'stop',
            },
          ],
          usage: { prompt_tokens: 10, completion_tokens: 3, total_tokens: 13 },
        }),
      )
      return
    }
    response.writeHead(200, { 'Content-Type': 'text/event-stream' })
    const chunk = (delta, finish_reason = null) =>
      response.write(
        `data: ${JSON.stringify({ id: 'fixture', object: 'chat.completion.chunk', created: 1, model: input.model, choices: [{ index: 0, delta, finish_reason }] })}\n\n`,
      )
    if (main && behavior === 'stream') {
      chunk({ role: 'assistant', content: 'Waiting for cancellation '.repeat(8) })
      streamStarted = true
      return
    }
    if (main && (behavior === 'permission' || (behavior === 'tool' && !read))) {
      chunk({
        role: 'assistant',
        tool_calls: [
          {
            index: 0,
            id: 'read-fixture',
            type: 'function',
            function: {
              name: 'read',
              arguments: JSON.stringify({ [isPi ? 'path' : 'filePath']: join(cwd, 'fixture.txt') }),
            },
          },
        ],
      })
      chunk({}, 'tool_calls')
    } else {
      chunk({ role: 'assistant', content: main ? 'UI_' : 'Session ' })
      chunk({ content: main ? 'REPLY <script>not executable</script>' : 'smoke' })
      chunk({}, 'stop')
    }
    response.end('data: [DONE]\n\n')
  } catch {
    response.writeHead(400)
    response.end('Fixture request rejected')
  }
})
await new Promise((resolve, reject) => {
  server.once('error', reject)
  server.listen(0, '127.0.0.1', resolve)
})
const address = server.address()
assert.ok(address && typeof address !== 'string')
const workspace = openCodeWorkspace(executable, cwd)
if (isPi) {
  workspace.installations[0].kind = 'pi'
  workspace.installations[0].name = 'Pi'
  workspace.agents[0].engineOptions = { kind: 'pi', projectTrust: 'deny', contextFiles: 'inherit' }
  workspace.agents[0].execution.approval = 'unrestricted'
} else workspace.installations[0].prefixArgs = ['--pure']
workspace.installations[0].version = null
workspace.installations[0].probedAt = null
workspace.installations[0].modes = []
workspace.connections[0].baseUrl = `http://127.0.0.1:${address.port}/v1`
workspace.connections[0].auth.secret.name = 'AGENT_MATRIX_SESSION_KEY'
await writeFile(join(dataDirectory, 'workspace.json'), JSON.stringify(workspace))
const env = {
  ...process.env,
  AGENT_MATRIX_DATA_DIR: dataDirectory,
  AGENT_MATRIX_SESSION_KEY: secret,
  HOME: home,
  XDG_CONFIG_HOME: join(home, '.config'),
}
delete env.ELECTRON_RUN_AS_NODE
let app,
  page,
  passed = false
const errors = []
async function launch() {
  app = await electron.launch({ args: ['.'], env, timeout: 30_000 })
  page = await app.firstWindow()
  page.setDefaultTimeout(20_000)
  page.on('pageerror', (error) => errors.push(error.message))
  await page.locator('.card-grid').waitFor()
}
async function language(locale) {
  await page.locator('.language-select select').first().selectOption(locale)
}
async function navigate(label) {
  await page
    .getByRole('navigation')
    .getByRole('button', { name: new RegExp(`^${label}`) })
    .click()
}
async function status(value) {
  const expected = { Ready: 'ready', 就绪: 'ready', Interrupted: 'interrupted', Closed: 'closed' }[
    value
  ]
  await page.waitForFunction(
    async (status) => {
      const sessionId = document.querySelector('.conversation')?.getAttribute('data-session-id')
      return sessionId && (await window.agentMatrix.sessions.get({ sessionId })).status === status
    },
    expected,
    { timeout: 45_000 },
  )
  await page
    .getByTestId('session-status')
    .filter({ hasText: new RegExp(`^${value}$`) })
    .waitFor({ timeout: 45_000 })
}
async function send(text) {
  const sessionId = await page.locator('.conversation').getAttribute('data-session-id')
  const before = await page.evaluate(
    (id) => window.agentMatrix.sessions.get({ sessionId: id }),
    sessionId,
  )
  await page.getByRole('textbox', { name: 'Message', exact: true }).fill(text)
  await page.getByRole('button', { name: 'Send message', exact: true }).click()
  await page.waitForFunction(
    async ({ id, cursor }) =>
      (await window.agentMatrix.sessions.get({ sessionId: id })).cursor > cursor,
    { id: sessionId, cursor: before.cursor },
  )
}
const sessions = () => page.evaluate(() => window.agentMatrix.sessions.list())
try {
  await launch()
  await language('en')
  await navigate('Engines')
  await page.getByRole('button', { name: 'Check installation', exact: true }).click()
  await page.waitForFunction(
    async (version) =>
      (await window.agentMatrix.loadWorkspace()).installations[0].version === version,
    version,
  )
  await navigate('Sessions')
  await page.getByRole('button', { name: 'Start new session', exact: true }).click()
  await status('Ready')
  const original = (await sessions())[0]
  assert.ok(original.nativeSessionId)
  await send(`Read fixture.txt. Synthetic key: ${secret}`)
  if (!isPi) await page.locator('.permission-card').waitFor()
  else await status('Ready')
  await language('zh-CN')
  await page.getByRole('heading', { name: '会话', exact: true }).waitFor()
  if (process.env.AGENT_MATRIX_SESSION_SCREENSHOT)
    await page.screenshot({ path: process.env.AGENT_MATRIX_SESSION_SCREENSHOT, fullPage: true })
  if (!isPi) await page.getByRole('button', { name: /^允许一次/ }).click()
  await status('就绪')
  assert.equal(
    await page.locator('.message.assistant pre').textContent(),
    'UI_REPLY <script>not executable</script>',
  )
  assert.equal(await page.locator('.transcript script').count(), 0)
  await language('en')
  const history = await page.evaluate(
    (sessionId) =>
      window.agentMatrix.sessions.readEvents({ sessionId, afterCursor: 0, limit: 500 }),
    original.id,
  )
  assert.ok(!JSON.stringify(history).includes(secret))
  const requestsBeforeReload = calls.length
  await page.reload()
  await page.locator('.card-grid').waitFor()
  await navigate('Sessions')
  await status('Ready')
  assert.equal(await page.locator('.message.assistant pre').count(), 1)
  assert.equal(calls.length, requestsBeforeReload)
  behavior = 'stream'
  await send('WAIT_STREAM')
  const streamDeadline = Date.now() + 20_000
  while (!streamStarted && Date.now() < streamDeadline)
    await new Promise((resolve) => setTimeout(resolve, 25))
  assert.ok(streamStarted, 'The fixture did not receive the streaming turn')
  await page.getByRole('button', { name: 'Cancel turn', exact: true }).click()
  await status('Ready')
  if (!isPi) {
    behavior = 'permission'
    await send('Read fixture.txt again')
    await page.locator('.permission-card').waitFor()
    await page.getByRole('button', { name: 'Cancel turn', exact: true }).click()
    await status('Ready')
    assert.equal(await page.locator('.permission-card').count(), 0)
  }
  behavior = 'text'
  await navigate('Shared prompts')
  await page.getByRole('button', { name: 'Edit Role', exact: true }).click()
  await page.getByLabel('Prompt content', { exact: true }).fill('You are a probe. NEW_ROLE_MARKER.')
  await page.getByRole('button', { name: 'Save configuration', exact: true }).click()
  await page.getByRole('dialog').waitFor({ state: 'hidden' })
  await navigate('Sessions')
  await status('Ready')
  await send('Keep using the captured role')
  await status('Ready')
  assert.equal(calls.at(-1).role, 'original')
  await page.getByRole('button', { name: 'Start new session', exact: true }).click()
  await page.waitForFunction(async () => (await window.agentMatrix.sessions.list()).length === 2)
  await status('Ready')
  await send('Use the newly saved role')
  await status('Ready')
  assert.equal(calls.at(-1).role, 'new')
  const latest = (await sessions()).find((session) => session.id !== original.id)
  assert.ok(latest)
  await app.close()
  app = null
  await launch()
  await language('en')
  await navigate('Sessions')
  await status('Interrupted')
  await page.getByRole('button', { name: 'Resume session', exact: true }).click()
  await status('Ready')
  const resumed = (await sessions()).find((session) => session.id === latest.id)
  assert.equal(resumed.nativeSessionId, latest.nativeSessionId)
  assert.notEqual(resumed.runId, latest.runId)
  await send('Continue the saved session')
  await status('Ready')
  await page.getByRole('button', { name: 'Close session', exact: true }).click()
  await status('Closed')
  assert.ok(
    calls.length > 5 && calls.every((call) => call.authenticated && call.model === 'fixture-model'),
  )
  assert.deepEqual(errors, [])
  passed = true
  const report = {
    checkedAt: new Date().toISOString(),
    platform: process.platform,
    architecture: process.arch,
    engine,
    version,
    route: 'Local Chat Completions protocol fixture',
    externalProviderCalls: false,
    desktopVersionProbe: true,
    profileToSession: true,
    permissionReply: isPi ? 'unsupported: no universal per-tool approval' : true,
    toolResult: calls.some((call) => call.read),
    rendererReloadWithoutResubmit: true,
    streamingCancellation: true,
    permissionCancellation: isPi ? 'unsupported: no universal per-tool approval' : true,
    sharedPromptOldAndNewSnapshots: true,
    appQuitAndRestart: true,
    nativeResume: true,
    confirmedClose: true,
    englishAndChinese: true,
    journalCredentialRedaction: true,
    untrustedTextEscaped: true,
  }
  if (process.env.AGENT_MATRIX_SESSION_REPORT)
    await writeFile(process.env.AGENT_MATRIX_SESSION_REPORT, JSON.stringify(report, null, 2) + '\n')
  console.log('Desktop session smoke passed:', JSON.stringify(report))
} catch (error) {
  if (page && !page.isClosed()) {
    await page
      .screenshot({ path: '/private/tmp/agentmatrix-session-failure.png', fullPage: true })
      .catch(() => {})
    console.error('Session states:', JSON.stringify(await sessions().catch(() => [])))
  }
  console.error('Session smoke artifacts retained at:', root)
  throw error
} finally {
  await app?.close()
  server.closeAllConnections()
  await new Promise((resolve) => server.close(resolve))
  if (passed) await rm(root, { recursive: true, force: true })
}
