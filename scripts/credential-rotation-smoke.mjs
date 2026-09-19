import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { isAbsolute, join, relative, sep } from 'node:path'
import { _electron as electron } from 'playwright'
import { openCodeWorkspace } from '../tests/helpers/opencode-fixture.ts'

const engines = [
  {
    id: 'opencode',
    label: 'OpenCode',
    kind: 'opencode',
    path: process.env.AGENT_MATRIX_TEST_OPENCODE,
    options: { kind: 'opencode', agent: 'build' },
  },
  {
    id: 'pi',
    label: 'Pi',
    kind: 'pi',
    path: process.env.AGENT_MATRIX_TEST_PI,
    options: { kind: 'pi', projectTrust: 'deny', contextFiles: 'inherit' },
  },
  {
    id: 'dsh',
    label: 'DeepSeek Harness',
    kind: 'deepseek-harness',
    path: process.env.AGENT_MATRIX_TEST_DSH,
    options: { kind: 'deepseek-harness', profileTemplate: 'acp', patchReload: 'startup' },
  },
  {
    id: 'dsh_native',
    label: 'DeepSeek Harness native',
    kind: 'deepseek-harness',
    path: process.env.AGENT_MATRIX_TEST_DSH,
    options: { kind: 'deepseek-harness', profileTemplate: 'acp', patchReload: 'startup' },
  },
]
for (const engine of engines)
  assert.ok(
    engine.path && isAbsolute(engine.path),
    `Set the absolute ${engine.label} test executable`,
  )
const root = await realpath(await mkdtemp(join(tmpdir(), 'agentmatrix-credential-rotation-')))
const dataDirectory = join(root, 'data'),
  cwd = join(root, 'project'),
  home = join(root, 'home')
for (const path of [dataDirectory, join(cwd, '.git'), home]) await mkdir(path, { recursive: true })
const firstKey = 'synthetic-rotation-key-first',
  secondKey = 'synthetic-rotation-key-second',
  credentialId = 'private-rotation-credential-id'
const environmentKey = 'synthetic-rotation-environment-value'
const requests = [],
  pageErrors = []
let app,
  page,
  serverError,
  passed = false
const server = createServer(async (request, response) => {
  try {
    let body = ''
    for await (const chunk of request) {
      body += String(chunk)
      assert.ok(body.length < 2_097_152)
    }
    const input = JSON.parse(body)
    assert.equal(request.url, '/v1/chat/completions')
    const key =
      request.headers.authorization === `Bearer ${firstKey}`
        ? 1
        : request.headers.authorization === `Bearer ${secondKey}`
          ? 2
          : null
    assert.ok(key, 'Unknown provider credential')
    const nativeDsh = input.model === 'rotation-dsh_native'
    assert.equal(
      request.headers['x-credential'],
      nativeDsh ? undefined : key === 1 ? firstKey : secondKey,
    )
    assert.equal(request.headers['x-rotation-environment'], nativeDsh ? undefined : environmentKey)
    const primary = input.tools?.some((tool) => tool.function?.name === 'read')
    // Native context messages can follow the submitted user prompt.
    const marker = input.messages
      .filter((message) => message.role === 'user')
      .map((message) => JSON.stringify(message.content).match(/ROTATION_[A-Za-z0-9_]+/)?.[0])
      .filter(Boolean)
      .at(-1)
    if (primary) {
      assert.ok(marker)
      requests.push({ model: input.model, marker, key })
    }
    if (primary && marker.endsWith('_resumed'))
      assert.ok(
        input.messages.some(
          (message) =>
            message.role === 'assistant' && JSON.stringify(message.content).includes(firstKey),
        ),
        'Native history must contain the earlier credential echo',
      )
    const content = primary
      ? `${marker}_REPLY ${key === 1 ? firstKey : secondKey}${marker.endsWith('_resumed') ? ` previous=${firstKey}` : ''}`
      : 'Credential fixture'
    if (!input.stream) {
      response.writeHead(200, { 'Content-Type': 'application/json' })
      response.end(
        JSON.stringify({
          id: 'rotation',
          object: 'chat.completion',
          created: 1,
          model: input.model,
          choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 },
        }),
      )
      return
    }
    response.writeHead(200, { 'Content-Type': 'text/event-stream' })
    for (const [delta, finish_reason] of [
      [{ role: 'assistant', content }, null],
      [{}, 'stop'],
    ])
      response.write(
        `data: ${JSON.stringify({ id: 'rotation', object: 'chat.completion.chunk', created: 1, model: input.model, choices: [{ index: 0, delta, finish_reason }] })}\n\n`,
      )
    response.end('data: [DONE]\n\n')
  } catch (error) {
    serverError = error
    response.writeHead(400)
    response.end('Fixture rejected request')
  }
})
await new Promise((resolve, reject) => {
  server.once('error', reject)
  server.listen(0, '127.0.0.1', resolve)
})
const workspace = openCodeWorkspace(engines[0].path, cwd)
const installation = workspace.installations[0],
  agent = workspace.agents[0],
  model = workspace.models[0]
