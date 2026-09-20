import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { isAbsolute, join } from 'node:path'
import { _electron as electron } from 'playwright'
import { openCodeWorkspace } from '../tests/helpers/opencode-fixture.ts'
import { chooseOption, languageSelect } from './lib/select.mjs'

// One workspace, one connection, and one revision history for each shared asset.
// Only the native folder chooser is substituted; all edits and session actions use the UI.
const engines = ['opencode', 'pi', 'dsh']
const executables = Object.fromEntries(
  engines.map((engine) => {
    const path = process.env[`AGENT_MATRIX_TEST_${engine.toUpperCase()}`]
    assert.ok(
      path && isAbsolute(path),
      `Set AGENT_MATRIX_TEST_${engine.toUpperCase()} to an absolute executable`,
    )
    return [engine, path]
  }),
)
const root = await realpath(await mkdtemp(join(tmpdir(), 'agentmatrix-shared-assets-')))
const dataDirectory = join(root, 'data'),
  cwd = join(root, 'project 中文'),
  home = join(root, 'home'),
  source = join(root, 'shared skill source')
for (const directory of [dataDirectory, home, join(cwd, '.git'), join(source, 'references')])
  await mkdir(directory, { recursive: true })
const promptText = (version) => `Shared desktop instructions. SHARED_PROMPT_V${version}.`
const skillText = (version) =>
  `---\nname: shared-acceptance\ndescription: Shared directory workflow revision ${version}\n---\nSHARED_SKILL_BODY_V${version}\nRead references/guide.md.\n`
const referenceText = (version) => `SHARED_SKILL_REFERENCE_V${version}\n`
async function sourceRevision(version) {
  await writeFile(join(source, 'SKILL.md'), skillText(version))
  await writeFile(join(source, 'references/guide.md'), referenceText(version))
}
await sourceRevision(1)
const versions = { opencode: '1.18.16', pi: '0.85.1', dsh: '0.1.5-rc.2' }
const engineOptions = {
  opencode: { kind: 'opencode', agent: 'build' },
  pi: { kind: 'pi', projectTrust: 'deny', contextFiles: 'inherit' },
  dsh: { kind: 'deepseek-harness', profileTemplate: 'acp', patchReload: 'startup' },
}
const workspace = openCodeWorkspace(executables.opencode, cwd)
workspace.installations = engines.map((engine) => ({
  ...workspace.installations[0],
  id: engine,
  name: engine,
  kind: engineOptions[engine].kind,
  executable: executables[engine],
  version: null,
  probedAt: null,
  modes: [],
}))
workspace.agents = engines.map((engine) => ({
  ...workspace.agents[0],
  id: engine,
  name: engine,
  engineInstallationId: engine,
  engineOptions: engineOptions[engine],
  execution: { cwd, approval: 'unrestricted' },
  promptBindings: [{ assetId: 'role', mode: 'append', selection: { follow: 'latest' } }],
  skillBindings: [],
}))
workspace.prompts = [
  {
    ...workspace.prompts[0],
    name: 'Shared acceptance prompt',
    versions: [{ version: 1, content: promptText(1) }],
  },
]
workspace.skills = []
workspace.connections[0].headers = {}
workspace.connections[0].auth.secret.name = 'AGENT_MATRIX_SHARED_ASSETS_KEY'
const secret = 'synthetic-shared-assets-fixture-key'
let serverError,
  app,
  page,
  passed = false,
  serial = 0
const errors = [],
  observations = []
