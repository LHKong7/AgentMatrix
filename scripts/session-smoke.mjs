import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import {
  mkdtemp,
  mkdir,
  lstat,
  realpath,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { _electron as electron } from 'playwright'
import { openCodeWorkspace } from '../tests/helpers/opencode-fixture.ts'

const engine = process.env.AGENT_MATRIX_SESSION_ENGINE || 'opencode'
assert.ok(['opencode', 'pi', 'dsh'].includes(engine), 'Select opencode, pi, or dsh')
const isPi = engine === 'pi'
const isDsh = engine === 'dsh'
const version = isPi ? '0.85.1' : isDsh ? '0.1.5-rc.2' : '1.18.16'
const executable = process.env[`AGENT_MATRIX_TEST_${engine.toUpperCase()}`]
assert.ok(
  executable,
  `Set AGENT_MATRIX_TEST_${engine.toUpperCase()} to the installed ${engine} ${version} executable`,
)
const root = await realpath(await mkdtemp(join(tmpdir(), 'agentmatrix-desktop-session-')))
const dataDirectory = join(root, 'data'),
  cwd = join(root, 'project'),
  alternateCwd = join(root, '项目 with spaces'),
  home = join(root, 'home')
await mkdir(dataDirectory)
await mkdir(join(cwd, '.git'), { recursive: true })
await mkdir(join(alternateCwd, '.git'), { recursive: true })
await mkdir(home)
if (!isPi && !isDsh) {
  for (const directory of [cwd, alternateCwd]) {
    await mkdir(join(directory, '.opencode/agents'), { recursive: true })
    await writeFile(
      join(directory, '.opencode/agents/matrix-observed.md'),
      '---\ndescription: Native resource inventory fixture\nmode: subagent\n---\nPRIVATE_NATIVE_RESOURCE_BODY\n',
    )
  }
}
await writeFile(join(cwd, 'fixture.txt'), 'SMOKE_FILE_MARKER')
await writeFile(join(alternateCwd, 'fixture.txt'), 'SMOKE_FILE_MARKER_ALTERNATE')
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
        plugin: body.includes('DESKTOP_PLUGIN_MARKER'),
        directoryRead: read
          ? body.includes('SMOKE_FILE_MARKER_ALTERNATE')
            ? 'alternate'
            : 'default'
          : null,
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
              arguments: JSON.stringify({
                [isPi ? 'path' : isDsh ? 'file_path' : 'filePath']: 'fixture.txt',
              }),
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
  const path = join(root, 'desktop-pi-extension.ts')
  await writeFile(
    path,
    `export default (pi) => {
    pi.on('before_agent_start', (event) => ({systemPrompt: event.systemPrompt + '\\nDESKTOP_PLUGIN_MARKER'}));
    pi.registerCommand('desktop-confirm', {description:'Desktop confirmation', async handler(_args, ctx) {
      const accepted = await ctx.ui.confirm('Desktop extension', 'Continue?');
      ctx.ui.notify(accepted ? 'DESKTOP_EXTENSION_CONFIRMED' : 'DESKTOP_EXTENSION_CANCELLED', 'info');
    }});
    pi.on('input', (event) => event.text === 'DESKTOP_HANDLE_WITHOUT_MODEL' ? {action:'handled'} : {action:'continue'});
  };\n`,
  )
  workspace.nativePlugins = [
    {
      id: 'desktop-extension',
      name: 'Desktop extension',
      nativeId: 'desktop-extension',
      engineInstallationId: 'oc',
      version: 'fixture',
      source: 'local desktop fixture',
      path,
    },
  ]
  workspace.agents[0].nativePluginIds = ['desktop-extension']
} else if (isDsh) {
  workspace.installations[0].kind = 'deepseek-harness'
  workspace.installations[0].name = 'DeepSeek Harness'
  workspace.agents[0].engineOptions = {
    kind: 'deepseek-harness',
    profileTemplate: 'acp',
    patchReload: 'startup',
  }
  workspace.agents[0].promptBindings[0].mode = 'append'
  const path = join(root, 'desktop-dsh-plugin.cjs')
  await writeFile(
    path,
    `exports.inject=['systemPrompt'];
exports.Config={'~standard':{version:1,vendor:'fixture',validate:value=>typeof value?.marker==='string'?{value}:{issues:[{message:'marker required'}]}}};
exports.apply=(ctx,config)=>ctx.systemPrompt.section({name:'desktop-plugin',order:900,text:config.marker});
`,
  )
  workspace.nativePlugins = [
    {
      id: 'desktop-plugin',
      name: 'Desktop DSH plugin',
      nativeId: 'desktop-plugin',
      engineInstallationId: 'oc',
      version: 'fixture',
      source: 'local desktop fixture',
      path,
      options: { kind: 'deepseek-harness', config: { marker: 'DESKTOP_PLUGIN_MARKER' } },
    },
  ]
  workspace.agents[0].nativePluginIds = ['desktop-plugin']
} else {
  const path = join(root, 'desktop-plugin.mjs')
  await writeFile(
    path,
    `export default { id: 'desktop-plugin', async server() { return Object.freeze({
    'experimental.chat.system.transform'(_input, output) { output.system.push('DESKTOP_PLUGIN_MARKER'); }
  }); } };\n`,
  )
  workspace.nativePlugins = [
    {
      id: 'desktop-plugin',
      name: 'Desktop plugin',
      nativeId: 'desktop-plugin',
      engineInstallationId: 'oc',
      version: 'fixture',
      source: 'local desktop fixture',
      path,
    },
  ]
  workspace.agents[0].nativePluginIds = ['desktop-plugin']
}
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
// waitForFunction treats a returned Promise as truthy. Poll awaited IPC results in the test process.
async function waitForIpc(check, label, timeout = 45_000) {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    if (await check()) return
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  throw new Error(`Timed out waiting for ${label}`)
}
async function status(value) {
  const expected = {
    Ready: 'ready',
    就绪: 'ready',
    Interrupted: 'interrupted',
    Closed: 'closed',
    Failed: 'failed',
  }[value]
  await waitForIpc(
    () =>
      page.evaluate(async (status) => {
        const sessionId = document.querySelector('.conversation')?.getAttribute('data-session-id')
        return sessionId && (await window.agentMatrix.sessions.get({ sessionId })).status === status
      }, expected),
    `session status ${expected}`,
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
  // A user-message acknowledgment can advance the cursor while the old Ready state is still visible.
  // Wait for this turn to start (or finish quickly) before checking Ready or provider evidence.
  await waitForIpc(
    () =>
      page.evaluate(
        async ({ id, cursor, priorTurn }) => {
          const state = await window.agentMatrix.sessions.get({ sessionId: id })
          return (
            state.cursor > cursor &&
            ((state.activeTurn && state.activeTurn.id !== priorTurn) ||
              (state.lastTurn && state.lastTurn.id !== priorTurn))
          )
        },
        { id: sessionId, cursor: before.cursor, priorTurn: before.lastTurn?.id ?? null },
      ),
    'submitted turn',
  )
}
const sessions = () => page.evaluate(() => window.agentMatrix.sessions.list())
// Substitute only the OS chooser; directory validation and all IPC/launch behavior stay real.
async function chooseWorkingDirectory(path) {
  await app.evaluate(({ dialog }, selected) => {
    const original = dialog.showOpenDialog
    dialog.showOpenDialog = async () => {
      dialog.showOpenDialog = original
      return { canceled: selected === null, filePaths: selected === null ? [] : [selected] }
    }
  }, path)
}
async function chooseHistoryDestination(path) {
  await app.evaluate(({ dialog }, selected) => {
    const original = dialog.showSaveDialog
    dialog.showSaveDialog = async () => {
      dialog.showSaveDialog = original
      return { canceled: selected === null, filePath: selected ?? undefined }
    }
  }, path)
}
async function historyPageReady(dialog, expectedFirst, expectedLast) {
  await waitForIpc(async () => {
    if ((await dialog.locator('.session-history').getAttribute('aria-busy')) !== 'false')
      return false
    const first = Number(await dialog.locator('.history-range').getAttribute('data-history-first'))
    const last = Number(await dialog.locator('.history-range').getAttribute('data-history-last'))
    return (
      (expectedFirst === undefined || first === expectedFirst) &&
      (expectedLast === undefined || last === expectedLast)
    )
  }, 'history page')
}
async function verifyLongHistory(sourceId) {
  // A separate closed fixture exercises the renderer cap without issuing thousands of model turns.
  // Its starting events come from the native run; added message fragments are explicitly synthetic.
  const source = (await readFile(join(dataDirectory, 'sessions', `${sourceId}.jsonl`), 'utf8'))
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line))
  const archiveId = 'history-fixture'
  const records = [structuredClone(source[0])]
  records[0].snapshot.id = archiveId
  delete records[0].snapshot.creationReceipt
  let inserted = false
  for (const record of source.slice(1)) {
    const event = { ...record.event, sessionId: archiveId, cursor: records.length }
    delete event.receipt
    records.push({ kind: 'event', event })
    if (!inserted && event.data.kind === 'turn.started') {
      inserted = true
      for (let n = 0; n < 1005; n++)
        records.push({
          kind: 'event',
          event: {
            ...event,
            cursor: records.length,
            data: {
              kind: 'message.delta',
              messageId: 'long-history',
              channel: 'assistant',
              text: `历史片段-${n}\n`,
            },
          },
        })
    }
  }
  assert.ok(inserted)
  const runId = records.at(-1).event.runId
  for (const kind of ['session.closing', 'session.closed'])
    records.push({
      kind: 'event',
      event: {
        sessionId: archiveId,
        cursor: records.length,
        timestamp: new Date().toISOString(),
        runId,
        turnId: null,
        data: { kind },
      },
    })
  const throughCursor = records.length - 1
  const archivePath = join(dataDirectory, 'sessions', `${archiveId}.jsonl`)
  const archiveBytes = records.map((record) => JSON.stringify(record)).join('\n') + '\n'
  await writeFile(archivePath, archiveBytes)
  const beforeCalls = calls.length
  await page.getByRole('button', { name: 'Refresh sessions', exact: true }).click()
  await page.locator(`[data-session-list-id="${archiveId}"]`).click()
  await status('Closed')
  await page.getByText(/Showing the most recent .* events/).waitFor()
  await page
    .locator('.conversation-header')
    .getByRole('button', { name: 'Session history', exact: true })
    .click()
  const dialog = page.getByRole('dialog')
  await historyPageReady(dialog)
  assert.ok(Number(await dialog.locator('.history-range').getAttribute('data-history-first')) > 1)
  await dialog.getByRole('button', { name: 'Beginning', exact: true }).click()
  await historyPageReady(dialog, 1)
  await dialog
    .getByText(/Already redacted|Synthetic key:/)
    .first()
    .waitFor()
  assert.ok(!(await dialog.textContent()).includes(secret))
  assert.equal(await dialog.locator('script').count(), 0)
  assert.equal(await dialog.locator('.permission-card').count(), 0)
  if (process.env.AGENT_MATRIX_HISTORY_SCREENSHOT)
    await page.screenshot({ path: process.env.AGENT_MATRIX_HISTORY_SCREENSHOT, fullPage: true })
  await dialog.getByRole('button', { name: 'Close', exact: true }).last().click()
  await language('zh-CN')
  await page
    .locator('.conversation-header')
    .getByRole('button', { name: '会话历史', exact: true })
    .click()
  await historyPageReady(dialog)
  await dialog.getByRole('button', { name: '最早记录', exact: true }).click()
  await historyPageReady(dialog, 1)
  await dialog.getByRole('heading', { name: '会话历史', exact: true }).waitFor()
  await dialog.getByRole('button', { name: '导出历史（JSONL）', exact: true }).waitFor()
  if (process.env.AGENT_MATRIX_HISTORY_SCREENSHOT)
    await page.screenshot({
      path: process.env.AGENT_MATRIX_HISTORY_SCREENSHOT + '.zh.png',
      fullPage: true,
    })
  await dialog.getByRole('button', { name: '关闭', exact: true }).last().click()
  await language('en')
  await page
    .locator('.conversation-header')
    .getByRole('button', { name: 'Session history', exact: true })
    .click()
  await historyPageReady(dialog)
  await dialog.getByRole('button', { name: 'Beginning', exact: true }).click()
  await historyPageReady(dialog, 1)
  let last = 0
  while (last < throughCursor) {
    const first = Number(await dialog.locator('.history-range').getAttribute('data-history-first'))
    assert.equal(first, last + 1)
    last = Number(await dialog.locator('.history-range').getAttribute('data-history-last'))
    if (last < throughCursor) {
      await dialog.getByRole('button', { name: 'Later', exact: true }).click()
      await historyPageReady(dialog, last + 1)
    }
  }
  const earlierEnd =
    Number(await dialog.locator('.history-range').getAttribute('data-history-first')) - 1
  await dialog.getByRole('button', { name: 'Earlier', exact: true }).click()
  await historyPageReady(dialog, undefined, earlierEnd)
  assert.ok(
    Number(await dialog.locator('.history-range').getAttribute('data-history-last')) <
      throughCursor,
  )
  await chooseHistoryDestination(null)
  await dialog.getByRole('button', { name: 'Export history (JSONL)', exact: true }).click()
  await historyPageReady(dialog)
  assert.equal(await dialog.locator('.history-exported').count(), 0)
  const target = join(root, 'exported-history.jsonl')
  await writeFile(target, 'previous export')
  await chooseHistoryDestination(target)
  await dialog.getByRole('button', { name: 'Export history (JSONL)', exact: true }).click()
  await dialog.locator('.history-exported').waitFor()
  const exported = await readFile(target, 'utf8')
  const output = exported
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line))
  assert.equal(output.length, throughCursor + 1)
  assert.equal(output[0].throughCursor, throughCursor)
  assert.ok(!exported.includes(secret))
  assert.ok(!exported.includes('receipt'))
  assert.equal(output[0].session.id, archiveId)
  assert.deepEqual(output.slice(1), records.slice(1))
  assert.equal(await readFile(archivePath, 'utf8'), archiveBytes)
  assert.equal(calls.length, beforeCalls)
  await dialog.getByRole('button', { name: 'Close', exact: true }).last().click()
  await page.reload()
  await page.locator('.card-grid').waitFor()
  await navigate('Sessions')
  await status('Closed')
  await page
    .locator('.conversation-header')
    .getByRole('button', { name: 'Session history', exact: true })
    .click()
  await historyPageReady(page.getByRole('dialog'))
  assert.equal(
    Number(
      await page.getByRole('dialog').locator('.history-range').getAttribute('data-history-through'),
    ),
    throughCursor,
  )
  await page.getByRole('dialog').getByRole('button', { name: 'Close', exact: true }).last().click()
}
async function configurationReport(title = 'Configuration report', close = 'Close') {
  await page.getByRole('button', { name: title, exact: true }).click()
  const dialog = page.getByRole('dialog')
  await dialog.locator('[data-report-field="model"]').waitFor()
  assert.ok(!(await dialog.textContent()).includes(secret))
  const value = await page.evaluate(async () => {
    const sessionId = document.querySelector('.conversation').getAttribute('data-session-id')
    return window.agentMatrix.sessions.configuration({ sessionId })
  })
  if (value.diagnostic) {
    const diagnostic = dialog.locator(`[data-configuration-check="${value.diagnostic.check}"]`)
    await diagnostic.waitFor()
    assert.ok(!(await dialog.textContent()).includes('PRIVATE_DIAGNOSTIC_MARKER'))
    if (process.env.AGENT_MATRIX_DIAGNOSTIC_SCREENSHOT) {
      await diagnostic.scrollIntoViewIfNeeded()
      await page.screenshot({
        path:
          process.env.AGENT_MATRIX_DIAGNOSTIC_SCREENSHOT +
          (title === '配置报告' ? '.zh.png' : '.en.png'),
      })
    }
  }
  assert.equal(value.fields.find((field) => field.id === 'model').status, 'observed')
  assert.equal(value.fields.find((field) => field.id === 'plugins').status, 'observed')
  const skillSource = isPi ? 'pi-rpc' : isDsh ? 'dsh-registry' : 'opencode-acp'
  const skills = value.assets.filter((asset) => asset.kind === 'skill')
  assert.ok(skills.length > 0)
  assert.ok(skills.every((asset) => asset.nativeSourceVerification === skillSource))
  assert.ok(skills.every((asset) => /^skills\/[^/]+\/SKILL\.md$/.test(asset.nativeEntry)))
  await dialog.locator(`[data-skill-source="${skillSource}"]`).first().waitFor()
  assert.ok(
    value.observation.checks.includes(
      isPi ? 'pi.skill-sources' : isDsh ? 'dsh.skill-sources' : 'opencode.instance-skills',
    ),
  )
  if (process.env.AGENT_MATRIX_SKILL_SOURCE_SCREENSHOT) {
    await dialog.locator(`[data-skill-source="${skillSource}"]`).first().scrollIntoViewIfNeeded()
    await page.screenshot({
      path:
        process.env.AGENT_MATRIX_SKILL_SOURCE_SCREENSHOT +
        (title === '配置报告' ? '.zh.png' : '.en.png'),
    })
  }
  assert.ok(
    value.observation.checks.includes(
      isPi ? 'pi.plugins' : isDsh ? 'dsh.plugins' : 'opencode.plugins',
    ),
  )
  const capabilities = value.capabilities
  assert.equal(capabilities.contractMatches, true)
  assert.equal(capabilities.current, value.observationIsCurrent)
  assert.equal(capabilities.identity.snapshotDigest, value.snapshotDigest)
  assert.equal(capabilities.identity.runId, value.observation.runId)
  assert.equal(capabilities.identity.nativeSessionId, value.nativeSessionId)
  assert.equal(capabilities.capabilities.length, 18)
  for (const feature of [
    'session-protocol',
    'model-selection',
    'connection-mapping',
    'credential-resolution',
    'plugin-activation',
  ]) {
    const row = capabilities.capabilities.find((item) => item.feature === feature)
    assert.equal(row.verification, 'passed', feature)
    assert.equal(row.availability, capabilities.current ? 'ready' : 'unknown', feature)
  }
  for (const feature of [
    'model-service',
    'mcp-connectivity',
    'prompt-loading',
    'policy-enforcement',
  ])
    assert.equal(
      capabilities.capabilities.find((item) => item.feature === feature).verification,
      'untested',
      feature,
    )
  await dialog.locator('.session-capabilities > summary').click()
  const table = dialog.getByRole('table', {
    name: title === '配置报告' ? '原生能力证据' : 'Native capability evidence',
    exact: true,
  })
  await table
    .locator('[data-session-capability="session-protocol"][data-verification="passed"]')
    .waitFor()
  assert.equal(await table.locator('[data-session-capability]').count(), 18)
  await table.locator('[data-session-capability="native-restore"]').scrollIntoViewIfNeeded()
  if (process.env.AGENT_MATRIX_CAPABILITY_SCREENSHOT)
    await page.screenshot({
      path:
        process.env.AGENT_MATRIX_CAPABILITY_SCREENSHOT +
        (title === '配置报告' ? '.zh.png' : '.en.png'),
    })
  if (process.env.AGENT_MATRIX_REPORT_SCREENSHOT)
    await page.screenshot({
      path: process.env.AGENT_MATRIX_REPORT_SCREENSHOT + (title === '配置报告' ? '.zh.png' : ''),
      fullPage: true,
    })
  await dialog.locator('.native-resource-sources > summary').click()
  if (!isPi && !isDsh) {
    const directory = value.resourceDirectories.find(
      (item) => item.path === join(value.cwd, '.opencode/agents'),
    )
    assert.ok(directory?.exists)
    assert.equal(directory.kind, 'opencode-agent')
    assert.deepEqual(
      directory.files.map((file) => file.path),
      [join(directory.path, 'matrix-observed.md')],
    )
    assert.match(directory.files[0].digest, /^[a-f0-9]{64}$/)
    const row = dialog.locator(`[data-resource-directory="${directory.path}"]`)
    await row.locator('summary').click()
    await row.locator('li code').waitFor({ state: 'visible' })
    assert.ok(!(await dialog.textContent()).includes('PRIVATE_NATIVE_RESOURCE_BODY'))
    await row.scrollIntoViewIfNeeded()
  } else {
    assert.equal(value.resourceDirectories, null)
    await dialog
      .getByText(
        title === '配置报告'
          ? '此快照没有原生资源目录清单，来源覆盖仍不完整。'
          : 'This snapshot has no native resource directory inventory. Coverage remains partial.',
        { exact: true },
      )
      .waitFor()
  }
  if (process.env.AGENT_MATRIX_RESOURCE_SCREENSHOT)
    await page.screenshot({
      path:
        process.env.AGENT_MATRIX_RESOURCE_SCREENSHOT +
        (title === '配置报告' ? '.zh.png' : '.en.png'),
    })
  await dialog.getByRole('button', { name: close, exact: true }).last().click()
  return value
}