workspace.installations = engines.map((engine) => ({
  ...installation,
  id: engine.id,
  name: engine.label,
  kind: engine.kind,
  executable: engine.path,
  version: null,
  modes: [],
  probedAt: null,
}))
workspace.agents = engines.map((engine) => ({
  ...agent,
  id: engine.id,
  name: engine.label,
  engineInstallationId: engine.id,
  modelProfileId: engine.id,
  promptBindings: [],
  skillBindings: [],
  execution: { cwd, approval: 'unrestricted' },
  engineOptions: engine.options,
}))
workspace.models = engines.map((engine) => ({
  ...model,
  id: engine.id,
  modelId: `rotation-${engine.id}`,
  connectionId: engine.id === 'dsh_native' ? 'native-deepseek' : model.connectionId,
}))
workspace.prompts = []
workspace.skills = []
workspace.connections[0].baseUrl = `http://127.0.0.1:${server.address().port}/v1`
workspace.connections[0].auth = { kind: 'bearer', secret: { kind: 'credential', id: credentialId } }
workspace.connections[0].secretHeaders = {
  'X-Credential': { kind: 'credential', id: credentialId },
  'X-Rotation-Environment': { kind: 'environment', name: 'ROTATION_ENVIRONMENT' },
}
workspace.connections.push({
  ...structuredClone(workspace.connections[0]),
  id: 'native-deepseek',
  name: 'Native DeepSeek connection',
  protocol: 'deepseek-official',
  headers: {},
  secretHeaders: {},
})
await writeFile(join(dataDirectory, 'workspace.json'), JSON.stringify(workspace))
const env = {
  ...process.env,
  HOME: home,
  XDG_CONFIG_HOME: join(home, '.config'),
  AGENT_MATRIX_DATA_DIR: dataDirectory,
  ROTATION_ENVIRONMENT: environmentKey,
}
delete env.ELECTRON_RUN_AS_NODE
async function launch() {
  app = await electron.launch({ args: ['.'], env, timeout: 30_000 })
  page = await app.firstWindow()
  page.setDefaultTimeout(20_000)
  page.on('pageerror', (error) => pageErrors.push(error.message))
  await page.locator('.card-grid').waitFor()
}
const command = (value) =>
  page.evaluate((input) => window.agentMatrix.sessions.command(input), {
    commandId: randomUUID(),
    ...value,
  })
const get = (id) => page.evaluate((sessionId) => window.agentMatrix.sessions.get({ sessionId }), id)
const report = (id) =>
  page.evaluate((sessionId) => window.agentMatrix.sessions.configuration({ sessionId }), id)