const activeTurns = new Map()
const server = createServer(async (request, response) => {
  try {
    let body = ''
    for await (const chunk of request) {
      body += String(chunk)
      assert.ok(body.length <= 4_194_304, 'Provider fixture request bound')
    }
    const input = JSON.parse(body)
    assert.equal(request.url, '/v1/chat/completions')
    assert.equal(request.headers.authorization, `Bearer ${secret}`)
    assert.equal(input.model, 'fixture-model')
    const main = input.tools?.some((tool) => tool.function?.name === 'read')
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
              message: { role: 'assistant', content: 'Shared asset check' },
              finish_reason: 'stop',
            },
          ],
          usage: { prompt_tokens: 10, completion_tokens: 3, total_tokens: 13 },
        }),
      )
      return
    }
    let delta = { role: 'assistant', content: 'Shared asset check' },
      finish = 'stop'
    if (main) {
      // Native Skill loading can append its own user-role context after the submitted prompt.
      const turnToken = input.messages
        .filter((message) => message.role === 'user')
        .map((message) => /Turn (asset-\d+)\./.exec(JSON.stringify(message.content))?.[1])
        .filter(Boolean)
        .at(-1)
      const active = activeTurns.get(turnToken)
      assert.ok(active, 'Unexpected model turn outside the selected UI action')
      const { engine, version, token, skillPath } = active
      const system = JSON.stringify(
        input.messages.filter((message) => ['system', 'developer'].includes(message.role)),
      )
      assert.ok(system.includes(`SHARED_PROMPT_V${version}`), `${engine}: selected prompt missing`)
      assert.ok(
        !system.includes(`SHARED_PROMPT_V${version === 1 ? 2 : 1}`),
        `${engine}: another prompt revision leaked`,
      )
      const result = (id, expected) => {
        const message = input.messages.find(
          (value) => value.role === 'tool' && value.tool_call_id === id,
        )
        assert.ok(message, `${engine}: missing current-turn result ${id}`)
        assert.ok(
          JSON.stringify(message.content).includes(expected),
          `${engine}: wrong captured Skill content for ${id}: ${JSON.stringify(message.content)}`,
        )
        assert.ok(
          !JSON.stringify(message.content).includes('UNIMPORTED_SOURCE'),
          'Live source leaked into captured Skill',
        )
      }
      const read = (path) => ({
        name: 'read',
        arguments: JSON.stringify(
          engine === 'pi' ? { path } : engine === 'dsh' ? { file_path: path } : { filePath: path },
        ),
      })
      let tool
      if (active.step === 0) {
        tool =
          engine === 'pi'
            ? read(join(skillPath, 'SKILL.md'))
            : { name: 'skill', arguments: JSON.stringify({ name: 'shared-acceptance' }) }
      } else if (active.step === 1) {
        result(`${token}-entry`, `SHARED_SKILL_BODY_V${version}`)
        tool = read(join(skillPath, 'references/guide.md'))
      } else {
        assert.equal(active.step, 2, 'Unexpected repeated provider request')
        result(`${token}-entry`, `SHARED_SKILL_BODY_V${version}`)
        result(`${token}-reference`, `SHARED_SKILL_REFERENCE_V${version}`)
        delta = { role: 'assistant', content: `SHARED_ASSET_REPLY_${token}` }
        active.verified = true
      }
      if (tool) {
        assert.ok(
          input.tools.some((value) => value.function?.name === tool.name),
          'Required native tool was not advertised',
        )
        delta = {
          role: 'assistant',
          tool_calls: [
            {
              index: 0,
              id: `${token}-${active.step === 0 ? 'entry' : 'reference'}`,
              type: 'function',
              function: tool,
            },
          ],
        }
        finish = 'tool_calls'
      }
      if (active.step === 0 && active.gate) {
        active.held = true
        await active.gate
      }
      active.step++
    }
    response.writeHead(200, { 'Content-Type': 'text/event-stream' })
    const chunk = (value, finish_reason = null) =>
      response.write(
        `data: ${JSON.stringify({
          id: 'fixture',
          object: 'chat.completion.chunk',
          created: 1,
          model: input.model,
          choices: [{ index: 0, delta: value, finish_reason }],
        })}\n\n`,
      )
    chunk(delta)
    chunk({}, finish)
    response.end('data: [DONE]\n\n')
  } catch (error) {
    serverError ??= error
    if (!response.headersSent) response.writeHead(500)
    response.end()
  }
})
const state = () => page.evaluate(() => window.agentMatrix.loadWorkspace())
const sessions = () => page.evaluate(() => window.agentMatrix.sessions.list())
const session = (id) =>
  page.evaluate((sessionId) => window.agentMatrix.sessions.get({ sessionId }), id)