async function verifyRetention(original, latest) {
  const beforeCalls = calls.length
  const workspace = await page.evaluate(() => window.agentMatrix.loadWorkspace())
  const exported = await readFile(join(root, 'exported-history.jsonl'))
  const originalRoot = join(dataDirectory, 'runs', original.snapshotId)
  const latestRoot = join(dataDirectory, 'runs', latest.snapshotId)
  const originalJournal = join(dataDirectory, 'sessions', `${original.id}.jsonl`)
  const creation = JSON.parse((await readFile(originalJournal, 'utf8')).split('\n')[0]).snapshot
    .creationReceipt
  const current = (await sessions()).find((item) => item.id === original.id)
  assert.notEqual(current.status, 'closed')
  assert.match(
    await page.evaluate(
      async (input) => {
        try {
          await window.agentMatrix.sessions.remove(input)
          return 'unexpected success'
        } catch (error) {
          return String(error)
        }
      },
      { sessionId: current.id, expectedCursor: current.cursor },
    ),
    /sessionState/,
  )
  await language('en')
  await page.locator(`[data-session-list-id="${original.id}"]`).click()
  await page.getByRole('button', { name: 'Close session', exact: true }).click()
  await status('Closed')
  const beforeCancel = await readFile(originalJournal)
  page.once('dialog', (dialog) => dialog.dismiss())
  await page.getByRole('button', { name: 'Delete conversation', exact: true }).click()
  assert.deepEqual(await readFile(originalJournal), beforeCancel)
  assert.deepEqual(await page.evaluate(() => window.agentMatrix.sessions.pendingRemovals()), [])

  // The synthetic history archive references the native original's exact capture.
  await page.locator('[data-session-list-id="history-fixture"]').click()
  await status('Closed')
  let confirmation = ''
  page.once('dialog', (dialog) => {
    confirmation = dialog.message()
    return dialog.accept()
  })
  await page.getByRole('button', { name: 'Delete conversation', exact: true }).click()
  await waitForIpc(
    async () => !(await sessions()).some((item) => item.id === 'history-fixture'),
    'shared capture deletion',
  )
  assert.match(confirmation, /captured inputs and native state/)
  assert.ok((await stat(originalRoot)).isDirectory())
  await assert.rejects(readFile(join(dataDirectory, 'sessions/history-fixture.jsonl')), {
    code: 'ENOENT',
  })

  await page.locator(`[data-session-list-id="${latest.id}"]`).click()
  await status('Closed')
  await language('zh-CN')
  page.once('dialog', (dialog) => {
    confirmation = dialog.message()
    return dialog.accept()
  })
  await page.getByRole('button', { name: '删除会话', exact: true }).click()
  await waitForIpc(
    async () => !(await sessions()).some((item) => item.id === latest.id),
    'native state deletion',
  )
  assert.match(confirmation, /输入快照和原生状态/)
  await assert.rejects(stat(latestRoot), { code: 'ENOENT' })
  await assert.rejects(readFile(join(dataDirectory, 'sessions', `${latest.id}.jsonl`)), {
    code: 'ENOENT',
  })

  await language('en')
  await page.locator(`[data-session-list-id="${original.id}"]`).click()
  await status('Closed')
  // A substituted root must not traverse into the project; leave an authorized pending job.
  const heldRoot = `${originalRoot}.held`
  await rename(originalRoot, heldRoot)
  await symlink(cwd, originalRoot)
  page.once('dialog', (dialog) => dialog.accept())
  await page.getByRole('button', { name: 'Delete conversation', exact: true }).click()
  await waitForIpc(
    async () =>
      (await page.evaluate(() => window.agentMatrix.sessions.pendingRemovals())).length === 1,
    'pending cleanup',
  )
  await page.getByRole('button', { name: 'Retry cleanup', exact: true }).click()
  await page
    .getByRole('alert')
    .filter({ hasText: 'Deletion was confirmed, but local cleanup could not finish.' })
    .waitFor()
  assert.equal((await page.evaluate(() => window.agentMatrix.sessions.pendingRemovals())).length, 1)
  for (const locale of ['en', 'zh-CN']) {
    await language(locale)
    await page
      .getByRole('button', { name: new RegExp(locale === 'en' ? '^Retry cleanup' : '^重试清理') })
      .waitFor()
    if (process.env.AGENT_MATRIX_RETENTION_SCREENSHOT)
      await page.screenshot({
        path:
          process.env.AGENT_MATRIX_RETENTION_SCREENSHOT + (locale === 'en' ? '.en.png' : '.zh.png'),
      })
  }
  assert.equal(await readFile(join(cwd, 'fixture.txt'), 'utf8'), 'SMOKE_FILE_MARKER')
  await app.close()
  app = null
  await rm(originalRoot)
  await rename(heldRoot, originalRoot)
  await launch()
  await language('en')
  await navigate('Sessions')
  await waitForIpc(
    async () =>
      (await page.evaluate(() => window.agentMatrix.sessions.pendingRemovals())).length === 0,
    'startup cleanup completion',
  )
  assert.deepEqual(await page.evaluate(() => window.agentMatrix.sessions.pendingRemovals()), [])
  assert.ok(
    !(await sessions()).some((item) =>
      [original.id, latest.id, 'history-fixture'].includes(item.id),
    ),
  )
  await assert.rejects(stat(originalRoot), { code: 'ENOENT' })
  await assert.rejects(readFile(originalJournal), { code: 'ENOENT' })
  const tombstone = JSON.parse(
    await readFile(join(dataDirectory, 'sessions', `.deleted-${original.id}.json`), 'utf8'),
  )
  assert.deepEqual(Object.keys(tombstone).sort(), [
    'expectedCursor',
    'sessionId',
    'snapshotId',
    'version',
  ])
  assert.match(
    await page.evaluate(
      async (input) => {
        try {
          await window.agentMatrix.sessions.command(input)
          return 'unexpected success'
        } catch (error) {
          return String(error)
        }
      },
      { kind: 'create', commandId: creation.id, agentId: original.agentId },
    ),
    /sessionDeleted/,
  )
  const after = await page.evaluate(() => window.agentMatrix.loadWorkspace())
  assert.deepEqual(after, workspace)
  assert.deepEqual(await readFile(join(root, 'exported-history.jsonl')), exported)
  assert.equal(await readFile(join(cwd, 'fixture.txt'), 'utf8'), 'SMOKE_FILE_MARKER')
  assert.equal(calls.length, beforeCalls)
}

