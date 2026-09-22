import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { isAbsolute, join, relative, sep } from 'node:path'
import { _electron as electron } from 'playwright'
import { openCodeWorkspace } from '../tests/helpers/opencode-fixture.ts'
import { chooseOption, languageSelect } from './lib/select.mjs'

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
const firstKey = 'synthetic-rotation-key-first/"{value}',
  secondKey = 'synthetic-rotation-key-second/"{value}',
  credentialId = 'private-rotation-credential-id'
const environmentKey = 'synthetic-rotation-environment/"{value}'
const requests = [],
  pageErrors = [],
  rendererConsole = [],
  liveTurns = [],
  processLogs = { stdout: [], stderr: [] },
  publicChecks = new Map()
const forms = (value) => [value, JSON.stringify(value).slice(1, -1), encodeURIComponent(value)]
const forbidden = [
  ...new Set(
    [firstKey, secondKey, environmentKey].flatMap((value) => {
      const variants = [
        ...forms(value),
        JSON.stringify(value).slice(1, -1).replaceAll('{', '\\u007b'),
      ]
      return variants.flatMap((variant) => [variant, JSON.stringify(variant).slice(1, -1)])
    }),
  ),
]
function assertMasked(text, surface) {
  for (const value of forbidden)
    assert.ok(!text.includes(value), `Credential encoding exposed through ${surface}`)
}
function publicResult(surface, value) {
  assertMasked(JSON.stringify(value), surface)
  publicChecks.set(surface, (publicChecks.get(surface) ?? 0) + 1)
  return value
}
function echoes(key, retired, includeEnvironment) {
  return [
    key === 1 ? firstKey : secondKey,
    ...(retired ? [firstKey] : []),
    ...(includeEnvironment ? [environmentKey] : []),
  ]
    .map((value) =>
      forms(value)
        .map((form, index) => `${['RAW', 'JSON', 'URL'][index]}=${form}`)
        .join(' '),
    )
    .join(' ')
}
let fragmentedStreams = 0
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
      const userInput = input.messages
        .filter((message) => message.role === 'user')
        .map((message) =>
          typeof message.content === 'string'
            ? message.content
            : message.content.map((part) => part.text ?? '').join('\n'),
        )
        .findLast((text) => text.includes(marker))
      assert.ok(
        userInput?.includes(echoes(key, marker.endsWith('_resumed'), !nativeDsh)),
        'Native provider request must retain the submitted synthetic input',
      )
      requests.push({ model: input.model, marker, key })
    }
    if (primary && marker.endsWith('_resumed'))
      assert.ok(
        input.messages.some(
          (message) =>
            message.role === 'assistant' &&
            JSON.stringify(message.content).includes(JSON.stringify(firstKey).slice(1, -1)),
        ),
        'Native history must contain the earlier credential echo',
      )
    const content = primary
      ? `${marker}_REPLY ${echoes(key, marker.endsWith('_resumed'), !nativeDsh)}`
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
    const chunks = primary ? content.match(/.{1,13}/g) : [content]
    if (primary) fragmentedStreams += 1
    for (const [delta, finish_reason] of [
      [{ role: 'assistant' }, null],
      ...chunks.map((text) => [{ content: text }, null]),
      [{}, 'stop'],
    ]) {
      response.write(
        `data: ${JSON.stringify({ id: 'rotation', object: 'chat.completion.chunk', created: 1, model: input.model, choices: [{ index: 0, delta, finish_reason }] })}\n\n`,
      )
      if (primary) await new Promise((resolve) => setTimeout(resolve, 3))
    }
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
// Each CLI is granted the connection its own agent uses; the native route is its own grant.
workspace.engineBindings = engines.map((engine) => ({
  ...workspace.engineBindings[0],
  id: `grant-${engine.id}`,
  installationId: engine.id,
  connectionId: engine.id === 'dsh_native' ? 'native-deepseek' : workspace.connections[0].id,
  route: engine.id === 'dsh_native' ? 'deepseek-official' : workspace.connections[0].protocol,
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
  for (const stream of ['stdout', 'stderr'])
    app.process()[stream].on('data', (bytes) => processLogs[stream].push(Buffer.from(bytes)))
  page = await app.firstWindow()
  page.setDefaultTimeout(20_000)
  page.on('pageerror', (error) => pageErrors.push(error.message))
  page.on('console', (message) => rendererConsole.push(message.text()))
  await page.locator('.card-grid').waitFor()
}
const command = async (value) =>
  publicResult(
    'command',
    await page.evaluate((input) => window.agentMatrix.sessions.command(input), {
      commandId: randomUUID(),
      ...value,
    }),
  )
const get = async (id) =>
  publicResult(
    'snapshot',
    await page.evaluate((sessionId) => window.agentMatrix.sessions.get({ sessionId }), id),
  )
const report = async (id) =>
  publicResult(
    'configuration',
    await page.evaluate(
      (sessionId) => window.agentMatrix.sessions.configuration({ sessionId }),
      id,
    ),
  )
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
  publicResult(
    'subscription-snapshot',
    await page.evaluate(
      async (input) => {
        window.rotationEvents = []
        const subscription = await window.agentMatrix.sessions.subscribe(input, (delivery) => {
          window.rotationEvents.push(delivery)
        })
        window.rotationUnsubscribe = subscription.unsubscribe
        return subscription.snapshot
      },
      { sessionId: current.id, subscriptionId: randomUUID(), afterCursor: current.cursor },
    ),
  )
  await command({
    kind: 'send',
    sessionId: current.id,
    runId: current.runId,
    messageId,
    text: `${marker} INPUT ${echoes(key, phase === 'resumed', session.agentId !== 'dsh_native')}`,
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
  await page.waitForFunction(() =>
    window.rotationEvents.some(
      (delivery) => delivery.kind === 'event' && delivery.event.data.kind === 'turn.finished',
    ),
  )
  const deliveries = publicResult(
    'live-deliveries',
    await page.evaluate(async () => {
      await window.rotationUnsubscribe()
      return window.rotationEvents
    }),
  )
  assert.ok(deliveries.every((delivery) => delivery.kind === 'event'))
  const liveText = deliveries
    .filter((delivery) => delivery.event.data.kind === 'message.delta')
    .map((delivery) => delivery.event.data.text)
    .join('')
  assertMasked(liveText, 'joined live message deltas')
  assert.ok(liveText.includes(`${marker}_REPLY`))
  assert.ok(liveText.includes('[redacted]'))
  const userEvent = deliveries.find((delivery) => delivery.event.data.kind === 'turn.started')
  assert.ok(userEvent?.event.data.text.includes('[redacted]'))
  liveTurns.push({
    engine: session.agentId,
    phase,
    events: deliveries.length,
    userInputRedacted: true,
    joinedAssistantTextRedacted: true,
  })
  const matches = requests.filter((request) => request.marker === marker)
  assert.ok(matches.length > 0, `No provider evidence for ${phase}`)
  assert.ok(
    matches.every(
      (request) => request.key === key && request.model === `rotation-${session.agentId}`,
    ),
  )
  const throughCursor = (await get(session.id)).cursor
  const history = publicResult(
    'history',
    await page.evaluate((query) => window.agentMatrix.sessions.history(query), {
      sessionId: session.id,
      throughCursor,
      fromCursor: 1,
      direction: 'forward',
      limit: 200,
    }),
  )
  assert.equal(history.hasLater, false)
  const serialized = JSON.stringify(history)
  assert.ok(serialized.includes('[redacted]'))
  const events = publicResult(
    'event-page',
    await page.evaluate((query) => window.agentMatrix.sessions.readEvents(query), {
      sessionId: session.id,
      afterCursor: current.cursor,
      limit: 500,
    }),
  )
  assert.equal(events.hasMore, false)
  assert.equal(events.latestCursor, throughCursor)
  assert.deepEqual(
    events.events,
    deliveries.map((delivery) => delivery.event),
  )
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
  await chooseOption(page, languageSelect(page), locale)
  await page.waitForFunction((value) => document.documentElement.lang === value, locale)
  await page
    .getByRole('navigation')
    .getByRole('button', { name: locale === 'en' ? 'Sessions' : '会话', exact: true })
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
  assertMasked(await dialog.innerText(), 'localized configuration report')
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
    for (const value of forbidden)
      assert.ok(
        !contents.includes(value),
        `Plaintext secret in application-owned file ${entry.name}`,
      )
    if (path.startsWith(join(dataDirectory, 'sessions')))
      for (const value of [credentialId, 'ROTATION_ENVIRONMENT'])
        assert.ok(!contents.includes(value), 'Journal exposed a credential reference')
  }
}
async function inspectPublicState() {
  const values = await page.evaluate(async () => {
    const workspace = await window.agentMatrix.loadWorkspace()
    return {
      workspace,
      info: await window.agentMatrix.getAppInfo(),
      credentials: await window.agentMatrix.getCredentialStatus(),
      sessions: await window.agentMatrix.sessions.list(),
      unused: await window.agentMatrix.sessions.unusedRunData({}),
      pending: await window.agentMatrix.sessions.pendingRemovals(),
      impact: await window.agentMatrix.sessions.impact({
        revision: workspace.revision,
        change: { collection: 'models', entry: { ...workspace.models[0], name: 'Preview only' } },
      }),
    }
  })
  for (const [surface, value] of Object.entries(values)) publicResult(surface, value)
}
try {
  await launch()
  const credential = publicResult(
    'credential-write',
    await page.evaluate((input) => window.agentMatrix.setCredential(input), {
      id: credentialId,
      name: 'Rotation fixture key',
      kind: 'api-key',
      value: firstKey,
      expectedRevision: null,
    }),
  )
  await inspectPublicState()
  const originals = [],
    newer = [],
    manifests = new Map()
  for (const engine of engines) {
    publicResult(
      'probe',
      await page.evaluate(
        (installationId) => window.agentMatrix.probeEngine({ installationId }),
        engine.id,
      ),
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
  publicResult(
    'credential-write',
    await page.evaluate((input) => window.agentMatrix.setCredential(input), {
      id: credentialId,
      name: credential.name,
      kind: 'api-key',
      value: secondKey,
      expectedRevision: 1,
    }),
  )
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
    publicResult(
      'export-receipt',
      await page.evaluate((query) => window.agentMatrix.sessions.exportHistory(query), {
        sessionId: session.id,
        throughCursor: (await get(session.id)).cursor,
      }),
    )
    const exported = await readFile(target, 'utf8')
    assert.ok(exported.includes('[redacted]'))
    assertMasked(exported, 'exported JSONL')
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
  await inspectPublicState()
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
  await inspectPublicState()
  await app.close()
  app = undefined
  assert.equal(liveTurns.length, 20)
  assert.equal(fragmentedStreams, 20)
  for (const [stream, chunks] of Object.entries(processLogs))
    assertMasked(Buffer.concat(chunks).toString('utf8'), `Electron ${stream}`)
  assertMasked(rendererConsole.join('\n'), 'renderer console')
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
    credentialEchoForms: ['raw', 'json-escaped', 'url-encoded'],
    providerChunkCharacters: 13,
    fragmentedPrimaryStreams: fragmentedStreams,
    liveTurns,
    successfulPublicResponseChecks: Object.fromEntries(publicChecks),
    electronOutputBytes: Object.fromEntries(
      Object.entries(processLogs).map(([stream, chunks]) => [
        stream,
        chunks.reduce((size, chunk) => size + chunk.length, 0),
      ]),
    ),
    rendererConsoleMessagesChecked: rendererConsole.length,
    electronOutputAndRendererConsoleRedacted: true,
    userInputAndLiveEventEncodingsRedacted: true,
    nativeProviderReceivesSubmittedInput: true,
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
