import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { _electron as electron } from 'playwright'

const dataDirectory = await mkdtemp(join(tmpdir(), 'agent-matrix-smoke-'))
const skillSource = await mkdtemp(join(tmpdir(), 'agent-matrix-smoke-skill-'))
const pluginSource = await mkdtemp(join(tmpdir(), 'agent-matrix-smoke-plugin-'))
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

// Substitute only the native OS chooser; the real IPC, capture service, store, and UI still run.
async function chooseSkillDirectory(path) {
  await app.evaluate(({ dialog }, selected) => {
    const original = dialog.showOpenDialog
    dialog.showOpenDialog = async () => {
      dialog.showOpenDialog = original
      return { canceled: selected === null, filePaths: selected === null ? [] : [selected] }
    }
  }, path)
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
  await mkdir(join(pluginSource, 'dist'))
  await writeFile(
    join(pluginSource, 'package.json'),
    JSON.stringify({
      name: '@agentmatrix/smoke-plugin',
      version: '1.2.3',
      exports: { './server': { import: './dist/server.mjs' } },
      main: './missing-main.js',
      engines: { opencode: '^1.18.0' },
      privateCredential: syntheticSecret,
    }),
  )
  await writeFile(
    join(pluginSource, 'dist', 'server.mjs'),
    `import { writeFileSync } from 'node:fs';\nwriteFileSync(${JSON.stringify(join(pluginSource, 'executed'))}, 'unexpected');\nthrow new Error('Do not execute while inspecting');\n`,
  )
  // Seed saved probe metadata only; no real CLI compatibility is claimed by file inspection.
  await page.evaluate(async () => {
    const workspace = await window.agentMatrix.loadWorkspace()
    const original = workspace.installations.find((item) => item.name === 'Smoke OpenCode')
    for (const [id, name, version] of [
      ['range-match', 'Matching range fixture', '1.18.16'],
      ['range-mismatch', 'Mismatching range fixture', '2.0.0'],
    ])
      workspace.installations.push({
        ...original,
        id,
        name,
        version,
        modes: ['acp'],
        probedAt: '2026-09-18T00:00:00Z',
      })
    await window.agentMatrix.saveWorkspace(workspace)
  })
  await page.reload()
  await addResource('Native plugins', 'Smoke Plugin', async (dialog) => {
    await dialog
      .getByLabel('Engine installation', { exact: true })
      .selectOption({ label: 'Smoke OpenCode' })
    await dialog.getByLabel('Native plugin ID', { exact: true }).fill('smoke-native-id')
    await dialog.getByLabel('Version', { exact: true }).fill('0.9.0')
    await dialog.getByLabel('Source', { exact: true }).fill('User-supplied origin')
    await dialog.getByLabel('Installed path', { exact: true }).fill(pluginSource)
    await dialog.getByRole('button', { name: 'Inspect installed files', exact: true }).click()
    await dialog
      .getByRole('status')
      .filter({ hasText: 'Files checked · Activation unverified' })
      .waitFor()
    await dialog.getByText('@agentmatrix/smoke-plugin', { exact: true }).waitFor()
    await dialog
      .getByText('Check the engine installation before comparing its version.', { exact: true })
      .waitFor()
    assert.equal(
      await dialog.getByTestId('plugin-engine-range').getAttribute('data-range-status'),
      'engine-unverified',
    )
    for (const [name, status, message] of [
      [
        'Matching range fixture',
        'matched',
        'The declared range includes saved OpenCode version 1.18.16.',
      ],
      [
        'Mismatching range fixture',
        'mismatched',
        'The declared range excludes saved OpenCode version 2.0.0.',
      ],
    ]) {
      await dialog.getByLabel('Engine installation', { exact: true }).selectOption({ label: name })
      assert.equal(await dialog.getByTestId('plugin-engine-range').count(), 0)
      await dialog.getByRole('button', { name: 'Inspect installed files', exact: true }).click()
      await dialog.getByText(message, { exact: true }).waitFor()
      assert.equal(
        await dialog.getByTestId('plugin-engine-range').getAttribute('data-range-status'),
        status,
      )
    }
    await dialog
      .getByLabel('Engine installation', { exact: true })
      .selectOption({ label: 'Smoke OpenCode' })
    await dialog.getByRole('button', { name: 'Inspect installed files', exact: true }).click()
    await dialog
      .getByText('Check the engine installation before comparing its version.', { exact: true })
      .waitFor()
    await dialog
      .getByText(
        'The configured version differs from the installed package version. Review it before saving.',
        { exact: true },
      )
      .waitFor()
    assert.equal(await dialog.getByLabel('Version', { exact: true }).inputValue(), '0.9.0')
    await dialog.getByRole('button', { name: 'Use package version', exact: true }).click()
    assert.equal(await dialog.getByLabel('Version', { exact: true }).inputValue(), '1.2.3')
    assert.equal(
      await dialog.getByLabel('Native plugin ID', { exact: true }).inputValue(),
      'smoke-native-id',
    )
    assert.equal(
      await dialog.getByLabel('Source', { exact: true }).inputValue(),
      'User-supplied origin',
    )
    assert.ok(!(await dialog.innerText()).includes(syntheticSecret))
    if (process.env.AGENT_MATRIX_PLUGIN_SCREENSHOT)
      await dialog.screenshot({ path: process.env.AGENT_MATRIX_PLUGIN_SCREENSHOT })
  })
  const savedPlugin = (await state()).nativePlugins.find((item) => item.name === 'Smoke Plugin')
  const workspaceBeforeInspection = await state()
  const result = await page.evaluate((query) => window.agentMatrix.inspectNativePlugin(query), {
    installationId: savedPlugin.engineInstallationId,
    path: pluginSource,
  })
  assert.equal(result.verification, 'files-only')
  assert.equal(result.rangeStatus, 'engine-unverified')
  assert.ok(!JSON.stringify(result).includes(syntheticSecret))
  assert.deepEqual(await state(), workspaceBeforeInspection)
  assert.ok(!(await readdir(pluginSource)).includes('executed'))
  await language('zh-CN')
  await navigate('原生插件')
  await page.getByRole('button', { name: '编辑 Smoke Plugin', exact: true }).click()
  const pluginDialog = page.getByRole('dialog')
  assert.equal(await pluginDialog.locator('.plugin-inspection').getByRole('status').count(), 0)
  await pluginDialog.getByRole('button', { name: '检查已安装文件', exact: true }).click()
  await pluginDialog.getByRole('status').filter({ hasText: '文件已检查 · 激活尚未验证' }).waitFor()
  await pluginDialog.getByText('请先检查引擎安装，再比较版本。', { exact: true }).waitFor()
  await pluginDialog
    .getByLabel('引擎安装', { exact: true })
    .selectOption({ label: 'Mismatching range fixture' })
  await pluginDialog.getByRole('button', { name: '检查已安装文件', exact: true }).click()
  await pluginDialog
    .getByText('声明的范围不包含已保存的 OpenCode 版本 2.0.0。', { exact: true })
    .waitFor()
  if (process.env.AGENT_MATRIX_PLUGIN_SCREENSHOT)
    await pluginDialog.screenshot({ path: `${process.env.AGENT_MATRIX_PLUGIN_SCREENSHOT}.zh.png` })
  await pluginDialog.getByLabel('安装路径', { exact: true }).fill(join(pluginSource, 'missing'))
  assert.equal(
    await pluginDialog.getByText('文件已检查 · 激活尚未验证', { exact: true }).count(),
    0,
  )
  await pluginDialog.getByRole('button', { name: '检查已安装文件', exact: true }).click()
  await pluginDialog
    .getByRole('alert')
    .filter({ hasText: '所选插件或其声明的入口不存在。' })
    .waitFor()
  await pluginDialog.getByLabel('引擎安装', { exact: true }).selectOption({ label: 'Smoke Pi' })
  assert.equal(
    await pluginDialog.getByRole('button', { name: '检查已安装文件', exact: true }).isDisabled(),
    false,
  )
  page.once('dialog', (dialog) => dialog.accept())
  await pluginDialog.getByRole('button', { name: '取消', exact: true }).click()
  assert.deepEqual(await state(), workspaceBeforeInspection)
  await language('en')
  await page.evaluate(async () => {
    const workspace = await window.agentMatrix.loadWorkspace()
    workspace.installations = workspace.installations.filter(
      (item) => !['range-match', 'range-mismatch'].includes(item.id),
    )
    await window.agentMatrix.saveWorkspace(workspace)
  })
  await page.reload()
  const additionalPlugins = []
  const unprobedInstallations = (await state()).installations
  // These saved versions are fixture metadata. Inspection must work without executing a CLI.
  await page.evaluate(async () => {
    const workspace = await window.agentMatrix.loadWorkspace()
    for (const installation of workspace.installations) {
      if (!['pi', 'deepseek-harness'].includes(installation.kind)) continue
      installation.version = installation.kind === 'pi' ? '0.85.1' : '0.1.5-rc.2'
      installation.probedAt = '2026-09-19T00:00:00Z'
    }
    await window.agentMatrix.saveWorkspace(workspace)
  })
  await page.reload()
  for (const kind of ['pi', 'dsh']) {
    const selected = join(pluginSource, kind)
    await mkdir(selected)
    const packageData = {
      name: `@agentmatrix/${kind}-inspection`,
      version: '2.3.4',
      main: './first.mjs',
      ...(kind === 'pi' ? { pi: { extensions: ['./first.mjs', './second.ts'] } } : {}),
      peerDependencies:
        kind === 'pi'
          ? {
              '@earendil-works/pi-coding-agent': '^0.85.0',
              '@mariozechner/pi-coding-agent': '>=1.0.0',
            }
          : { '@deepseek-ai/dsh': '0.1.5-rc.2', '@deepseek-ai/cordis': '^4.0.0' },
      scripts: { install: 'must not execute' },
      privateCredential: syntheticSecret,
    }
    await writeFile(join(selected, 'package.json'), JSON.stringify(packageData))
    const entryCode = `import { writeFileSync } from 'node:fs';\nwriteFileSync(${JSON.stringify(join(selected, 'executed'))}, 'unexpected');\nthrow new Error('Do not execute while inspecting');\n`
    await writeFile(join(selected, 'first.mjs'), entryCode)
    await writeFile(join(selected, 'second.ts'), entryCode)
    const label = kind === 'pi' ? 'Smoke Pi' : 'Smoke DSH'
    const name = `${label} Plugin`
    await addResource('Native plugins', name, async (dialog) => {
      await dialog.getByLabel('Engine installation', { exact: true }).selectOption({ label })
      await dialog.getByLabel('Native plugin ID', { exact: true }).fill(`${kind}-native-id`)
      await dialog.getByLabel('Version', { exact: true }).fill('0.9.0')
      await dialog.getByLabel('Source', { exact: true }).fill('User-supplied origin')
      await dialog.getByLabel('Installed path', { exact: true }).fill(selected)
      const before = await state()
      await dialog.getByRole('button', { name: 'Inspect installed files', exact: true }).click()
      await dialog
        .getByRole('status')
        .filter({ hasText: 'Files checked · Activation unverified' })
        .waitFor()
      await dialog.getByText(packageData.name, { exact: true }).waitFor()
      assert.equal(await dialog.getByTestId('plugin-entry').count(), kind === 'pi' ? 2 : 1)
      const rows = dialog.getByTestId('plugin-engine-range')
      assert.deepEqual(
        await rows.evaluateAll((items) =>
          items.map((item) => item.getAttribute('data-range-status')),
        ),
        kind === 'pi' ? ['matched', 'mismatched'] : ['matched', 'engine-unverified'],
      )
      if (kind === 'dsh')
        await dialog
          .getByText(
            'This dependency version has not been inspected. The saved CLI version does not establish its compatibility.',
            { exact: true },
          )
          .waitFor()
      await dialog.getByRole('button', { name: 'Use package version', exact: true }).click()
      assert.equal(await dialog.getByLabel('Version', { exact: true }).inputValue(), '2.3.4')
      assert.equal(
        await dialog.getByLabel('Native plugin ID', { exact: true }).inputValue(),
        `${kind}-native-id`,
      )
      assert.equal(
        await dialog.getByLabel('Source', { exact: true }).inputValue(),
        'User-supplied origin',
      )
      await dialog.getByText('SHA-256', { exact: true }).click()
      assert.equal(
        await dialog.locator('.plugin-inspection code').count(),
        (kind === 'pi' ? 2 : 1) + 1,
      )
      assert.ok(!(await dialog.innerText()).includes(syntheticSecret))
      assert.deepEqual(await state(), before)
      if (process.env.AGENT_MATRIX_PLUGIN_SCREENSHOT) {
        await dialog.locator('.plugin-inspection').scrollIntoViewIfNeeded()
        await dialog.screenshot({
          path: `${process.env.AGENT_MATRIX_PLUGIN_SCREENSHOT}.${kind}.en.png`,
        })
      }
    })
    additionalPlugins.push((await state()).nativePlugins.find((item) => item.name === name))
    const saved = await state()
    const result = await page.evaluate((query) => window.agentMatrix.inspectNativePlugin(query), {
      installationId: additionalPlugins.at(-1).engineInstallationId,
      path: selected,
    })
    assert.ok(!JSON.stringify(result).includes(syntheticSecret))
    assert.equal(result.engine, kind === 'pi' ? 'pi' : 'deepseek-harness')
    await language('zh-CN')
    await navigate('原生插件')
    await page.getByRole('button', { name: `编辑 ${name}`, exact: true }).click()
    const dialog = page.getByRole('dialog')
    assert.equal(await dialog.locator('.plugin-inspection').getByRole('status').count(), 0)
    await dialog.getByRole('button', { name: '检查已安装文件', exact: true }).click()
    await dialog.getByRole('status').filter({ hasText: '文件已检查 · 激活尚未验证' }).waitFor()
    await dialog.getByText(packageData.name, { exact: true }).waitFor()
    if (kind === 'dsh')
      await dialog
        .getByText('尚未检查此依赖的安装版本。已保存的 CLI 版本不能证明其兼容性。', { exact: true })
        .waitFor()
    else
      await dialog
        .getByText('声明的范围不包含已保存的 @mariozechner/pi-coding-agent 版本 0.85.1。', {
          exact: true,
        })
        .waitFor()
    if (process.env.AGENT_MATRIX_PLUGIN_SCREENSHOT) {
      await dialog.locator('.plugin-inspection').scrollIntoViewIfNeeded()
      await dialog.screenshot({
        path: `${process.env.AGENT_MATRIX_PLUGIN_SCREENSHOT}.${kind}.zh.png`,
      })
    }
    if (kind === 'pi')
      await writeFile(
        join(selected, 'package.json'),
        JSON.stringify({ ...packageData, pi: { ...packageData.pi, skills: ['skills'] } }),
      )
    else await writeFile(join(selected, 'cordis.patch.yml'), '[]')
    await dialog.getByRole('button', { name: '检查已安装文件', exact: true }).click()
    await dialog
      .getByRole('alert')
      .filter({ hasText: kind === 'pi' ? '此 Pi 包还声明了 Skills' : '此目录是 DSH 补丁包' })
      .waitFor()
    assert.equal(await dialog.getByTestId('plugin-entry').count(), 0)
    await writeFile(join(selected, 'package.json'), JSON.stringify(packageData))
    if (kind === 'dsh') await rm(join(selected, 'cordis.patch.yml'))
    await dialog.getByRole('button', { name: '取消', exact: true }).click()
    assert.deepEqual(await state(), saved)
    assert.ok(!(await readdir(selected)).includes('executed'))
    await language('en')
  }
  await page.evaluate(async (installations) => {
    const workspace = await window.agentMatrix.loadWorkspace()
    await window.agentMatrix.saveWorkspace({ ...workspace, installations })
  }, unprobedInstallations)
  await page.reload()
  await addResource('Connections', 'Smoke Connection', async (dialog) => {
    await dialog.getByLabel('API protocol', { exact: true }).selectOption('anthropic-messages')
    await dialog
      .getByLabel('API Base URL', { exact: true })
      .fill('https://gateway.example/proxy/v1')
    for (const locale of ['en', 'zh-CN']) {
      await language(locale)
      await dialog
        .getByText(
          locale === 'en' ? /^Anthropic: use the provider root/ : /^Anthropic：填写服务根地址/,
        )
        .waitFor()
      if (process.env.AGENT_MATRIX_PROVIDER_SCREENSHOT)
        await page.screenshot({
          path: `${process.env.AGENT_MATRIX_PROVIDER_SCREENSHOT}.${locale}.png`,
        })
    }
    await language('en')
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
    if (agentName === 'Pi Agent') {
      await dialog.getByRole('tab', { name: 'Engine settings', exact: true }).click()
      await dialog.getByLabel('Pi project files', { exact: true }).selectOption('trust-once')
      await dialog.getByLabel('Pi context files', { exact: true }).selectOption('ignore')
      await dialog.getByLabel('Pi thinking level', { exact: true }).fill('high')
    }
    if (agentName === 'DSH Agent') {
      await dialog.getByRole('tab', { name: 'Engine settings', exact: true }).click()
      await dialog.getByLabel('DSH instruction placement', { exact: true }).selectOption('prefix')
    }
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
  assert.deepEqual(current.agents.find((item) => item.name === 'Pi Agent').engineOptions, {
    kind: 'pi',
    projectTrust: 'trust-once',
    contextFiles: 'ignore',
    thinkingLevel: 'high',
  })
  assert.equal(
    current.agents.find((item) => item.name === 'DSH Agent').engineOptions.profileTemplate,
    'acp',
  )
  assert.equal(
    current.agents.find((item) => item.name === 'DSH Agent').engineOptions.appendPosition,
    'prefix',
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

  const skillEntry =
    '---\nname: smoke-directory\ndescription: Retain frontmatter\n---\n\n# Imported workflow 中文\n'
  await mkdir(join(skillSource, 'scripts'))
  await writeFile(join(skillSource, 'SKILL.md'), skillEntry)
  await writeFile(join(skillSource, 'scripts/check.sh'), '#!/bin/sh\nexit 37\n', { mode: 0o700 })
  await writeFile(join(skillSource, 'reference.bin'), Buffer.from([0, 255, 1]))
  await addResource('Skills', 'Directory Skill', async (dialog) => {
    await chooseSkillDirectory(null)
    await dialog.getByRole('button', { name: 'Import Skill directory', exact: true }).click()
    await dialog.getByRole('button', { name: 'Import Skill directory', exact: true }).waitFor()
    assert.equal(await dialog.getByLabel('Skill instructions', { exact: true }).inputValue(), '')
    await chooseSkillDirectory(skillSource)
    await dialog.getByRole('button', { name: 'Import Skill directory', exact: true }).click()
    await dialog.getByText(/3 captured files/).waitFor()
    await dialog.locator('summary').filter({ hasText: 'Captured files' }).click()
    await dialog.getByText('scripts/check.sh', { exact: true }).waitFor()
    if (process.env.AGENT_MATRIX_SCREENSHOT)
      await page.screenshot({
        path: `${process.env.AGENT_MATRIX_SCREENSHOT}.skill.png`,
        fullPage: true,
      })
  })
  const imported = (await state()).skills.find((item) => item.name === 'Directory Skill')
  assert.equal(imported.currentVersion, 1)
  assert.equal(imported.versions[0].kind, 'directory')
  const firstDirectory = join(dataDirectory, 'assets/skills', imported.versions[0].digest, 'files')
  assert.equal(await readFile(join(firstDirectory, 'SKILL.md'), 'utf8'), skillEntry)
  assert.deepEqual(
    (await state()).nativePlugins.find((item) => item.name === 'Smoke Plugin'),
    savedPlugin,
  )
  await writeFile(join(skillSource, 'SKILL.md'), '# New directory revision\n')
  dialog = await editResource('Skills', 'Directory Skill')
  await chooseSkillDirectory(skillSource)
  await dialog.getByRole('button', { name: 'Import Skill directory', exact: true }).click()
  await page.waitForFunction(() => document.querySelector('[aria-label="Version"]').value === '2')
  await saveResource()
  const updatedDirectory = (await state()).skills.find((item) => item.name === 'Directory Skill')
  assert.equal(updatedDirectory.versions.length, 2)
  assert.deepEqual(updatedDirectory.versions[0], imported.versions[0])
  assert.equal(await readFile(join(firstDirectory, 'SKILL.md'), 'utf8'), skillEntry)
  await rm(skillSource, { recursive: true })

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
  assert.deepEqual(
    (await state()).skills.find((item) => item.name === 'Directory Skill'),
    updatedDirectory,
  )
  assert.equal(await readFile(join(firstDirectory, 'SKILL.md'), 'utf8'), skillEntry)
  await page.getByRole('button', { name: '编辑 Pi Agent', exact: true }).click()
  await page.getByRole('tab', { name: '引擎专属配置', exact: true }).click()
  assert.equal(await page.getByLabel('Pi 项目文件', { exact: true }).inputValue(), 'trust-once')
  assert.equal(await page.getByLabel('Pi 上下文文件', { exact: true }).inputValue(), 'ignore')
  assert.equal(await page.getByLabel('Pi 思考等级', { exact: true }).inputValue(), 'high')
  if (process.env.AGENT_MATRIX_PI_SCREENSHOT)
    await page.screenshot({ path: process.env.AGENT_MATRIX_PI_SCREENSHOT, fullPage: true })
  await page.getByRole('button', { name: '取消', exact: true }).click()
  await page.getByRole('dialog').waitFor({ state: 'hidden' })
  await page.getByRole('button', { name: '编辑 DSH Agent', exact: true }).click()
  await page.getByRole('tab', { name: '引擎专属配置', exact: true }).click()
  assert.equal(await page.getByLabel('DSH 指令位置', { exact: true }).inputValue(), 'prefix')
  await page.getByRole('button', { name: '取消', exact: true }).click()
  await page.getByRole('dialog').waitFor({ state: 'hidden' })
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
  for (const plugin of additionalPlugins)
    assert.deepEqual(
      (await state()).nativePlugins.find((item) => item.id === plugin.id),
      plugin,
    )
  if (process.env.AGENT_MATRIX_PLUGIN_REPORT)
    await writeFile(
      process.env.AGENT_MATRIX_PLUGIN_REPORT,
      JSON.stringify(
        {
          checkedAt: new Date().toISOString(),
          platform: process.platform,
          architecture: process.arch,
          engines: ['opencode', 'pi', 'deepseek-harness'],
          verification: 'files-only',
          nativeCliExecuted: false,
          moduleCodeExecuted: false,
          externalRequests: false,
          englishAndChinese: true,
          allPiEntriesAndDigests: true,
          separatePiPeerRanges: true,
          dshFrameworkVersionUnknown: true,
          engineSpecificPackageRestrictions: true,
          packageVersionAdoption: true,
          nativeIdAndSourceUnchanged: true,
          inspectionDoesNotSave: true,
          savedReferencesSurviveRestart: true,
          secretMetadataOmitted: true,
          staleResultsCleared: true,
        },
        null,
        2,
      ) + '\n',
    )
  console.log(
    'Desktop smoke passed: exact-byte v1 backup/migration, shared connections/models/credentials, all three engine drafts, read-only OpenCode/Pi/DSH plugin inspection, Pi trust/context settings, DSH instruction placement, prompt and Skill revisions, directory capture/reimport, pinned/latest bindings, bundles, diagnostics, reference cleanup, bilingual UI/restart, and OS credential encryption/replacement/deletion.',
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
  await rm(skillSource, { recursive: true, force: true })
  await rm(pluginSource, { recursive: true, force: true })
}