async function verifyUnusedRunData() {
  const beforeCalls = calls.length
  const beforeWorkspace = await page.evaluate(() => window.agentMatrix.loadWorkspace())
  const retained = (await sessions()).map((session) => session.id).sort()
  const create = { kind: 'create', commandId: `unused-data-${engine}`, agentId: 'reviewer' }
  const orphan = await page.evaluate(
    (command) => window.agentMatrix.sessions.command(command),
    create,
  )
  await app.close()
  app = null
  // Reproduce a published capture whose journal publication did not survive interruption.
  await rm(join(dataDirectory, 'sessions', `${orphan.id}.jsonl`))
  const runs = join(dataDirectory, 'runs'),
    capture = join(runs, orphan.snapshotId)
  const stageId = crypto.randomUUID(),
    stage = join(runs, `.stage-${stageId}`)
  await mkdir(stage)
  await writeFile(join(stage, 'partial'), 'PRIVATE_ABANDONED_INPUT')
  await symlink(cwd, join(stage, 'external-project'))
  await mkdir(join(runs, 'unrecognized-entry'))
  await launch()
  await navigate('Sessions')
  const open = async (locale = 'en') => {
    await language(locale)
    await page
      .getByRole('button', {
        name: locale === 'en' ? 'Unused run data' : '未使用的运行数据',
        exact: true,
      })
      .click()
    const dialog = page.getByRole('dialog')
    await dialog.locator(`[data-unused-run="${orphan.snapshotId}"]`).waitFor()
    return dialog
  }
  for (const locale of ['en', 'zh-CN']) {
    const dialog = await open(locale)
    const rows = await dialog.locator('[data-unused-run]').count()
    assert.equal(rows, 2)
    const body = await dialog.textContent()
    assert.ok(!body.includes(secret) && !body.includes('PRIVATE_ABANDONED_INPUT'))
    assert.ok(body.includes(orphan.cwd))
    page.once('dialog', (confirmation) => confirmation.dismiss())
    await dialog
      .locator(`[data-unused-run="${orphan.snapshotId}"]`)
      .getByRole('button', { name: locale === 'en' ? 'Remove data' : '删除数据', exact: true })
      .click()
    assert.ok((await stat(capture)).isDirectory())
    if (process.env.AGENT_MATRIX_UNUSED_RUN_SCREENSHOT)
      await page.screenshot({
        path:
          process.env.AGENT_MATRIX_UNUSED_RUN_SCREENSHOT +
          (locale === 'en' ? '.en.png' : '.zh.png'),
      })
    await dialog
      .getByRole('button', { name: locale === 'en' ? 'Close' : '关闭', exact: true })
      .last()
      .click()
  }
  let dialog = await open('zh-CN')
  page.once('dialog', (confirmation) => confirmation.accept())
  await dialog
    .locator(`[data-unused-run="${stageId}"]`)
    .getByRole('button', { name: '删除数据', exact: true })
    .click()
  await waitForIpc(
    async () =>
      !(await page.evaluate(() => window.agentMatrix.sessions.unusedRunData({}))).items.some(
        (item) => item.target.id === stageId,
      ),
    'unused staging removal',
  )
  assert.equal(await readFile(join(cwd, 'fixture.txt'), 'utf8'), 'SMOKE_FILE_MARKER')
  const candidate = (
    await page.evaluate(() => window.agentMatrix.sessions.unusedRunData({}))
  ).items.find((item) => item.target.id === orphan.snapshotId)
  const info = await lstat(capture, { bigint: true })
  await app.close()
  app = null
  // Seed an already confirmed receipt at its crash boundary; unit tests cover a failing rm.
  await writeFile(
    join(runs, `.unused-deleting-capture-${orphan.snapshotId}.json`),
    JSON.stringify({
      version: 1,
      target: candidate.target,
      token: candidate.token,
      directoryIdentity: `${info.dev}:${info.ino}`,
    }),
    { mode: 0o600 },
  )
  const held = join(root, 'held-unused-capture')
  await rename(capture, held)
  await symlink(cwd, capture)
  await launch()
  await language('en')
  await navigate('Sessions')
  dialog = await open()
  await dialog
    .locator(`[data-unused-run="${orphan.snapshotId}"]`)
    .getByRole('button', { name: 'Retry removal', exact: true })
    .click()
  await dialog
    .getByRole('alert')
    .filter({ hasText: 'Removal was recorded, but cleanup is unfinished.' })
    .waitFor()
  assert.ok((await lstat(capture)).isSymbolicLink())
  assert.equal(await readFile(join(cwd, 'fixture.txt'), 'utf8'), 'SMOKE_FILE_MARKER')
  await rm(capture)
  await rename(held, capture)
  await dialog
    .locator(`[data-unused-run="${orphan.snapshotId}"]`)
    .getByRole('button', { name: 'Retry removal', exact: true })
    .click()
  await dialog.getByText('No removable unused run data on this page.', { exact: true }).waitFor()
  await assert.rejects(stat(capture), { code: 'ENOENT' })
  await assert.rejects(stat(stage), { code: 'ENOENT' })
  assert.ok((await stat(join(runs, 'unrecognized-entry'))).isDirectory())
  const deleted = await readFile(
    join(runs, `.unused-deleted-capture-${orphan.snapshotId}.json`),
    'utf8',
  )
  assert.ok(!deleted.includes(cwd) && !deleted.includes(secret))
  await dialog.getByRole('button', { name: 'Close', exact: true }).last().click()
  assert.match(
    await page.evaluate(async (command) => {
      try {
        await window.agentMatrix.sessions.command(command)
        return 'unexpected success'
      } catch (error) {
        return String(error)
      }
    }, create),
    /runDeleted/,
  )
  assert.deepEqual((await sessions()).map((session) => session.id).sort(), retained)
  assert.deepEqual(await page.evaluate(() => window.agentMatrix.loadWorkspace()), beforeWorkspace)
  assert.equal(calls.length, beforeCalls)
}
try {
  await launch()
  await language('en')
  if (isDsh) {
    for (const locale of ['en', 'zh-CN']) {
      await language(locale)
      await navigate(locale === 'en' ? 'Native plugins' : '原生插件')
      await page
        .getByRole('button', {
          name: locale === 'en' ? 'Edit Desktop DSH plugin' : '编辑 Desktop DSH plugin',
          exact: true,
        })
        .click()
      const dialog = page.getByRole('dialog')
      await dialog
        .getByLabel(locale === 'en' ? 'DSH plugin configuration (JSON)' : 'DSH 插件配置（JSON）', {
          exact: true,
        })
        .fill(JSON.stringify({ marker: 'DESKTOP_PLUGIN_MARKER', locale }))
      await dialog
        .getByRole('button', {
          name: locale === 'en' ? 'Save configuration' : '保存配置',
          exact: true,
        })
        .click()
      await dialog.waitFor({ state: 'hidden' })
      assert.equal(
        await page.evaluate(
          async () =>
            (await window.agentMatrix.loadWorkspace()).nativePlugins[0].options.config.locale,
        ),
        locale,
      )
    }
    await language('en')
  }
  await navigate('Engines')
  await page.getByRole('button', { name: 'Check installation', exact: true }).click()
  await waitForIpc(
    () =>
      page.evaluate(async (version) => {
        const installation = (await window.agentMatrix.loadWorkspace()).installations[0]
        return (
          installation.version === version && installation.probedAt && installation.modes.length > 0
        )
      }, version),
    'completed installation probe',
  )
  const supportedWorkspace = await page.evaluate(() => window.agentMatrix.loadWorkspace())
  const rejectedCreation = await page.evaluate(
    async ({ isPi, isDsh }) => {
      const draft = await window.agentMatrix.loadWorkspace()
      if (isPi) draft.agents[0].execution.approval = 'ask'
      else if (isDsh) draft.models[0].parameters.temperature = 0.5
      else draft.models[0].parameters.reasoning = 'high'
      await window.agentMatrix.saveWorkspace(draft)
      try {
        await window.agentMatrix.sessions.command({
          kind: 'create',
          commandId: crypto.randomUUID(),
          agentId: 'reviewer',
        })
        return 'unexpectedly accepted'
      } catch (error) {
        return error.message
      }
    },
    { isPi, isDsh },
  )
  assert.match(
    rejectedCreation,
    /nativePlugins.tools-policy|execution.universal-approval|model.sampling|model.parameters.reasoning/,
  )
  assert.equal((await sessions()).length, 0)
  const capturedRuns = await readdir(join(dataDirectory, 'runs')).catch((error) => {
    if (error.code === 'ENOENT') return []
    throw error
  })
  assert.deepEqual(capturedRuns, [])
  await page.reload()
  await page.locator('.card-grid').waitFor()
  await navigate('Sessions')
  const compatibility = page.getByTestId('engine-support')
  await compatibility
    .locator('[data-testid="engine-support-state"][data-state="blocked"]')
    .waitFor()
  assert.equal(
    await page.getByRole('button', { name: 'Start new session', exact: true }).isDisabled(),
    true,
  )
  await compatibility.getByText('Capability details', { exact: true }).click()
  await compatibility.locator('[data-capability="model"]').waitFor()
  assert.match(
    await compatibility.locator('[data-capability="model"]').textContent(),
    /Not verified for this profile/,
  )
  if (process.env.AGENT_MATRIX_SUPPORT_SCREENSHOT)
    await page.screenshot({ path: process.env.AGENT_MATRIX_SUPPORT_SCREENSHOT, fullPage: true })
  await language('zh-CN')
  await compatibility.getByRole('heading', { name: '引擎兼容性', exact: true }).waitFor()
  assert.match(
    await compatibility.locator('[data-capability="model"]').textContent(),
    /此配置尚未验证/,
  )
  assert.equal(
    await page.getByRole('button', { name: '启动新会话', exact: true }).isDisabled(),
    true,
  )
  if (process.env.AGENT_MATRIX_SUPPORT_SCREENSHOT)
    await page.screenshot({
      path: process.env.AGENT_MATRIX_SUPPORT_SCREENSHOT + '.zh.png',
      fullPage: true,
    })
  await language('en')
  await navigate('My Agents')
  await page.getByRole('button', { name: 'Edit Reviewer', exact: true }).click()
  const editor = page.getByRole('dialog')
  await editor.getByRole('tab', { name: 'Resolved preview', exact: true }).click()
  await editor.locator('[data-testid="engine-support-state"][data-state="blocked"]').waitFor()
  assert.equal(
    await editor.getByRole('button', { name: 'Save Agent', exact: true }).isEnabled(),
    true,
  )
  await editor.getByRole('button', { name: 'Cancel', exact: true }).click()
  await page.evaluate(async (previous) => {
    const current = await window.agentMatrix.loadWorkspace()
    await window.agentMatrix.saveWorkspace({ ...previous, revision: current.revision })
  }, supportedWorkspace)
  await page.reload()
  await page.locator('.card-grid').waitFor()
  await navigate('Sessions')
  await page.locator('[data-testid="engine-support-state"][data-state="checks-pending"]').waitFor()
  let directory = page.getByRole('textbox', { name: 'Working directory', exact: true })
  assert.equal(await directory.inputValue(), cwd)
  const beforeDirectory = await page.evaluate(() => window.agentMatrix.loadWorkspace())
  await directory.fill('relative/folder')
  assert.equal(
    await page.getByRole('button', { name: 'Start new session', exact: true }).isDisabled(),
    true,
  )
  await directory.fill('')
  assert.equal(
    await page.getByRole('button', { name: 'Start new session', exact: true }).isDisabled(),
    true,
  )
  await page.getByRole('button', { name: 'Use profile default', exact: true }).click()
  assert.equal(await directory.inputValue(), cwd)
  await chooseWorkingDirectory(null)
  await page.getByRole('button', { name: 'Choose folder', exact: true }).click()
  await waitForIpc(() => directory.isEnabled(), 'cancelled directory chooser')
  assert.equal(await directory.inputValue(), cwd)
  await directory.fill(join(root, 'does-not-exist'))
  await page.getByRole('button', { name: 'Start new session', exact: true }).click()
  await page.getByRole('alert').filter({ hasText: 'Choose an existing folder' }).waitFor()
  assert.equal((await sessions()).length, 0)
  await directory.fill(alternateCwd)
  await page.getByLabel('Agent configuration', { exact: true }).selectOption('')
  await page.getByLabel('Agent configuration', { exact: true }).selectOption('reviewer')
  assert.equal(await directory.inputValue(), cwd)
  assert.deepEqual(await page.evaluate(() => window.agentMatrix.loadWorkspace()), beforeDirectory)
  await page.getByRole('button', { name: 'Start new session', exact: true }).click()
  await status('Ready')
  const original = (await sessions())[0]
  assert.ok(original.nativeSessionId)
  const initialReport = await configurationReport()
  assert.equal(initialReport.savedState, 'same')
  assert.equal(
    initialReport.capabilities.capabilities.find((row) => row.feature === 'native-restore')
      .verification,
    'untested',
  )
  assert.equal(initialReport.observation.runId, original.runId)
  assert.equal(initialReport.snapshotDigest, original.snapshotDigest)
  assert.equal(
    initialReport.fields.find((field) => field.id === 'prompts').status,
    isDsh ? 'composition' : isPi ? 'unknown' : 'observed',
  )
  await send(`Read fixture.txt. Synthetic key: ${secret}`)
  if (!isPi) await page.locator('.permission-card').waitFor()
  else await status('Ready')
  await language('zh-CN')
  await page.getByRole('heading', { name: '会话', exact: true }).waitFor()
  await configurationReport('配置报告', '关闭')
  // History remains read-only even while a native permission is waiting in the live conversation.
  const beforeHistory = await page.evaluate(
    (sessionId) => window.agentMatrix.sessions.get({ sessionId }),
    original.id,
  )
  await page.getByRole('button', { name: '会话历史', exact: true }).click()
  const liveHistory = page.getByRole('dialog')
  await historyPageReady(liveHistory)
  assert.equal(await liveHistory.getByRole('button', { name: /^允许/ }).count(), 0)
  if (!isPi) await liveHistory.getByText('曾请求响应', { exact: true }).waitFor()
  assert.deepEqual(
    await page.evaluate((sessionId) => window.agentMatrix.sessions.get({ sessionId }), original.id),
    beforeHistory,
  )
  await liveHistory.getByRole('button', { name: '关闭', exact: true }).last().click()
  if (process.env.AGENT_MATRIX_SESSION_SCREENSHOT)
    await page.screenshot({ path: process.env.AGENT_MATRIX_SESSION_SCREENSHOT, fullPage: true })
  if (!isPi) await page.getByRole('button', { name: /^允许一次/ }).click()
  await status('就绪')
  assert.equal(calls.at(-1).directoryRead, 'default')
  assert.equal(calls.at(-1).plugin, true)
  assert.equal(
    await page.locator('.message.assistant pre').textContent(),
    'UI_REPLY <script>not executable</script>',
  )
  assert.equal(await page.locator('.transcript script').count(), 0)
  await language('en')
  if (isPi) {
    const beforeExtensions = calls.length
    for (const locale of ['en', 'zh-CN']) {
      await language('en')
      await send('/desktop-confirm')
      await language(locale)
      await page
        .getByRole('button', { name: locale === 'en' ? 'Confirm' : '确认', exact: true })
        .click()
      await status(locale === 'en' ? 'Ready' : '就绪')
    }
    await language('en')
    await send('DESKTOP_HANDLE_WITHOUT_MODEL')
    await status('Ready')
    assert.equal(calls.length, beforeExtensions)
  }
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
  const impact = page.getByTestId('library-impact')
  await impact.locator('[data-impact-profile="reviewer"][data-effect="unchanged"]').waitFor()
  const beforePreview = await page.evaluate(() => window.agentMatrix.loadWorkspace())
  const beforePreviewSessions = await sessions()
  await page.getByLabel('Prompt content', { exact: true }).fill('You are a probe. NEW_ROLE_MARKER.')
  await impact.locator('[data-impact-profile="reviewer"][data-effect="changed"]').waitFor()
  await impact
    .locator(`[data-impact-session="${original.id}"][data-effect="pending"] summary`)
    .click()
  assert.match(
    await impact.locator('[data-impact-asset="role"]').textContent(),
    /Retained v1 · Proposed binding v2/,
  )
  assert.deepEqual(await page.evaluate(() => window.agentMatrix.loadWorkspace()), beforePreview)
  assert.deepEqual(await sessions(), beforePreviewSessions)
  // Reverting the unsaved edit must replace the previous preview, then changing it must recompute.
  await page
    .getByLabel('Prompt content', { exact: true })
    .fill(beforePreview.prompts[0].versions[0].content)
  await impact.locator('[data-impact-profile="reviewer"][data-effect="unchanged"]').waitFor()
  await impact.locator(`[data-impact-session="${original.id}"][data-effect="same"]`).waitFor()
  await page.getByLabel('Prompt content', { exact: true }).fill('You are a probe. NEW_ROLE_MARKER.')
  await impact.locator('[data-impact-profile="reviewer"][data-effect="changed"]').waitFor()
  if (process.env.AGENT_MATRIX_IMPACT_SCREENSHOT) {
    await impact.scrollIntoViewIfNeeded()
    await page.screenshot({ path: process.env.AGENT_MATRIX_IMPACT_SCREENSHOT, fullPage: true })
  }
  await page.getByRole('button', { name: 'Save configuration', exact: true }).click()
  await page.getByRole('dialog').waitFor({ state: 'hidden' })
  await language('zh-CN')
  await page.getByRole('button', { name: '编辑 Role', exact: true }).click()
  await impact.getByRole('heading', { name: '保存前的影响预览' }).waitFor()
  await impact.locator('[data-impact-profile="reviewer"][data-effect="unchanged"]').waitFor()
  await impact
    .locator(`[data-impact-session="${original.id}"][data-effect="pending"] summary`)
    .click()
  assert.match(
    await impact.locator('[data-impact-asset="role"]').textContent(),
    /保留 v1 · 修改后绑定 v2/,
  )
  await impact
    .getByText('本次编辑前，该会话与已保存的 Agent 配置就已存在差异。', { exact: true })
    .waitFor()
  if (process.env.AGENT_MATRIX_IMPACT_SCREENSHOT) {
    await impact.scrollIntoViewIfNeeded()
    await page.screenshot({
      path: process.env.AGENT_MATRIX_IMPACT_SCREENSHOT + '.zh.png',
      fullPage: true,
    })
  }
  await page.getByRole('button', { name: '取消', exact: true }).click()
  await page.getByRole('dialog').waitFor({ state: 'hidden' })
  await language('en')
  await navigate('Sessions')
  await status('Ready')
  const pendingReport = await configurationReport()
  assert.equal(pendingReport.savedState, 'pending')
  assert.deepEqual(
    pendingReport.assets
      .filter((asset) => asset.id === 'role')
      .map((asset) => [asset.version, asset.nextVersion, asset.libraryVersion]),
    [[1, 2, 2]],
  )
  await send('Keep using the captured role')
  await status('Ready')
  assert.equal(calls.at(-1).role, 'original')
  const beforeOverride = await page.evaluate(() => window.agentMatrix.loadWorkspace())
  // Selecting a folder changes the next launch only; cancelling another chooser retains it.
  await chooseWorkingDirectory(alternateCwd)
  await page.getByRole('button', { name: 'Choose folder', exact: true }).click()
  await waitForIpc(
    async () => (await directory.inputValue()) === alternateCwd,
    'selected working directory',
  )
  await chooseWorkingDirectory(null)
  await page.getByRole('button', { name: 'Choose folder', exact: true }).click()
  await waitForIpc(() => directory.isEnabled(), 'cancelled override chooser')
  assert.equal(await directory.inputValue(), alternateCwd)
  assert.equal((await sessions()).find((session) => session.id === original.id).cwd, cwd)
  await language('zh-CN')
  assert.equal(
    await page.getByRole('textbox', { name: '工作目录', exact: true }).inputValue(),
    alternateCwd,
  )
  await page.getByRole('button', { name: '使用配置默认目录', exact: true }).waitFor()
  if (process.env.AGENT_MATRIX_DIRECTORY_SCREENSHOT)
    await page.screenshot({
      path: process.env.AGENT_MATRIX_DIRECTORY_SCREENSHOT + '.zh.png',
      fullPage: true,
    })
  await language('en')
  if (process.env.AGENT_MATRIX_DIRECTORY_SCREENSHOT)
    await page.screenshot({ path: process.env.AGENT_MATRIX_DIRECTORY_SCREENSHOT, fullPage: true })
  await page.getByRole('button', { name: 'Start new session', exact: true }).click()
  await waitForIpc(async () => (await sessions()).length === 2, 'new conversation capture')
  await status('Ready')
  behavior = 'tool'
  await send('Use the newly saved role and read fixture.txt in this project')
  if (!isPi) {
    await page.locator('.permission-card').waitFor()
    await page.getByRole('button', { name: /^Allow once/ }).click()
  }
  await status('Ready')
  assert.equal(calls.at(-1).role, 'new')
  assert.equal(calls.at(-1).directoryRead, 'alternate')
  assert.equal(calls.at(-1).plugin, true)
  const latest = (await sessions()).find((session) => session.id !== original.id)
  assert.ok(latest)
  assert.equal(latest.cwd, alternateCwd)
  assert.deepEqual(await page.evaluate(() => window.agentMatrix.loadWorkspace()), beforeOverride)
  const directoryReport = await configurationReport()
  assert.equal(directoryReport.cwd, alternateCwd)
  assert.equal(directoryReport.fields.find((field) => field.id === 'execution').changed, true)
  await app.close()
  app = null
  await launch()
  await language('en')
  await navigate('Sessions')
  await status('Interrupted')
  directory = page.getByRole('textbox', { name: 'Working directory', exact: true })
  assert.equal(await directory.inputValue(), cwd)
  // The pending launch field must not affect restoration of a captured native session.
  await directory.fill(join(root, 'missing-after-restart'))
  const historicalReport = await configurationReport()
  assert.equal(historicalReport.observationIsCurrent, false)
  assert.equal(historicalReport.observation.runId, latest.runId)
  const snapshotFile = join(dataDirectory, 'runs', latest.snapshotId, 'manifest.json')
  const beforeDrift = await readFile(snapshotFile, 'utf8')
  const nativeControl = isPi
    ? join(dataDirectory, 'runs', latest.snapshotId, 'state/pi/models.json')
    : isDsh
      ? join(
          dataDirectory,
          'runs',
          latest.snapshotId,
          'state/dsh/profiles/agentmatrix/cordis.patch.yml',
        )
      : join(alternateCwd, '.opencode/agents/newly-discovered.md')
  const originalControl = isPi || isDsh ? await readFile(nativeControl) : null
  await writeFile(
    nativeControl,
    originalControl
      ? Buffer.concat([originalControl, Buffer.from('\nPRIVATE_DIAGNOSTIC_MARKER')])
      : '---\ndescription: New native agent\nmode: subagent\n---\nPRIVATE_DIAGNOSTIC_MARKER\n',
  )
  const callsBefore = calls.length
  await page.getByRole('button', { name: 'Resume session', exact: true }).click()
  await status('Failed')
  const failedResume = (await sessions()).find((session) => session.id === latest.id)
  const diagnostic = {
    check: isPi ? 'pi-controls' : isDsh ? 'dsh-controls' : 'sources',
    reason: 'changed',
    fields: [],
  }
  assert.deepEqual(failedResume.failure, {
    code: 'configuration',
    detail: '',
    configuration: diagnostic,
  })
  assert.equal(failedResume.nativeSessionId, latest.nativeSessionId)
  assert.equal(failedResume.snapshotDigest, latest.snapshotDigest)
  assert.equal(calls.length, callsBefore)
  assert.equal(await readFile(snapshotFile, 'utf8'), beforeDrift)
  for (const locale of ['en', 'zh-CN']) {
    await language(locale)
    await page.locator(`.conversation [data-configuration-check="${diagnostic.check}"]`).waitFor()
    const failedReport = await configurationReport(
      locale === 'en' ? 'Configuration report' : '配置报告',
      locale === 'en' ? 'Close' : '关闭',
    )
    assert.deepEqual(failedReport.diagnostic, diagnostic)
    assert.equal(failedReport.observationIsCurrent, false)
    assert.equal(failedReport.observation.runId, latest.runId)
    assert.equal(
      failedReport.fields.some((field) => field.rejected),
      false,
    )
  }
  await app.close()
  app = null
  await launch()
  await language('en')
  await navigate('Sessions')
  await status('Failed')
  assert.deepEqual(
    (await sessions()).find((session) => session.id === latest.id).failure.configuration,
    diagnostic,
  )
  assert.ok(
    !(await readFile(join(dataDirectory, 'sessions', `${latest.id}.jsonl`), 'utf8')).includes(
      'PRIVATE_DIAGNOSTIC_MARKER',
    ),
  )
  if (originalControl) await writeFile(nativeControl, originalControl)
  else await rm(nativeControl)
  await page.getByRole('button', { name: 'Resume session', exact: true }).click()
  await status('Ready')
  const resumed = (await sessions()).find((session) => session.id === latest.id)
  assert.equal(resumed.nativeSessionId, latest.nativeSessionId)
  assert.notEqual(resumed.runId, latest.runId)
  assert.equal(resumed.cwd, alternateCwd)
  assert.equal(resumed.snapshotId, latest.snapshotId)
  assert.equal(resumed.snapshotDigest, latest.snapshotDigest)
  const resumedReport = await configurationReport()
  assert.equal(resumedReport.diagnostic, null)
  assert.equal(
    resumedReport.fields.some((field) => field.rejected),
    false,
  )
  assert.equal(resumedReport.observationIsCurrent, true)
  assert.equal(resumedReport.observation.runId, resumed.runId)
  assert.equal(
    resumedReport.capabilities.capabilities.find((row) => row.feature === 'native-restore')
      .verification,
    'passed',
  )
  assert.equal(
    resumedReport.capabilities.capabilities.find((row) => row.feature === 'native-restore')
      .availability,
    'ready',
  )
  assert.equal(resumedReport.assets.find((asset) => asset.id === 'role').version, 2)
  await send('Continue the saved session')
  await status('Ready')
  assert.equal(calls.at(-1).directoryRead, 'alternate')
  await page.getByRole('button', { name: 'Close session', exact: true }).click()
  await status('Closed')
  await verifyLongHistory(original.id)
  if (!isPi && !isDsh) {
    await language('en')
    await navigate('Sessions')
    await page.getByRole('textbox', { name: 'Working directory', exact: true }).fill(cwd)
    const nativeOverride = join(cwd, '.opencode/agents/build.md')
    const nativeContents =
      '---\ndescription: Native conflict fixture\n---\nPRIVATE_NATIVE_PROMPT_OVERRIDE\n'
    await writeFile(nativeOverride, nativeContents)
    const countBefore = (await sessions()).length
    const callsBeforeMismatch = calls.length
    await page.getByRole('button', { name: 'Start new session', exact: true }).click()
    await waitForIpc(
      async () => (await sessions()).length === countBefore + 1,
      'native conflict capture',
    )
    await status('Failed')
    const selectedId = await page.locator('.conversation').getAttribute('data-session-id')
    const mismatch = (await sessions()).find((session) => session.id === selectedId)
    const fieldDiagnostic = { check: 'opencode-config', reason: 'mismatch', fields: ['prompts'] }
    assert.deepEqual(mismatch.failure.configuration, fieldDiagnostic)
    assert.equal(mismatch.nativeSessionId, null)
    assert.equal(calls.length, callsBeforeMismatch)
    for (const locale of ['en', 'zh-CN']) {
      await language(locale)
      await page
        .getByRole('button', {
          name: locale === 'en' ? 'Configuration report' : '配置报告',
          exact: true,
        })
        .click()
      const dialog = page.getByRole('dialog')
      await dialog.locator('[data-report-field="prompts"][data-rejected="true"]').waitFor()
      await dialog.locator('[data-configuration-check="opencode-config"]').waitFor()
      const report = await page.evaluate(
        (sessionId) => window.agentMatrix.sessions.configuration({ sessionId }),
        selectedId,
      )
      assert.deepEqual(report.diagnostic, fieldDiagnostic)
      assert.equal(report.observation, null)
      assert.equal(report.fields.find((field) => field.id === 'prompts').status, 'planned')
      assert.ok(!(await dialog.textContent()).includes('PRIVATE_NATIVE_PROMPT_OVERRIDE'))
      if (process.env.AGENT_MATRIX_DIAGNOSTIC_SCREENSHOT)
        await page.screenshot({
          path:
            process.env.AGENT_MATRIX_DIAGNOSTIC_SCREENSHOT +
            (locale === 'en' ? '.field.en.png' : '.field.zh.png'),
        })
      await dialog
        .getByRole('button', { name: locale === 'en' ? 'Close' : '关闭', exact: true })
        .last()
        .click()
    }
    assert.equal(await readFile(nativeOverride, 'utf8'), nativeContents)
    assert.ok(
      !(await readFile(join(dataDirectory, 'sessions', `${selectedId}.jsonl`), 'utf8')).includes(
        'PRIVATE_NATIVE_PROMPT_OVERRIDE',
      ),
    )
    await language('en')
    await page.getByRole('button', { name: 'Close session', exact: true }).click()
    await status('Closed')
    await rm(nativeOverride)
  }
  await verifyUnusedRunData()
  await verifyRetention(original, latest)
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
    configurationPreflight: {
      blockedBeforeCapture: true,
      startDisabled: true,
      draftStillEditable: true,
      capabilityDimensions: true,
      englishAndChinese: true,
    },
    profileToSession: true,
    workingDirectory: {
      typedAndNativeChooser: true,
      invalidAndMissingPathsRejected: true,
      chooserCancellationPreservesSelection: true,
      profileSwitchResetsOverride: true,
      savedDefaultUnchanged: true,
      relativeFileReadInSelectedDirectory: true,
      unicodeAndSpaces: true,
      capturedDirectoryOnNativeResume: true,
      englishAndChinese: true,
    },
    permissionReply: isPi ? 'unsupported: no universal per-tool approval' : true,
    toolResult: calls.some((call) => call.read),
    rendererReloadWithoutResubmit: true,
    selectedPluginActivation: {
      capturedBinding: true,
      nativeHookReachedProvider: true,
      newAndResumedInstanceVerified: true,
      englishAndChineseReport: true,
      extensionCommandsAndInputHandling: isPi ? true : 'not part of this engine fixture',
      nativeOptionsEditor: isDsh
        ? { englishAndChinese: true, persisted: true }
        : 'not part of this engine fixture',
    },
    streamingCancellation: true,
    messageDelivery: isDsh ? 'Committed semantic messages' : 'Streaming text',
    configurationReport: {
      nativeEvidence: true,
      persistedAfterRestart: true,
      pendingAssetVersions: true,
      englishAndChinese: true,
      sensitiveValuesOmitted: true,
    },
    skillSourceReport: {
      scope: isPi
        ? 'Native RPC Skill sources'
        : isDsh
          ? 'Native session-scoped Skill registry'
          : 'Owned ACP server and captured-directory Skill service',
      englishAndChinese: true,
      historicalReceiptAfterRestart: true,
      freshReceiptAfterResume: true,
      noNativeBodiesOrUnmatchedPaths: true,
      mappedNativeEntriesVisible: true,
    },
    sessionCapabilities: {
      dimensions: 18,
      capturedIdentityAndNativeChecks: true,
      advertisedRestoreIsNotVerifiedUse: true,
      freshEvidenceAfterNativeRestore: true,
      historicalAvailabilityUnknown: true,
      serviceAndEnforcementRemainUnverified: true,
      englishAndChinese: true,
    },
    nativeResourceInventory:
      !isPi && !isDsh
        ? {
            capturedMetadataWithoutContent: true,
            newFileBlocksNativeResume: true,
            failedResumeRetainsHistoricalEvidence: true,
            capturedSnapshotUnchanged: true,
            restoredSourcesAllowSameNativeSessionResume: true,
            englishAndChinese: true,
          }
        : 'No directory inventory declared by this adapter',
    configurationFailure: {
      check: diagnostic.check,
      nativePromptMismatchAtStartup: !isPi && !isDsh ? true : 'Not part of this engine fixture',
      persistedAfterRestart: true,
      englishAndChinese: true,
      historicalSuccessPreserved: true,
      noNativeValuesOrSecretContent: true,
      clearedAfterSuccessfulNativeResume: true,
    },
    permissionCancellation: isPi ? 'unsupported: no universal per-tool approval' : true,
    sharedPromptOldAndNewSnapshots: true,
    libraryImpact: {
      beforeSave: true,
      unchangedAfterRevert: true,
      retainedAndProposedVersions: true,
      alreadyPending: true,
      noWorkspaceOrSessionWrites: true,
      englishAndChinese: true,
    },
    appQuitAndRestart: true,
    nativeResume: true,
    confirmedClose: true,
    retention: {
      closedOnly: true,
      englishAndChineseConfirmation: true,
      confirmationCancellation: true,
      sharedCaptureRetained: true,
      unreferencedCaptureAndNativeStateRemoved: true,
      pendingCleanupVisible: true,
      explicitCleanupRetry: true,
      restartRecovery: true,
      deletedCreateReplayRejected: true,
      projectAndSharedLibraryAndExportPreserved: true,
      noAdditionalModelCalls: true,
    },
    unusedRunData: {
      orphanCaptureAndStaging: true,
      retainedConversationReferencesExcluded: true,
      confirmationCancellationInBothLanguages: true,
      pendingReceiptRecoveryAfterRestart: true,
      rootAndNestedSymlinkBoundaries: true,
      deletedCaptureCreateReplayRejected: true,
      unknownEntriesPreserved: true,
      sharedWorkspaceAndProjectPreserved: true,
      noAdditionalModelCalls: true,
    },
    sessionHistory: {
      nativeEventsReadOnly: true,
      syntheticLongHistoryPagination: true,
      completeJsonlExport: true,
      selectedBoundary: true,
      exportCancellation: true,
      existingRedactionPreserved: true,
      reloadWithoutExecution: true,
      englishAndChinese: true,
    },
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
