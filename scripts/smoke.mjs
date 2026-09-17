import assert from 'node:assert/strict'
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { _electron as electron } from 'playwright'

const dataDirectory = await mkdtemp(join(tmpdir(), 'agent-matrix-smoke-'))
const runtimeErrors = []
const env = { ...process.env, AGENT_MATRIX_DATA_DIR: dataDirectory }
delete env.ELECTRON_RUN_AS_NODE
let app
let page
let savedCredential
const syntheticSecret = 'agentmatrix-synthetic-smoke-secret'
const legacy = {
  schemaVersion: 1,
  revision: 7,
  agents: [
    {
      id: 'legacy-agent',
      name: 'Legacy Agent',
      description: 'Keep this agent',
      enabled: true,
      provider: 'openai-compatible',
      model: 'legacy-model',
      baseUrl: '',
      systemPrompt: 'Keep original prompt 中文',
      temperature: 0.7,
      mcpServerIds: [],
      skillIds: ['legacy-skill'],
      pluginIds: ['legacy-bundle'],
    },
  ],
  mcpServers: [
    {
      id: 'legacy-mcp',
      name: 'Legacy MCP',
      description: '',
      enabled: true,
      transport: 'stdio',
      command: 'legacy-mcp',
      args: ['--keep', ''],
      envRefs: { TOKEN: 'LEGACY_TOKEN' },
    },
  ],
  skills: [
    {
      id: 'legacy-skill',
      name: 'Legacy Skill',
      description: '',
      enabled: true,
      sourcePath: '',
      instructions: 'Keep this skill',
    },
  ],
  plugins: [
    {
      id: 'legacy-bundle',
      name: 'Legacy Bundle',
      description: '',
      enabled: true,
      version: '1.0.0',
      mcpServerIds: ['legacy-mcp'],
      skillIds: ['legacy-skill'],
    },
  ],
}
const legacyBytes = `${JSON.stringify(legacy, null, 4)}\n`
await writeFile(join(dataDirectory, 'workspace.json'), legacyBytes)

async function launch() {
  app = await electron.launch({ args: ['.'], env, timeout: 30000 })
  page = await app.firstWindow({ timeout: 30000 })
  page.setDefaultTimeout(15000)
  page.on('pageerror', (error) => runtimeErrors.push(error.message))
  page.on('console', (message) => {
    if (message.type() === 'error') runtimeErrors.push(message.text())
  })
  await page.locator('.card-grid').waitFor()
  assert.equal(
    await page.evaluate(() => window.agentMatrix.getAppInfo().then((info) => info.storage)),
    'desktop',
  )
}
const state = () => page.evaluate(() => window.agentMatrix.loadWorkspace())
async function language(locale) {
  await page.locator('.language-select select').first().selectOption(locale)
  await page.waitForFunction((expected) => document.documentElement.lang === expected, locale)
}
async function navigate(label) {
  await page
    .getByRole('navigation')
    .getByRole('button', { name: new RegExp(`^${label}`) })
    .click()
}
async function saveResource() {
  await page
    .getByRole('dialog')
    .getByRole('button', { name: 'Save configuration', exact: true })
    .click()
  await page.getByRole('dialog').waitFor({ state: 'hidden' })
}
async function addResource(nav, name, fill) {
  await navigate(nav)
  const item = {
    Engines: 'Engine',
    Connections: 'Connection',
    Models: 'Model',
    'Shared prompts': 'Prompt',
    Skills: 'Skill',
    'MCP Servers': 'MCP Server',
    'Resource bundles': 'Resource bundle',
    'Native plugins': 'Native plugin',
  }[nav]
  await page.getByRole('button', { name: `Add ${item}`, exact: true }).click()
  const dialog = page.getByRole('dialog')
  await dialog.getByLabel('Name', { exact: true }).fill(name)
  await fill(dialog)
  await saveResource()
}
async function editResource(nav, name) {
  await navigate(nav)
  await page.getByRole('button', { name: `Edit ${name}`, exact: true }).click()
  return page.getByRole('dialog')
}