async function wait(id, target) {
  const end = Date.now() + 90_000
  while (Date.now() < end) {
    if (serverError) throw serverError
    const state = await get(id)
    if (state.status === target) return state
    if (state.failure) throw new Error(`Session ${id} failed: ${state.failure.code}`)
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  throw new Error(`Session did not reach ${target}`)
}
async function start(engine) {
  const created = await command({ kind: 'create', agentId: engine.id })
  await command({ kind: 'start', sessionId: created.id })
  return wait(created.id, 'ready')
}
async function send(session, phase, key) {
  const current = await get(session.id),
    marker = `ROTATION_${session.agentId}_${phase}`,
    messageId = randomUUID()
  await command({
    kind: 'send',
    sessionId: current.id,
    runId: current.runId,
    messageId,
    text: marker,
  })
  const end = Date.now() + 60_000
  let completed = false
  while (Date.now() < end) {
    if (serverError) throw serverError
    const state = await get(current.id)
    if (state.failure) throw new Error(`Turn failed: ${state.failure.code}`)
    if (state.status === 'ready' && state.lastTurn?.messageId === messageId) {
      assert.equal(state.lastTurn.outcome, 'completed')
      completed = true
      break
    }
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  assert.ok(completed, `Turn did not complete for ${phase}`)
  const matches = requests.filter((request) => request.marker === marker)
  assert.ok(matches.length > 0, `No provider evidence for ${phase}`)
  assert.ok(
    matches.every(
      (request) => request.key === key && request.model === `rotation-${session.agentId}`,
    ),
  )
  const history = await page.evaluate((query) => window.agentMatrix.sessions.history(query), {
    sessionId: session.id,
    throughCursor: (await get(session.id)).cursor,
    fromCursor: 1,
    direction: 'forward',
    limit: 200,
  })
  assert.equal(history.hasLater, false)
  const serialized = JSON.stringify(history)
  for (const secret of [firstKey, secondKey, environmentKey])
    assert.ok(!serialized.includes(secret), `Credential echo leaked in ${phase} history`)
  assert.ok(serialized.includes('[redacted]'))
}
function checkReport(value, state, attached, stored) {
  assert.equal(value.retainedCredentialRedaction, true)
  const vault = value.credentials.entries.filter((entry) => entry.source === 'vault')
  assert.equal(vault.length, 1, 'Repeated credential must be deduplicated')
  assert.equal(vault[0].state, state)
  assert.equal(vault[0].attachment?.revision ?? null, attached)
  assert.equal(vault[0].current?.revision ?? null, stored)
  const nativeDsh = value.fields
    .find((field) => field.id === 'connection')
    .value.startsWith('deepseek-official\n')
  assert.deepEqual(vault[0].purposes, nativeDsh ? ['model-auth'] : ['model-auth', 'model-header'])
  const environment = value.credentials.entries.find((entry) => entry.source === 'environment')
  if (nativeDsh) assert.equal(environment, undefined)
  else assert.equal(environment.state, 'environment')
  assert.equal(value.credentials.entries.length, nativeDsh ? 1 : 2)
  assert.equal(value.observation?.credentialResolutions, undefined)
  for (const secret of [firstKey, secondKey, environmentKey, credentialId, 'ROTATION_ENVIRONMENT'])
    assert.ok(!JSON.stringify(value).includes(secret))
}
async function showReport(session, locale, state) {
  await page.locator('.language-select select').first().selectOption(locale)
  await page.waitForFunction((value) => document.documentElement.lang === value, locale)
  await page
    .getByRole('navigation')
    .getByRole('button', { name: new RegExp(`^${locale === 'en' ? 'Sessions' : '会话'}`) })
    .click()
  await page.locator(`[data-session-list-id="${session.id}"]`).click()
  await page
    .getByRole('button', {
      name: locale === 'en' ? 'Configuration report' : '配置报告',
      exact: true,
    })
    .click()
  const dialog = page.getByRole('dialog')
  const table = dialog.getByRole('table', {
    name: locale === 'en' ? 'Credential revisions' : '凭据版本',
    exact: true,
  })
  await table.locator(`[data-credential-state="${state}"]`).waitFor()
  await table.scrollIntoViewIfNeeded()
  assert.ok(
    (await dialog.getByTestId('credential-redaction-coverage').innerText()).includes(
      locale === 'en' ? 'encrypted key history' : '加密的密钥历史',
    ),
  )
  for (const secret of [firstKey, secondKey, environmentKey, credentialId, 'ROTATION_ENVIRONMENT'])
    assert.ok(!(await dialog.innerText()).includes(secret))
  if (process.env.AGENT_MATRIX_ROTATION_SCREENSHOT)
    await page.screenshot({
      path:
        process.env.AGENT_MATRIX_ROTATION_SCREENSHOT + (locale === 'en' ? '.en.png' : '.zh.png'),
    })
  await dialog
    .getByRole('button', { name: locale === 'en' ? 'Close' : '关闭', exact: true })
    .last()
    .click()
}
const scannedFiles = [],
  excludedNativeState = []
async function inspectFiles(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) {
      const parts = relative(dataDirectory, path).split(sep)
      if (parts.length === 3 && parts[0] === 'runs' && parts[2] === 'state')
        excludedNativeState.push(relative(dataDirectory, path))
      else await inspectFiles(path)
      continue
    }
    if (!entry.isFile()) continue
    const contents = await readFile(path)
    scannedFiles.push(relative(dataDirectory, path))
    for (const value of [firstKey, secondKey, environmentKey])
      assert.ok(
        !contents.includes(value),
        `Plaintext secret in application-owned file ${entry.name}`,
      )
    if (path.startsWith(join(dataDirectory, 'sessions')))
      for (const value of [credentialId, 'ROTATION_ENVIRONMENT'])
        assert.ok(!contents.includes(value), 'Journal exposed a credential reference')
  }
}
try {
  await launch()
  const credential = await page.evaluate((input) => window.agentMatrix.setCredential(input), {
    id: credentialId,
    name: 'Rotation fixture key',
    kind: 'api-key',
    value: firstKey,
    expectedRevision: null,
  })
  const originals = [],
    newer = [],
    manifests = new Map()
  for (const engine of engines) {
    await page.evaluate(
      (installationId) => window.agentMatrix.probeEngine({ installationId }),
      engine.id,
    )
    const session = await start(engine)
    originals.push(session)
    manifests.set(
      session.id,
      await readFile(join(dataDirectory, 'runs', session.snapshotId, 'manifest.json'), 'utf8'),
    )
    checkReport(await report(session.id), 'same', 1, 1)
    await send(session, 'initial', 1)
  }
  await page.evaluate((input) => window.agentMatrix.setCredential(input), {
    id: credentialId,
    name: credential.name,
    kind: 'api-key',
    value: secondKey,
    expectedRevision: 1,
  })
  for (const session of originals) {
    checkReport(await report(session.id), 'changed', 1, 2)
    await send(session, 'after_rotation', 1)
  }
  await page.reload()
  await page.locator('.card-grid').waitFor()
  for (const session of originals)
    for (const locale of ['en', 'zh-CN']) await showReport(session, locale, 'changed')
  for (const engine of engines) {
    const session = await start(engine)
    newer.push(session)
    checkReport(await report(session.id), 'same', 2, 2)
    await send(session, 'new_session', 2)
    await command({ kind: 'close', sessionId: session.id, runId: session.runId })
    await wait(session.id, 'closed')
  }
  await app.close()
  app = undefined
  await launch()
  for (const session of originals) {
    const historical = await report(session.id)
    checkReport(historical, 'changed', 1, 2)
    assert.equal(historical.observationIsCurrent, false)
    const old = await get(session.id)
    assert.equal(old.status, 'interrupted')
    await command({ kind: 'resume', sessionId: old.id, previousRunId: old.runId })
    const resumed = await wait(old.id, 'ready')
    assert.equal(resumed.nativeSessionId, session.nativeSessionId)
    assert.notEqual(resumed.runId, session.runId)
    const current = await report(session.id)
    checkReport(current, 'same', 2, 2)
    assert.equal(current.observationIsCurrent, true)
    await send(session, 'resumed', 2)
    const target = join(root, `history-${session.agentId}.jsonl`)
    await app.evaluate(({ dialog }, filePath) => {
      const original = dialog.showSaveDialog
      dialog.showSaveDialog = async () => {
        dialog.showSaveDialog = original
        return { canceled: false, filePath }
      }
    }, target)
    await page.evaluate((query) => window.agentMatrix.sessions.exportHistory(query), {
      sessionId: session.id,
      throughCursor: (await get(session.id)).cursor,
    })
    const exported = await readFile(target, 'utf8')
    assert.ok(exported.includes('[redacted]'))
    for (const secret of [firstKey, secondKey, environmentKey])
      assert.ok(!exported.includes(secret))
  }
  await page.evaluate(
    (id) => window.agentMatrix.deleteCredential({ id, expectedRevision: 2 }),
    credentialId,
  )
  for (const session of originals) {
    checkReport(await report(session.id), 'missing', 2, null)
    await send(session, 'deleted_still_running', 2)
  }
  await app.close()
  app = undefined
  await launch()
  for (const session of originals) {
    const previous = await get(session.id)
    await command({ kind: 'resume', sessionId: previous.id, previousRunId: previous.runId })
    const failed = await wait(session.id, 'failed')
    assert.equal(failed.failure.code, 'credentials')
    const value = await report(session.id)
    checkReport(value, 'missing', 2, null)
    assert.equal(value.observationIsCurrent, false)
    assert.equal(
      await readFile(join(dataDirectory, 'runs', session.snapshotId, 'manifest.json'), 'utf8'),
      manifests.get(session.id),
    )
  }
  await inspectFiles(dataDirectory)
  const beforeRemoval = requests.length
  for (const session of [...originals, ...newer]) {
    const current = await get(session.id)
    if (current.status !== 'closed') {
      await command({ kind: 'close', sessionId: current.id, runId: current.runId })
      await wait(current.id, 'closed')
    }
    const closed = await get(session.id)
    await page.evaluate((input) => window.agentMatrix.sessions.remove(input), {
      sessionId: closed.id,
      expectedCursor: closed.cursor,
    })
    await assert.rejects(
      readFile(join(dataDirectory, 'runs', closed.snapshotId, 'redactions.enc')),
      { code: 'ENOENT' },
    )
  }
  assert.equal(requests.length, beforeRemoval)
  assert.deepEqual(pageErrors, [])
  passed = true
  const result = {
    checkedAt: new Date().toISOString(),
    platform: process.platform,
    architecture: process.arch,
    passed: true,
    engines: engines.map((engine) => engine.label),
    versions: Object.fromEntries(
      originals.map((session) => [session.agentId, session.engineVersion]),
    ),
    provider: {
      service: 'Local synthetic fixture',
      routes: engines.map((engine) => {
        const selectedModel = workspace.models.find((value) => value.id === engine.id)
        return {
          profile: engine.id,
          engine: engine.kind,
          executable: engine.path.startsWith(`${homedir()}/`)
            ? `~${engine.path.slice(homedir().length)}`
            : engine.path,
          protocol: workspace.connections.find((value) => value.id === selectedModel.connectionId)
            .protocol,
          model: selectedModel.modelId,
          ...(engine.kind === 'deepseek-harness'
            ? { component: engine.id === 'dsh_native' ? 'dsh-llm-deepseek' : 'dsh-llm-pi-ai' }
            : {}),
        }
      }),
    },
    locales: ['en', 'zh-CN'],
    initialRevision: 1,
    rotatedRevision: 2,
    activeAttachmentsRetainOldKey: true,
    newSessionsUseRotatedKey: true,
    nativeResumeUsesRotatedKey: true,
    deletedCredentialBlocksResume: true,
    historicalEvidencePreserved: true,
    immutableManifests: true,
    applicationStorageRedacted: true,
    applicationRegularFilesScanned: scannedFiles.length,
    nativeStateDirectoriesExcluded: excludedNativeState.length,
    headerReferencesIsolatedByConnection: true,
    nativeHistoryContainsOriginalEcho: true,
    rotatedKeyEchoRedactedAfterRestart: true,
    retiredKeysNeverAuthenticate: true,
    historyApiAndExportsRedacted: true,
    encryptedHistoryRemovedWithCapture: true,
    primaryRequests: requests.length,
    externalProvider: false,
  }
  if (process.env.AGENT_MATRIX_ROTATION_REPORT)
    await writeFile(
      process.env.AGENT_MATRIX_ROTATION_REPORT,
      JSON.stringify(result, null, 2) + '\n',
    )
  console.log(JSON.stringify(result, null, 2))
} finally {
  if (app) await app.close().catch(() => {})
  await new Promise((resolve) => server.close(resolve))
  if (passed) await rm(root, { recursive: true, force: true })
  else console.error(`Credential rotation fixture retained: ${root}`)
}