async function poll(check, label, timeout = 45_000) {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    if (serverError) throw serverError
    if (await check()) return
    await new Promise((resolve) => setTimeout(resolve, 30))
  }
  throw new Error(`Timed out waiting for ${label}`)
}
async function launch() {
  const env = {
    ...process.env,
    HOME: home,
    XDG_CONFIG_HOME: join(home, '.config'),
    AGENT_MATRIX_DATA_DIR: dataDirectory,
    AGENT_MATRIX_SHARED_ASSETS_KEY: secret,
  }
  delete env.ELECTRON_RUN_AS_NODE
  app = await electron.launch({ args: ['.'], env, timeout: 30_000 })
  page = await app.firstWindow()
  page.setDefaultTimeout(20_000)
  page.on('pageerror', (error) => errors.push(error.message))
  await page.locator('.card-grid').waitFor()
  await language('en')
}
async function language(locale) {
  await chooseOption(page, languageSelect(page), locale)
  await page.waitForFunction((value) => document.documentElement.lang === value, locale)
}
async function navigate(name) {
  await page
    .getByRole('navigation')
    .getByRole('button', { name: new RegExp(`^${name}`) })
    .click()
}
async function chooseDirectory() {
  await app.evaluate(({ dialog }, path) => {
    const original = dialog.showOpenDialog
    dialog.showOpenDialog = async () => {
      dialog.showOpenDialog = original
      return { canceled: false, filePaths: [path] }
    }
  }, source)
}
async function saveResource(locale = 'en') {
  await page
    .getByRole('dialog')
    .getByRole('button', { name: locale === 'en' ? 'Save configuration' : '保存配置', exact: true })
    .click()
  await page.getByRole('dialog').waitFor({ state: 'hidden' })
}
async function select(id) {
  await language('en')
  await navigate('Sessions')
  await page.locator(`[data-session-list-id="${id}"]`).click()
  await page.locator(`.conversation[data-session-id="${id}"]`).waitFor()
}
async function ready(id) {
  await poll(async () => {
    const value = await session(id)
    assert.ok(!value.failure, `Session failed: ${JSON.stringify(value.failure)}`)
    return value.status === 'ready'
  }, `${id} Ready`)
  await page
    .getByTestId('session-status')
    .filter({ hasText: /^Ready$/ })
    .waitFor()
}
async function create(engine) {
  await navigate('Sessions')
  await chooseOption(page, page.getByLabel('Agent configuration', { exact: true }), engine)
  const before = new Set((await sessions()).map((value) => value.id))
  await page.getByRole('button', { name: 'Start new session', exact: true }).click()
  let created
  await poll(async () => {
    created = (await sessions()).find((value) => !before.has(value.id))
    return Boolean(created)
  }, `${engine} session creation`)
  await ready(created.id)
  return session(created.id)
}
let skillId
async function report(id, version, nextVersion, current = true) {
  let result
  for (const locale of ['en', 'zh-CN']) {
    await language(locale)
    const title = locale === 'en' ? 'Configuration report' : '配置报告'
    await page.getByRole('button', { name: title, exact: true }).click()
    const dialog = page.getByRole('dialog', { name: title, exact: true })
    await dialog.locator(`[data-report-asset="${skillId}"]`).waitFor()
    result = await page.evaluate(
      (sessionId) => window.agentMatrix.sessions.configuration({ sessionId }),
      id,
    )
    assert.equal(result.savedState, version === nextVersion ? 'same' : 'pending')
    assert.equal(result.observationIsCurrent, current)
    assert.equal(result.assets.length, 2)
    for (const assetId of ['role', skillId]) {
      const asset = result.assets.find((value) => value.id === assetId)
      assert.deepEqual(
        [asset.version, asset.nextVersion, asset.libraryVersion],
        [version, nextVersion, nextVersion],
      )
      assert.ok(asset.digest)
      const cells = await dialog.locator(`[data-report-asset="${assetId}"] td`).allTextContents()
      assert.deepEqual(cells, [`v${version}`, `v${nextVersion}`, `v${nextVersion}`])
    }
    await dialog
      .getByRole('button', { name: locale === 'en' ? 'Close' : '关闭', exact: true })
      .last()
      .click()
  }
  await language('en')
  return result
}
const capturedManifests = new Map()
async function beginTurn(engine, snapshot, version, phase, hold = false) {
  await select(snapshot.id)
  await ready(snapshot.id)
  const config = await page.evaluate(
    (sessionId) => window.agentMatrix.sessions.configuration({ sessionId }),
    snapshot.id,
  )
  const skillPath = join(
    dataDirectory,
    'runs',
    snapshot.snapshotId,
    'inputs',
    config.assets.find((asset) => asset.id === skillId).path,
  )
  assert.equal(await readFile(join(skillPath, 'SKILL.md'), 'utf8'), skillText(version))
  assert.equal(
    await readFile(join(skillPath, 'references/guide.md'), 'utf8'),
    referenceText(version),
  )
  const before = await session(snapshot.id)
  const token = `asset-${++serial}`
  const active = {
    engine,
    version,
    token,
    skillPath,
    snapshot,
    before,
    phase,
    step: 0,
    verified: false,
  }
  if (hold)
    active.gate = new Promise((resolve) => {
      active.release = resolve
    })
  activeTurns.set(token, active)
  await page
    .getByRole('textbox', { name: 'Message', exact: true })
    .fill(`Run shared-acceptance and read its guide again. Turn ${token}.`)
  await page.getByRole('button', { name: 'Send message', exact: true }).click()
  if (hold) {
    await poll(() => active.held, `${engine} held provider response`)
    assert.equal((await session(snapshot.id)).status, 'running')
  }
  return active
}
async function finishTurn(active) {
  const { engine, snapshot, version, phase, token, before } = active
  await poll(async () => {
    const value = await session(snapshot.id)
    assert.ok(!value.failure, `Turn failed: ${JSON.stringify(value.failure)}`)
    return value.status === 'ready' && value.lastTurn && value.lastTurn.id !== before.lastTurn?.id
  }, `${engine} ${phase} turn`)
  assert.ok(active.verified)
  assert.equal(active.step, 3)
  await select(snapshot.id)
  await ready(snapshot.id)
  await page
    .locator('.message.assistant pre')
    .filter({ hasText: `SHARED_ASSET_REPLY_${token}` })
    .waitFor()
  observations.push({
    engine,
    phase,
    promptVersion: version,
    skillVersion: version,
    nativeSkillEntryRead: true,
    nativeReferenceRead: true,
    streamedProviderRoundTrip: true,
    requests: active.step,
  })
  activeTurns.delete(token)
  const value = await session(snapshot.id)
  assert.equal(value.snapshotDigest, snapshot.snapshotDigest)
  const bytes = await readFile(
    join(dataDirectory, 'runs', snapshot.snapshotId, 'manifest.json'),
    'utf8',
  )
  if (capturedManifests.has(snapshot.id)) assert.equal(bytes, capturedManifests.get(snapshot.id))
  else capturedManifests.set(snapshot.id, bytes)
}
async function turn(engine, snapshot, version, phase) {
  await finishTurn(await beginTurn(engine, snapshot, version, phase))
}
async function impact(assetId, originals) {
  const preview = page.getByTestId('library-impact')
  for (const engine of engines)
    await preview.locator(`[data-impact-profile="${engine}"][data-effect="changed"]`).waitFor()
  for (const original of Object.values(originals)) {
    const row = preview.locator(`[data-impact-session="${original.id}"][data-effect="pending"]`)
    await row.locator('summary').click()
    assert.match(
      await row.locator(`[data-impact-asset="${assetId}"]`).textContent(),
      /Retained v1 · Proposed binding v2|保留 v1 · 修改后绑定 v2/,
    )
  }
}
try {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  workspace.connections[0].baseUrl = `http://127.0.0.1:${server.address().port}/v1`
  await writeFile(join(dataDirectory, 'workspace.json'), JSON.stringify(workspace))
  await launch()
  await navigate('Engines')
  for (let index = 0; index < engines.length; index++) {
    const engine = engines[index]
    await page.getByRole('button', { name: 'Check installation', exact: true }).nth(index).click()
    await poll(
      async () =>
        (await state()).installations.find((item) => item.id === engine).version ===
        versions[engine],
      `${engine} version probe`,
    )
  }
  await navigate('Skills')
  await page.getByRole('button', { name: 'Add Skill', exact: true }).click()
  await page.getByRole('dialog').getByLabel('Name', { exact: true }).fill('Shared acceptance skill')
  await chooseDirectory()
  await page.getByRole('button', { name: 'Import Skill directory', exact: true }).click()
  await page.getByText('2 captured files', { exact: false }).waitFor()
  await saveResource()
  skillId = (await state()).skills[0].id
  for (const engine of engines) {
    await navigate('My Agents')
    await page.getByRole('button', { name: `Edit ${engine}`, exact: true }).click()
    const dialog = page.getByRole('dialog')
    await dialog.getByRole('tab', { name: 'Bindings', exact: true }).click()
    await dialog.getByRole('checkbox', { name: /Shared acceptance skill/ }).check()
    await dialog.getByRole('button', { name: 'Save Agent', exact: true }).click()
    await dialog.waitFor({ state: 'hidden' })
  }
  const bound = await state()
  assert.equal(bound.connections.length, 1)
  assert.equal(bound.models.length, 1)
  assert.equal(bound.prompts.length, 1)
  assert.equal(bound.skills.length, 1)
  for (const agent of bound.agents) {
    assert.equal(agent.modelProfileId, bound.models[0].id)
    assert.deepEqual(agent.promptBindings, [
      { assetId: 'role', mode: 'append', selection: { follow: 'latest' } },
    ])
    assert.deepEqual(agent.skillBindings, [{ assetId: skillId, selection: { follow: 'latest' } }])
  }
  const originals = {},
    updated = {}
  for (const engine of engines) {
    originals[engine] = await create(engine)
    await turn(engine, originals[engine], 1, 'original')
    await report(originals[engine].id, 1, 1)
  }
  console.log('Shared v1 prompt and directory Skill verified in all three native engines.')
  const inFlight = []
  for (const engine of engines)
    inFlight.push(await beginTurn(engine, originals[engine], 1, 'running-during-edit', true))
  await navigate('Shared prompts')
  await page.getByRole('button', { name: 'Edit Shared acceptance prompt', exact: true }).click()
  await page.getByLabel('Prompt content', { exact: true }).fill(promptText(2))
  await impact('role', originals)
  await saveResource()
  await sourceRevision(2)
  await language('zh-CN')
  await navigate('Skills')
  await page.getByRole('button', { name: '编辑 Shared acceptance skill', exact: true }).click()
  await chooseDirectory()
  await page.getByRole('button', { name: '导入 Skill 目录', exact: true }).click()
  await poll(
    async () => (await page.getByLabel('版本', { exact: true }).inputValue()) === '2',
    'reimported Skill revision',
  )
  await impact(skillId, originals)
  await saveResource('zh-CN')
  await language('en')
  const edited = await state()
  assert.equal(edited.prompts[0].currentVersion, 2)
  assert.equal(edited.skills[0].currentVersion, 2)
  assert.deepEqual(edited.prompts[0].versions[0], bound.prompts[0].versions[0])
  assert.deepEqual(edited.skills[0].versions[0], bound.skills[0].versions[0])
  assert.deepEqual(edited.agents, bound.agents)
  assert.deepEqual(edited.connections, bound.connections)
  await writeFile(join(source, 'SKILL.md'), 'UNIMPORTED_SOURCE')
  await writeFile(join(source, 'references/guide.md'), 'UNIMPORTED_SOURCE')
  for (const running of inFlight) {
    assert.equal((await session(running.snapshot.id)).status, 'running')
    running.release()
  }
  for (const running of inFlight) await finishTurn(running)
  console.log('Shared edits during three active turns preserved every captured v1 input.')
  for (const engine of engines) {
    await turn(engine, originals[engine], 1, 'old-after-edit')
    await report(originals[engine].id, 1, 2)
    updated[engine] = await create(engine)
    assert.notEqual(updated[engine].snapshotId, originals[engine].snapshotId)
    await turn(engine, updated[engine], 2, 'new-after-edit')
    await report(updated[engine].id, 2, 2)
  }
  await app.close()
  app = undefined
  await rm(source, { recursive: true })
  await launch()
  for (const engine of engines) {
    for (const [version, prior] of [
      [1, originals[engine]],
      [2, updated[engine]],
    ]) {
      await select(prior.id)
      assert.equal((await session(prior.id)).status, 'interrupted')
      await report(prior.id, version, 2, false)
      await page.getByRole('button', { name: 'Resume session', exact: true }).click()
      await ready(prior.id)
      const resumed = await session(prior.id)
      assert.equal(resumed.nativeSessionId, prior.nativeSessionId)
      assert.equal(resumed.snapshotId, prior.snapshotId)
      assert.equal(resumed.snapshotDigest, prior.snapshotDigest)
      assert.notEqual(resumed.runId, prior.runId)
      const checked = await report(prior.id, version, 2)
      assert.equal(checked.observation.runId, resumed.runId)
      await turn(engine, resumed, version, `resumed-v${version}`)
      await page.getByRole('button', { name: 'Close session', exact: true }).click()
      await poll(async () => (await session(prior.id)).status === 'closed', 'confirmed close')
    }
  }
  assert.deepEqual(errors, [])
  assert.equal(observations.length, 18)
  assert.equal(activeTurns.size, 0)
  assert.equal((await sessions()).length, 6)
  const evidence = {
    checkedAt: new Date().toISOString(),
    platform: process.platform,
    architecture: process.arch,
    engines: engines.map((engine) => ({
      engine,
      version: versions[engine],
      executable: executables[engine],
    })),
    service: 'Local synthetic HTTP provider',
    protocol: 'openai-chat-completions',
    model: 'fixture-model',
    externalProviderCalls: false,
    dshRoute: 'dsh-llm-pi-ai',
    sharedLibrary: {
      prompts: 1,
      directorySkills: 1,
      modelProfiles: 1,
      connections: 1,
      agentProfiles: 3,
    },
    desktopInstallationProbes: true,
    realSkillImportAndReimport: true,
    sharedEditsWithoutProfileChanges: true,
    sharedEditsDuringActiveTurns: engines,
    bilingualImpactAndVersionReports: true,
    capturedSourceIndependentAfterEditAndDeletion: true,
    nativeResumePreservesOldAndNewInputs: true,
    freshToolResultsCorrelatedPerTurn: true,
    immutableManifests: true,
    turns: observations,
  }
  if (process.env.AGENT_MATRIX_SHARED_ASSETS_REPORT)
    await writeFile(
      process.env.AGENT_MATRIX_SHARED_ASSETS_REPORT,
      JSON.stringify(evidence, null, 2) + '\n',
    )
  passed = true
  console.log(`Shared assets desktop smoke passed: ${JSON.stringify(evidence)}`)
} finally {
  let cleaned = true
  for (const active of activeTurns.values()) active.release?.()
  if (app)
    await app.close().catch((error) => {
      cleaned = false
      console.error(error)
    })
  await new Promise((resolve) => server.close(resolve))
  if (passed && cleaned) await rm(root, { recursive: true, force: true })
  else console.error(`Retained shared-assets fixture: ${root}`)
}