try {
  await launch()
  await language('en')
  const migrated = await state()
  assert.equal(migrated.schemaVersion, 2)
  assert.equal(migrated.revision, 7)
  assert.equal(migrated.agents[0].engineInstallationId, null)
  assert.equal(migrated.agents[0].promptBindings[0].mode, null)
  assert.equal(migrated.prompts[0].versions[0].content, legacy.agents[0].systemPrompt)
  assert.deepEqual(migrated.agents[0].bundleIds, ['legacy-bundle'])
  assert.deepEqual(migrated.mcpServers[0].args, ['--keep', ''])
  assert.deepEqual(migrated.mcpServers[0].envRefs.TOKEN, {
    kind: 'environment',
    name: 'LEGACY_TOKEN',
  })
  const backups = (await readdir(dataDirectory)).filter((name) => name.endsWith('.bak'))
  assert.equal(backups.length, 1)
  assert.equal(await readFile(join(dataDirectory, backups[0]), 'utf8'), legacyBytes)

  await page.getByRole('button', { name: 'Create Agent', exact: true }).click()
  await page.getByLabel('Name', { exact: true }).fill('')
  await page.getByRole('button', { name: 'Save Agent', exact: true }).click()
  await page.getByRole('alert').filter({ hasText: 'Name is required.' }).waitFor()
  page.once('dialog', (dialog) => {
    assert.equal(dialog.message(), 'Discard your unsaved changes?')
    return dialog.accept()
  })
  await page.getByRole('button', { name: 'Cancel', exact: true }).click()
  await language('zh-CN')
  await page.getByRole('heading', { name: '我的 Agents', exact: true }).waitFor()
  assert.deepEqual(await state(), migrated)
  await language('en')

  for (const [kind, name] of [
    ['opencode', 'Smoke OpenCode'],
    ['pi', 'Smoke Pi'],
    ['deepseek-harness', 'Smoke DSH'],
  ]) {
    await addResource('Engines', name, async (dialog) => {
      await dialog.getByLabel('Engine product', { exact: true }).selectOption(kind)
      await dialog.getByLabel('Executable path', { exact: true }).fill(`/opt/smoke/${kind}`)
    })
  }
  await addResource('Connections', 'Smoke Connection', async (dialog) => {
    await dialog.getByLabel('API protocol', { exact: true }).selectOption('openai-chat-completions')
    await dialog.getByLabel('API Base URL', { exact: true }).fill('http://localhost:12345/v1')
    await dialog.getByLabel('Authentication', { exact: true }).selectOption('bearer')
    await dialog.getByLabel('Credential reference', { exact: true }).selectOption('environment')
    await dialog
      .getByLabel('Environment variable name', { exact: true })
      .fill('AGENTMATRIX_SMOKE_KEY')
  })
  await addResource('Models', 'Smoke Model', async (dialog) => {
    await dialog
      .getByLabel('Model connection', { exact: true })
      .selectOption({ label: 'Smoke Connection' })
    await dialog.getByLabel('Model ID', { exact: true }).fill('test-model')
    assert.equal(await dialog.getByLabel('Temperature', { exact: true }).inputValue(), '')
  })
  await addResource('Shared prompts', 'Smoke Prompt', async (dialog) => {
    await dialog.getByLabel('Prompt purpose', { exact: true }).selectOption('role')
    await dialog.getByLabel('Prompt content', { exact: true }).fill('Shared original instructions')
  })
  await addResource('Skills', 'Smoke Skill', async (dialog) => {
    await dialog
      .getByLabel('Skill instructions', { exact: true })
      .fill('Respond with a clear summary.')
  })
  await addResource('MCP Servers', 'Smoke MCP', async (dialog) => {
    await dialog.getByLabel('Command', { exact: true }).fill('example-mcp')
    await dialog.getByLabel('Arguments', { exact: true }).fill('--test\nworkspace')
  })
  await addResource('Resource bundles', 'Smoke Bundle', async (dialog) => {
    await dialog.getByRole('checkbox', { name: /Smoke Prompt/ }).check()
    await dialog
      .getByLabel('Instruction mode · Smoke Prompt', { exact: true })
      .selectOption('append')
    await dialog.getByRole('checkbox', { name: /Smoke MCP/ }).check()
    await dialog.getByRole('checkbox', { name: /Smoke Skill/ }).check()
  })

  for (const [engineName, agentName] of [
    ['Smoke OpenCode', 'Smoke Agent'],
    ['Smoke Pi', 'Pi Agent'],
    ['Smoke DSH', 'DSH Agent'],
  ]) {
    await navigate('My Agents')
    await page.getByRole('button', { name: 'Create Agent', exact: true }).click()
    const dialog = page.getByRole('dialog')
    await dialog.getByLabel('Name', { exact: true }).fill(agentName)
    const current = await state()
    await dialog
      .getByLabel('Engine installation', { exact: true })
      .selectOption(current.installations.find((item) => item.name === engineName).id)
    await dialog
      .getByLabel('Model profile', { exact: true })
      .selectOption(current.models.find((item) => item.name === 'Smoke Model').id)
    await dialog
      .getByLabel('Working directory', { exact: true })
      .fill('/tmp/agentmatrix-smoke-project')
    await dialog.getByRole('tab', { name: 'Bindings', exact: true }).click()
    await dialog.getByRole('checkbox', { name: /Smoke Prompt/ }).check()
    await dialog
      .getByLabel('Instruction mode · Smoke Prompt', { exact: true })
      .selectOption('append')
    if (agentName === 'Smoke Agent')
      await dialog.getByLabel('Version selection · Smoke Prompt', { exact: true }).selectOption('1')
    if (agentName === 'Pi Agent')
      await dialog.getByRole('checkbox', { name: /Smoke Skill/ }).check()
    else await dialog.getByRole('checkbox', { name: /Smoke Bundle/ }).check()
    await dialog.getByRole('tab', { name: 'Resolved preview', exact: true }).click()
    await dialog
      .getByText('The engine installation must be verified before launch.', { exact: true })
      .waitFor()
    await dialog.getByRole('button', { name: 'Save Agent', exact: true }).click()
    await dialog.waitFor({ state: 'hidden' })
  }
  let current = await state()
  assert.equal(current.agents.length, 4)
  assert.ok(current.installations.every((item) => item.probedAt === null))
  assert.deepEqual(current.models.find((item) => item.name === 'Smoke Model').parameters, {})
  assert.deepEqual(current.mcpServers.find((item) => item.name === 'Smoke MCP').args, [
    '--test',
    'workspace',
  ])
  assert.equal(current.agents.find((item) => item.name === 'Pi Agent').engineOptions.kind, 'pi')
  assert.equal(
    current.agents.find((item) => item.name === 'DSH Agent').engineOptions.profileTemplate,
    'acp',
  )

  let dialog = await editResource('Shared prompts', 'Smoke Prompt')
  await dialog.getByLabel('Prompt content', { exact: true }).fill('Shared updated instructions')
  await saveResource()
  current = await state()
  const prompt = current.prompts.find((item) => item.name === 'Smoke Prompt')
  assert.equal(prompt.currentVersion, 2)
  assert.equal(prompt.versions[0].content, 'Shared original instructions')
  assert.deepEqual(
    current.agents.find((item) => item.name === 'Smoke Agent').promptBindings[0].selection,
    { follow: 'pinned', version: 1 },
  )
  assert.deepEqual(
    current.agents.find((item) => item.name === 'Pi Agent').promptBindings[0].selection,
    { follow: 'latest' },
  )
  dialog = await editResource('Skills', 'Smoke Skill')
  await dialog.getByLabel('Skill instructions', { exact: true }).fill('Revised skill content')
  await saveResource()
  assert.equal(
    (await state()).skills.find((item) => item.name === 'Smoke Skill').versions.length,
    2,
  )

  const preferences = await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0].webContents.getLastWebPreferences(),
  )
  assert.equal(preferences.contextIsolation, true)
  assert.equal(preferences.nodeIntegration, false)
  assert.equal(preferences.sandbox, true)
  await navigate('My Agents')
  if (process.env.AGENT_MATRIX_SCREENSHOT)
    await page.screenshot({ path: process.env.AGENT_MATRIX_SCREENSHOT, fullPage: true })
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1000, 680))
  await page.getByRole('button', { name: 'Settings', exact: true }).click()
  await page.getByRole('heading', { name: 'Language', exact: true }).waitFor()
  const credentialStatus = await page.evaluate(() => window.agentMatrix.getCredentialStatus())
  if (credentialStatus.available) {
    await page.getByLabel('Credential name', { exact: true }).fill('Smoke credential')
    await page.getByLabel('Secret value', { exact: true }).fill(syntheticSecret)
    await page.getByRole('button', { name: 'Save credential', exact: true }).click()
    await page.getByRole('status').filter({ hasText: 'Credential saved.' }).waitFor()
    const status = await page.evaluate(() => window.agentMatrix.getCredentialStatus())
    savedCredential = status.credentials[0]
    assert.ok(!JSON.stringify(status).includes(syntheticSecret))
    assert.equal(await page.getByLabel('Secret value', { exact: true }).inputValue(), '')
    const bytes = await readFile(join(dataDirectory, 'credentials', 'vault.json'), 'utf8')
    assert.ok(!bytes.includes(syntheticSecret))
    const decoded = await app.evaluate(
      async ({ safeStorage }, encrypted) =>
        (await safeStorage.decryptStringAsync(Buffer.from(encrypted, 'base64'))).result,
      JSON.parse(bytes).entries[0].ciphertext,
    )
    assert.equal(decoded, syntheticSecret)
    if (process.env.AGENT_MATRIX_CREDENTIAL_SCREENSHOT)
      await page.screenshot({
        path: process.env.AGENT_MATRIX_CREDENTIAL_SCREENSHOT,
        fullPage: true,
      })
    dialog = await editResource('Connections', 'Smoke Connection')
    await dialog.getByLabel('Credential reference', { exact: true }).selectOption('credential')
    await dialog.getByLabel('Saved credential', { exact: true }).selectOption(savedCredential.id)
    await saveResource()
    const workspaceBytes = await readFile(join(dataDirectory, 'workspace.json'), 'utf8')
    assert.ok(!workspaceBytes.includes(syntheticSecret))
    assert.deepEqual(
      (await state()).connections.find((item) => item.name === 'Smoke Connection').auth.secret,
      { kind: 'credential', id: savedCredential.id },
    )
  } else {
    assert.equal(
      await page.getByRole('button', { name: 'Save credential', exact: true }).isDisabled(),
      true,
    )
  }
  await language('zh-CN')
  await page.reload()
  await page.getByRole('heading', { name: '我的 Agents', exact: true }).waitFor()
  await app.close()
  await launch()
  assert.equal(await page.locator('html').getAttribute('lang'), 'zh-CN')
  assert.equal((await readdir(dataDirectory)).filter((name) => name.endsWith('.bak')).length, 1)
  await page.getByRole('button', { name: '编辑 Smoke Agent', exact: true }).click()
  await page.getByLabel('名称', { exact: true }).fill('Updated Agent')
  await page.getByRole('tab', { name: '解析预览', exact: true }).click()
  await page.getByText('启动前需要验证引擎安装。', { exact: true }).waitFor()
  await page.getByRole('button', { name: '保存 Agent', exact: true }).click()
  await page.getByRole('dialog').waitFor({ state: 'hidden' })
  await page.getByRole('button', { name: '停用 Updated Agent', exact: true }).click()
  await page.getByRole('button', { name: '启用 Updated Agent', exact: true }).waitFor()
  await language('en')
  if (savedCredential) {
    assert.deepEqual(
      (await page.evaluate(() => window.agentMatrix.getCredentialStatus())).credentials,
      [savedCredential],
    )
    await page.getByRole('button', { name: 'Settings', exact: true }).click()
    await page.getByRole('button', { name: 'Replace secret', exact: true }).click()
    assert.equal(await page.getByLabel('Secret value', { exact: true }).inputValue(), '')
    await page.getByLabel('Secret value', { exact: true }).fill('replacement-synthetic-secret')
    await page
      .locator('.credential-panel form')
      .getByRole('button', { name: 'Replace secret', exact: true })
      .click()
    await page.getByRole('status').filter({ hasText: 'Credential saved.' }).waitFor()
    assert.equal(
      (await page.evaluate(() => window.agentMatrix.getCredentialStatus())).credentials[0].revision,
      2,
    )
    page.once('dialog', (dialog) => dialog.accept())
    await page.getByRole('button', { name: 'Delete credential', exact: true }).click()
    await page.getByRole('status').filter({ hasText: 'Credential deleted.' }).waitFor()
    assert.deepEqual(
      (await page.evaluate(() => window.agentMatrix.getCredentialStatus())).credentials,
      [],
    )
  }
  await navigate('MCP Servers')
  page.once('dialog', (dialog) => dialog.accept())
  await page.getByRole('button', { name: 'Delete Smoke MCP', exact: true }).click()
  await page
    .getByRole('button', { name: 'Edit Smoke MCP', exact: true })
    .waitFor({ state: 'hidden' })
  current = await state()
  assert.deepEqual(current.bundles.find((item) => item.name === 'Smoke Bundle').mcpServerIds, [])
  assert.deepEqual(current.bundles.find((item) => item.name === 'Legacy Bundle').mcpServerIds, [
    'legacy-mcp',
  ])
  await navigate('Connections')
  page.once('dialog', (dialog) => dialog.accept())
  await page.getByRole('button', { name: 'Delete Smoke Connection', exact: true }).click()
  await page
    .getByRole('button', { name: 'Edit Smoke Connection', exact: true })
    .waitFor({ state: 'hidden' })
  current = await state()
  assert.equal(current.models.find((item) => item.name === 'Smoke Model').connectionId, null)
  assert.equal(current.agents.find((item) => item.name === 'Updated Agent').enabled, false)
  assert.deepEqual(
    JSON.parse(await readFile(join(dataDirectory, 'workspace.json'), 'utf8')),
    current,
  )
  assert.deepEqual(runtimeErrors, [])
  console.log(
    'Desktop smoke passed: exact-byte v1 backup/migration, shared connections/models/credentials, all three engine drafts, prompt and Skill revisions, pinned/latest bindings, bundles, diagnostics, reference cleanup, bilingual UI/restart, and OS credential encryption/replacement/deletion.',
  )
} catch (error) {
  if (page && !page.isClosed()) {
    console.error('Desktop state at failure:', await page.locator('body').innerText())
    if (process.env.AGENT_MATRIX_SCREENSHOT)
      await page.screenshot({ path: process.env.AGENT_MATRIX_SCREENSHOT, fullPage: true })
  }
  console.error('Renderer errors:', runtimeErrors)
  throw error
} finally {
  await app?.close().catch(() => {})
  await rm(dataDirectory, { recursive: true, force: true })
}
