import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { _electron as electron } from 'playwright'

const dataDirectory = await mkdtemp(join(tmpdir(), 'agent-matrix-smoke-'))
const runtimeErrors = []
const env = { ...process.env, AGENT_MATRIX_DATA_DIR: dataDirectory }
delete env.ELECTRON_RUN_AS_NODE
let app
async function launch() {
  app = await electron.launch({ args: ['.'], env, timeout: 30000 })
  const page = await app.firstWindow({ timeout: 30000 })
  page.setDefaultTimeout(15000)
  page.on('pageerror', (error) => runtimeErrors.push(error.message))
  page.on('console', (message) => {
    if (message.type() === 'error') runtimeErrors.push(message.text())
  })
  await page.getByRole('heading', { name: '我的 Agents' }).waitFor()
  assert.equal(
    await page.evaluate(() => window.agentMatrix.getAppInfo().then((info) => info.storage)),
    'desktop',
  )
  return page
}
async function addResource(page, nav, title, fill) {
  await page.getByRole('navigation').getByRole('button', { name: nav }).click()
  await page
    .getByRole('button', { name: `添加 ${title}`, exact: true })
    .first()
    .click()
  await fill(page.getByRole('dialog'))
  await page.getByRole('button', { name: '保存配置', exact: true }).click()
  await page.getByRole('dialog').waitFor({ state: 'hidden' })
}

try {
  let page = await launch()
  await addResource(page, 'MCP Servers', 'MCP Server', async (dialog) => {
    await dialog.getByLabel('名称', { exact: true }).fill('Smoke MCP')
    await dialog.getByLabel('启动命令', { exact: true }).fill('example-mcp')
    await dialog.getByLabel('参数', { exact: false }).fill('--test\nworkspace')
  })
  await addResource(page, 'Skills', 'Skill', async (dialog) => {
    await dialog.getByLabel('名称', { exact: true }).fill('Smoke Skill')
    await dialog.getByLabel('Skill 指令', { exact: true }).fill('Respond with a clear summary.')
  })
  await addResource(page, '插件', '插件', async (dialog) => {
    await dialog.getByLabel('名称', { exact: true }).fill('Smoke Plugin')
    await dialog.getByRole('checkbox', { name: /Smoke MCP/ }).check()
    await dialog.getByRole('checkbox', { name: /Smoke Skill/ }).check()
  })
  await page.getByRole('navigation').getByRole('button', { name: '我的 Agents' }).click()
  await page.getByRole('button', { name: '创建 Agent', exact: true }).click()
  await page.getByLabel('名称', { exact: true }).fill('Smoke Agent')
  await page.getByLabel('模型 ID', { exact: true }).fill('test-model')
  await page.getByRole('tab', { name: 'System Prompt' }).click()
  await page.getByLabel('系统指令', { exact: true }).fill('You are the smoke test assistant.')
  await page.getByRole('tab', { name: '能力与插件' }).click()
  await page.getByRole('checkbox', { name: /Smoke Plugin/ }).check()
  await page.getByRole('button', { name: '保存 Agent', exact: true }).click()
  await page.getByRole('dialog').waitFor({ state: 'hidden' })
  await page.getByRole('heading', { name: 'Smoke Agent', exact: true }).waitFor()
  let state = await page.evaluate(() => window.agentMatrix.loadWorkspace())
  assert.equal(state.agents.length, 2)
  assert.equal(state.agents[1].systemPrompt, 'You are the smoke test assistant.')
  assert.equal(state.agents[1].pluginIds.length, 1)
  assert.deepEqual(state.mcpServers[0].args, ['--test', 'workspace'])
  const preferences = await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0].webContents.getLastWebPreferences(),
  )
  assert.equal(preferences.contextIsolation, true)
  assert.equal(preferences.nodeIntegration, false)
  assert.equal(preferences.sandbox, true)
  if (process.env.AGENT_MATRIX_SCREENSHOT)
    await page.screenshot({ path: process.env.AGENT_MATRIX_SCREENSHOT, fullPage: true })

  await app.close()
  page = await launch()
  await page.getByRole('heading', { name: 'Smoke Agent', exact: true }).waitFor()
  await page.getByRole('button', { name: '编辑 Smoke Agent' }).click()
  await page.getByLabel('名称', { exact: true }).fill('Updated Agent')
  await page.getByRole('button', { name: '保存 Agent', exact: true }).click()
  await page.getByRole('dialog').waitFor({ state: 'hidden' })
  await page.getByRole('button', { name: '停用 Updated Agent' }).click()
  await page.getByRole('button', { name: '启用 Updated Agent' }).waitFor()
  await page.getByRole('navigation').getByRole('button', { name: 'MCP Servers' }).click()
  page.once('dialog', (dialog) => dialog.accept())
  await page.getByRole('button', { name: '删除 Smoke MCP' }).click()
  await page.getByRole('heading', { name: '添加你的第一个 MCP Server' }).waitFor()
  state = await page.evaluate(() => window.agentMatrix.loadWorkspace())
  assert.deepEqual(state.plugins[0].mcpServerIds, [])
  assert.equal(state.agents[1].enabled, false)
  assert.deepEqual(JSON.parse(await readFile(join(dataDirectory, 'workspace.json'), 'utf8')), state)
  assert.deepEqual(runtimeErrors, [])
  console.log(
    'Desktop smoke passed: create/edit agents, prompts, MCP/Skills/plugins, bindings, reload, disable, deletion cleanup, IPC and sandbox.',
  )
} catch (error) {
  const page = app?.windows()[0]
  if (page) {
    console.error('Desktop state at failure:', await page.locator('body').innerText())
    if (process.env.AGENT_MATRIX_SCREENSHOT) {
      await page.screenshot({ path: process.env.AGENT_MATRIX_SCREENSHOT, fullPage: true })
    }
  }
  console.error('Renderer errors:', runtimeErrors)
  throw error
} finally {
  await app?.close().catch(() => {})
  await rm(dataDirectory, { recursive: true, force: true })
}
