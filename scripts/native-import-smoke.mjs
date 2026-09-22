import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { isAbsolute, join } from 'node:path'
import { _electron as electron } from 'playwright'
import { stringify as yaml } from 'yaml'
import { openCodeWorkspace } from '../tests/helpers/opencode-fixture.ts'
import { chooseOption, languageSelect } from './lib/select.mjs'

const engine = process.env.AGENT_MATRIX_IMPORT_ENGINE ?? 'opencode'
assert.ok(
  ['opencode', 'pi', 'deepseek-harness'].includes(engine),
  'Choose opencode, pi or deepseek-harness',
)
const isPi = engine === 'pi'
const isDsh = engine === 'deepseek-harness'
const isOpenCode = !isPi && !isDsh
const nativeDsh = isDsh && process.env.AGENT_MATRIX_DSH_ROUTE === 'deepseek-native'
const expectedCredentials = nativeDsh ? 1 : 3
const engineLabel = isDsh ? 'DeepSeek Harness' : isPi ? 'Pi' : 'OpenCode'
const version = isDsh ? '0.1.5-rc.2' : isPi ? '0.85.1' : '1.18.16'
const executable =
  process.env[
    isDsh ? 'AGENT_MATRIX_TEST_DSH' : isPi ? 'AGENT_MATRIX_TEST_PI' : 'AGENT_MATRIX_TEST_OPENCODE'
  ]
assert.ok(
  executable && isAbsolute(executable),
  'Set the selected engine test executable to an absolute path',
)
const root = await realpath(await mkdtemp(join(tmpdir(), 'agentmatrix-native-import-desktop-')))
const dataDirectory = join(root, 'data'),
  cwd = join(root, 'project'),
  testHome = join(root, 'home')
for (const directory of [
  dataDirectory,
  join(cwd, '.git'),
  testHome,
  join(root, 'profile'),
  join(root, 'native-home'),
])
  await mkdir(directory, { recursive: true })
const secret = 'synthetic-import-provider-secret',
  headerSecret = 'synthetic-import-header-secret',
  unknownSecret = 'synthetic-unconverted-secret'
let app,
  page,
  passed = false,
  serverError,
  primaryRequests = 0
const errors = []
const server = createServer(async (request, response) => {
  try {
    let body = ''
    for await (const chunk of request) {
      body += String(chunk)
      assert.ok(body.length < 1_048_576)
    }
    const input = JSON.parse(body)
    assert.equal(request.url, '/v1/chat/completions')
    assert.equal(request.headers.authorization, `Bearer ${secret}`)
    if (!nativeDsh) assert.equal(request.headers['x-imported'], headerSecret)
    if (isDsh && !nativeDsh) {
      assert.equal(request.headers['x-literal'], 'dsh-literal-header-secret')
      assert.equal(request.headers['x-environment'], 'must-not-resolve-at-import')
    }
    if (isPi) {
      assert.equal(request.headers['x-escaped'], '!literal$header')
      assert.equal(request.headers['x-environment'], 'must-not-resolve-at-import')
      assert.equal(input.temperature, 0.3)
    }
    assert.equal(input.model, 'imported-model')
    const primary = input.tools?.some((tool) => tool.function?.name === 'read')
    if (primary) {
      assert.ok(
        JSON.stringify(
          input.messages.filter((message) => ['system', 'developer'].includes(message.role)),
        ).includes('IMPORTED_SYSTEM_MARKER'),
      )
      if (isDsh) assert.ok(!JSON.stringify(input.messages).includes('SHADOWED_PROMPT_MARKER'))
      primaryRequests++
      if (isPi || isOpenCode)
        assert.ok(
          JSON.stringify(
            input.messages.filter((message) => ['system', 'developer'].includes(message.role)),
          ).includes('IMPORTED_APPEND_MARKER'),
        )
      if (isOpenCode) {
        const system = JSON.stringify(
          input.messages.filter((message) => ['system', 'developer'].includes(message.role)),
        )
        assert.ok(system.includes('{file:/nested-must-not-read}'))
        assert.ok(system.includes('{env:NESTED_MUST_NOT_RESOLVE}'))
        assert.ok(
          system.indexOf('IMPORTED_SYSTEM_MARKER') < system.indexOf('IMPORTED_APPEND_MARKER'),
        )
      }
    }
    const content = primary ? 'IMPORTED_NATIVE_REPLY' : 'Import check'
    if (!input.stream) {
      response.writeHead(200, { 'Content-Type': 'application/json' })
      response.end(
        JSON.stringify({
          id: 'import-check',
          object: 'chat.completion',
          created: 1,
          model: input.model,
          choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 10, completion_tokens: 3, total_tokens: 13 },
        }),
      )
    } else {
      response.writeHead(200, { 'Content-Type': 'text/event-stream' })
      for (const [delta, finish_reason] of [
        [{ role: 'assistant', content }, null],
        [{}, 'stop'],
      ])
        response.write(
          `data: ${JSON.stringify({ id: 'import-check', object: 'chat.completion.chunk', created: 1, model: input.model, choices: [{ index: 0, delta, finish_reason }] })}\n\n`,
        )
      response.end('data: [DONE]\n\n')
    }
  } catch (error) {
    serverError = error
    response.writeHead(400)
    response.end('Fixture request rejected')
  }
})
await new Promise((resolve, reject) => {
  server.once('error', reject)
  server.listen(0, '127.0.0.1', resolve)
})
const dshPath = (name) => join(root, name.startsWith('cordis') ? 'profile' : 'native-home', name)
const source = isDsh
  ? dshPath('cordis.yml')
  : join(root, isPi ? 'models.json' : 'native-source.jsonc')
const commandMarker = join(root, 'command-must-not-run')
const native = {
  provider: {
    imported: {
      npm: '@ai-sdk/openai-compatible',
      options: {
        baseURL: `http://127.0.0.1:${server.address().port}/v1`,
        apiKey: secret,
        headers: { 'X-Imported': headerSecret },
      },
      models: {
        alias: { id: 'imported-model', name: 'Imported model', future: { token: unknownSecret } },
      },
    },
  },
  model: 'imported/alias',
  agent: {
    imported: { prompt: '{file:./unselected-native-role.md}', permission: 'ask' },
    referenced: { prompt: '{file:/not-read-by-importer}' },
  },
  mcp: {
    disabled: {
      type: 'local',
      command: ['node', '/not-executed-by-importer.js'],
      enabled: false,
      environment: { VALUE: 'synthetic-mcp-secret', ENV_REFERENCE: '{env:IMPORT_ENV_REFERENCE}' },
    },
  },
  plugin: ['/not-executed-plugin.js'],
  instructions: ['./unresolved-glob/*.md'],
  future: { credential: unknownSecret },
}
let sourceBytes = isPi
  ? '\uFEFF' +
    JSON.stringify(
      {
        providers: {
          imported: {
            api: 'openai-completions',
            baseUrl: native.provider.imported.options.baseURL,
            apiKey: 'shadowed-provider-secret',
            headers: {
              'X-Imported': headerSecret,
              'X-Escaped': '$!literal$$header',
              'X-Environment': '$IMPORT_ENV_REFERENCE',
            },
            models: [
              {
                id: 'imported-model',
                name: 'Imported model',
                samplingParams: { temperature: 0.3 },
              },
            ],
          },
          command: {
            api: 'openai-completions',
            baseUrl: native.provider.imported.options.baseURL,
            apiKey: `!touch ${commandMarker}`,
          },
        },
        future: { credential: unknownSecret },
      },
      null,
      2,
    ) +
    '\n'
  : `// Keep this comment and exact source bytes.\n${JSON.stringify(native, null, 2)}\n`
const sources = new Map([[source, sourceBytes]])
const selectedRole = join(root, 'profile', 'selected-role.md')
const selectedAppend = join(root, 'native-home', 'selected-instruction.md')
if (isOpenCode) {
  sources.set(
    selectedRole,
    '\uFEFF  IMPORTED_SYSTEM_MARKER. Follow the user request. Literal {file:/nested-must-not-read} {env:NESTED_MUST_NOT_RESOLVE}\r\n',
  )
  sources.set(selectedAppend, '\uFEFFIMPORTED_APPEND_MARKER. Additional instructions.\r\n')
}
if (isPi) {
  sources.set(
    join(root, 'auth.json'),
    JSON.stringify({
      imported: { type: 'api_key', key: secret },
      unselected: {
        type: 'oauth',
        access: unknownSecret,
        refresh: 'synthetic-refresh-secret',
        expires: 1,
      },
    }),
  )
  sources.set(
    join(root, 'settings.json'),
    JSON.stringify({
      defaultProvider: 'imported',
      defaultModel: 'imported-model',
      defaultThinkingLevel: 'off',
      extensions: ['/not-executed-extension.ts'],
    }),
  )
  sources.set(join(root, 'SYSTEM.md'), 'IMPORTED_SYSTEM_MARKER. Follow the user request.\n')
  sources.set(join(root, 'APPEND_SYSTEM.md'), 'IMPORTED_APPEND_MARKER. Additional instructions.\n')
}
if (isDsh) {
  const provider = nativeDsh ? 'deepseek-official' : 'imported'
  const config = {
    api: 'openai-completions',
    apiKeyEnv: 'IMPORT_DSH_KEY',
    baseURL: 'https://shadowed.example.invalid',
    ...(!nativeDsh
      ? { headers: { 'X-Imported': headerSecret, 'X-Literal': 'dsh-literal-header-secret' } }
      : {}),
    models: [{ id: 'shadowed-model' }],
  }
  if (nativeDsh) delete config.api
  sourceBytes =
    '\uFEFF# Original selected composition\r\n' +
    yaml([
      {
        id: 'llm',
        name: nativeDsh ? '@deepseek-ai/dsh-llm-deepseek' : '@deepseek-ai/dsh-llm-pi-ai',
        config: { replaced: 'retained-only-in-source' },
      },
      {
        id: 'system',
        name: '@deepseek-ai/dsh-system-prompt',
        config: { personaPrefix: 'SHADOWED_PROMPT_MARKER' },
      },
    ])
  sources.clear()
  sources.set(source, sourceBytes)
  let patch = yaml([
    { id: 'llm', config: nativeDsh ? config : { providers: { imported: config } } },
    { id: 'system', config: { personaSuffix: 'IMPORTED_SYSTEM_MARKER. Follow the user request.' } },
  ])
  if (!nativeDsh)
    patch = patch.replace(
      'X-Literal: dsh-literal-header-secret',
      'X-Literal: dsh-literal-header-secret\n          X-Environment: !!js process.env.IMPORT_ENV_REFERENCE',
    )
  patch += `- id: unknown-never-executed\n  config: !!js require('node:fs').writeFileSync(${JSON.stringify(commandMarker)}, 'executed')\n`
  sources.set(dshPath('cordis.patch.yml'), patch)
  const finalProvider = {
    baseURL: native.provider.imported.options.baseURL,
    models: [{ id: 'imported-model' }],
  }
  sources.set(
    dshPath('settings.yaml'),
    yaml({
      [nativeDsh ? 'llm-deepseek' : 'llm-pi-ai']: nativeDsh
        ? finalProvider
        : { providers: { imported: finalProvider } },
      'agent-default-model': { provider, model: 'imported-model', reasoningEffort: 'off' },
      future: { credential: unknownSecret },
    }),
  )
  sources.set(
    dshPath('.credentials.yaml'),
    yaml({
      version: 1,
      refs: { IMPORT_DSH_KEY: secret },
      records: { 'llm-pi-ai/unused': { kind: 'grant', payload: { access: unknownSecret } } },
    }),
  )
}
for (const [path, content] of sources) await writeFile(path, content)
const secretValues = [
  secret,
  headerSecret,
  unknownSecret,
  'synthetic-mcp-secret',
  'must-not-resolve-at-import',
  'shadowed-provider-secret',
  'synthetic-refresh-secret',
  '!literal$header',
  'dsh-literal-header-secret',
  'host-key-not-imported',
]
const diagnosticPath = isDsh
  ? '/settings.yaml/future/credential'
  : isPi
    ? '/models.json/future/credential'
    : '/future/credential'
const profileName = isDsh ? 'Imported DSH profile' : isPi ? 'Imported Pi profile' : 'imported'
const workspace = openCodeWorkspace('/not-executed-during-import', cwd)
workspace.installations[0].kind = engine
workspace.installations[0].name = engineLabel
for (const collection of ['agents', 'models', 'connections', 'prompts', 'skills'])
  workspace[collection] = []
workspace.installations[0].version = null
workspace.installations[0].modes = []
workspace.installations[0].probedAt = null
await writeFile(join(dataDirectory, 'workspace.json'), JSON.stringify(workspace))
const env = {
  ...process.env,
  HOME: testHome,
  XDG_CONFIG_HOME: join(testHome, '.config'),
  AGENT_MATRIX_DATA_DIR: dataDirectory,
  IMPORT_ENV_REFERENCE: 'must-not-resolve-at-import',
  IMPORT_DSH_KEY: 'host-key-not-imported',
}
delete env.ELECTRON_RUN_AS_NODE
async function launch() {
  app = await electron.launch({ args: ['.'], env, timeout: 30_000 })
  page = await app.firstWindow()
  page.setDefaultTimeout(20_000)
  page.on('pageerror', (error) => errors.push(error.message))
  await page.locator('.card-grid').waitFor()
}
async function language(locale) {
  await chooseOption(page, languageSelect(page), locale)
  await page.waitForFunction((value) => document.documentElement.lang === value, locale)
}
async function navigate(name) {
  if (name === 'Settings') {
    await page.getByRole('button', { name, exact: true }).click()
    return
  }
  await page
    .getByRole('navigation')
    .getByRole('button', { name: new RegExp(`^${name}`) })
    .click()
}
async function choose(locale = 'en', cancel = false, adding = false) {
  await app.evaluate(
    ({ dialog }, selection) => {
      const original = dialog.showOpenDialog
      dialog.showOpenDialog = async () => {
        dialog.showOpenDialog = original
        return { canceled: selection.cancel, filePaths: selection.cancel ? [] : selection.paths }
      }
    },
    {
      paths: (isDsh
        ? [...sources.keys()].slice(adding ? 2 : 0, adding ? 4 : 2)
        : isOpenCode
          ? [source]
          : [...sources.keys()]
      ).reverse(),
      cancel,
    },
  )
  await page
    .getByRole('button', {
      name: adding
        ? locale === 'en'
          ? 'Add files to preview'
          : '向预览添加文件'
        : locale === 'en'
          ? 'Choose configuration file'
          : '选择配置文件',
      exact: true,
    })
    .click()
  if (!cancel) await page.locator('.native-import-preview').waitFor()
}
async function choosePrompt(referencePath, selectedPath, locale = 'en', cancel = false) {
  await app.evaluate(
    ({ dialog }, selection) => {
      const original = dialog.showOpenDialog
      dialog.showOpenDialog = async () => {
        dialog.showOpenDialog = original
        return { canceled: selection.cancel, filePaths: selection.cancel ? [] : [selection.path] }
      }
    },
    { path: selectedPath, cancel },
  )
  const row = page.locator(`[data-import-reference="${referencePath}"]`)
  await row
    .getByRole('button', {
      name: locale === 'en' ? 'Select Prompt file' : '选择 Prompt 文件',
      exact: true,
    })
    .click()
  if (!cancel) await row.getByText(selectedPath, { exact: true }).waitFor()
  await poll(() => row.getByRole('button').isEnabled(), 'Prompt file selection finished')
}
async function choosePrompts(locale = 'en') {
  await choosePrompt('/agent/imported/prompt', selectedRole, locale)
  await choosePrompt('/instructions/0', selectedAppend, locale)
  await page
    .locator('[data-import-reference="/agent/referenced/prompt"]')
    .getByRole('button', {
      name: locale === 'en' ? 'Select Prompt file' : '选择 Prompt 文件',
      exact: true,
    })
    .waitFor()
}
async function rejectCredentialCopy(locale) {
  const target = isDsh ? dshPath('settings.yaml') : source
  const original = sources.get(target)
  const changed = isDsh
    ? original + `\n${JSON.stringify(secret)}: copied-credential\n`
    : JSON.stringify({
        ...(isPi ? JSON.parse(original.replace(/^\uFEFF/, '')) : native),
        [secret]: 'copied-credential',
      })
  const before = await state()
  await writeFile(target, changed)
  try {
    await app.evaluate(
      ({ dialog }, paths) => {
        const original = dialog.showOpenDialog
        dialog.showOpenDialog = async () => {
          dialog.showOpenDialog = original
          return { canceled: false, filePaths: paths }
        }
      },
      isOpenCode ? [source] : [...sources.keys()],
    )
    await page
      .getByRole('button', {
        name: locale === 'en' ? 'Choose configuration file' : '选择配置文件',
        exact: true,
      })
      .click()
    const alert = page.getByRole('alert').filter({
      hasText: locale === 'en' ? 'A credential also appears' : '凭据同时出现在',
    })
    await alert.waitFor()
    await alert.scrollIntoViewIfNeeded()
    assert.equal(await page.locator('.native-import-preview').count(), 0)
    assert.ok(!(await page.locator('body').innerText()).includes(secret))
    assert.deepEqual(await state(), before)
    assert.deepEqual(
      (await page.evaluate(() => window.agentMatrix.getCredentialStatus())).credentials,
      [],
    )
    assert.equal((await readdir(dataDirectory)).includes('native-imports'), false)
    assert.equal(primaryRequests, 0)
    if (process.env.AGENT_MATRIX_IMPORT_REJECTION_SCREENSHOT)
      await page.screenshot({
        path: `${process.env.AGENT_MATRIX_IMPORT_REJECTION_SCREENSHOT}.${locale}.png`,
      })
  } finally {
    await writeFile(target, original)
  }
}
const state = () => page.evaluate(() => window.agentMatrix.loadWorkspace())
async function poll(read, label) {
  const end = Date.now() + 90_000
  while (Date.now() < end) {
    if (serverError) throw serverError
    if (await read()) return
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  throw new Error(`Timed out: ${label}`)
}
try {
  await launch()
  await language('en')
  await navigate('Settings')
  await choose('en', true)
  assert.equal(await page.locator('.native-import-preview').count(), 0)
  assert.equal((await state()).nativeImports, undefined)
  assert.equal((await readdir(dataDirectory)).includes('native-imports'), false)
  for (const locale of ['en', 'zh-CN']) {
    await language(locale)
    await rejectCredentialCopy(locale)
  }
  await language('en')
  await choose()
  if (isDsh) {
    await choose('en', true, true)
    assert.equal(await page.locator('.native-import-preview').count(), 1)
    await choose('en', false, true)
  }
  if (isOpenCode) {
    await choosePrompt('/agent/imported/prompt', selectedRole, 'en', true)
    assert.equal(await page.locator('.native-import-preview').count(), 1)
    assert.equal(await page.getByText(selectedRole, { exact: true }).count(), 0)
    await choosePrompts()
    await page.locator('.native-import-references').scrollIntoViewIfNeeded()
  }
  await page
    .getByText(`${expectedCredentials} literal secrets will be stored as encrypted credentials.`, {
      exact: false,
    })
    .waitFor()
  if (process.env.AGENT_MATRIX_SMOKE_SCREENSHOT)
    await page.screenshot({ path: process.env.AGENT_MATRIX_SMOKE_SCREENSHOT, fullPage: true })
  assert.equal((await state()).nativeImports, undefined)
  for (const value of secretValues)
    assert.ok(!(await page.locator('body').innerText()).includes(value), 'Preview exposed a secret')
  const changedSource = isDsh
    ? dshPath('.credentials.yaml')
    : isPi
      ? join(root, 'auth.json')
      : selectedRole
  await writeFile(changedSource, sources.get(changedSource) + '\n')
  await page.getByRole('button', { name: 'Import configuration', exact: true }).click()
  await page.getByRole('alert').filter({ hasText: 'source file or installation changed' }).waitFor()
  assert.equal((await state()).nativeImports, undefined)
  await writeFile(changedSource, sources.get(changedSource))
  await language('zh-CN')
  await choose('zh-CN')
  if (isDsh) {
    await page.getByRole('button', { name: '向预览添加文件', exact: true }).waitFor()
    await choose('zh-CN', false, true)
    await page.getByText('原生启动环境', { exact: false }).last().waitFor()
  }
  if (isOpenCode) {
    await choosePrompts('zh-CN')
    await page.locator('.native-import-references').scrollIntoViewIfNeeded()
  }
  if (process.env.AGENT_MATRIX_SMOKE_SCREENSHOT_ZH)
    await page.screenshot({ path: process.env.AGENT_MATRIX_SMOKE_SCREENSHOT_ZH, fullPage: true })
  await page.getByRole('heading', { name: '导入预览', exact: true }).waitFor()
  await page.getByRole('button', { name: '导入配置', exact: true }).click()
  await page.getByRole('status').filter({ hasText: '配置已导入' }).waitFor()
  const imported = await state()
  const record = imported.nativeImports[0]
  assert.equal(imported.nativeImports.length, 1)
  assert.equal(imported.agents.length, isPi || isDsh ? 1 : 2)
  assert.ok(imported.agents.every((entry) => !entry.enabled && entry.execution.cwd === ''))
  if (isPi) {
    assert.equal(record.additionalSources.length, 4)
    assert.equal(imported.mcpServers.length, 0)
    assert.equal(
      imported.connections.find((entry) => entry.name === 'imported').secretHeaders['X-Environment']
        .name,
      'IMPORT_ENV_REFERENCE',
    )
    assert.equal(
      imported.connections.find((entry) => entry.name === 'command').auth.kind,
      'unconfigured',
    )
  } else if (isDsh) {
    assert.equal(record.additionalSources.length, 3)
    assert.ok(record.diagnostics.some((entry) => entry.code === 'review-precedence'))
    assert.equal(
      imported.prompts[0].versions[0].content,
      'IMPORTED_SYSTEM_MARKER. Follow the user request.',
    )
    assert.equal(imported.agents[0].engineOptions.appendPosition, 'suffix')
    assert.equal(imported.models[0].parameters.reasoning, 'off')
  } else {
    assert.equal(imported.mcpServers[0].envRefs.ENV_REFERENCE.name, 'IMPORT_ENV_REFERENCE')
    assert.deepEqual(
      record.additionalSources.map((entry) => entry.referencePath),
      ['/agent/imported/prompt', '/instructions/0'],
    )
    assert.equal(
      record.diagnostics.filter((entry) => entry.code === 'review-prompt-selection').length,
      2,
    )
    assert.deepEqual(
      imported.prompts.map((entry) => entry.versions[0].content),
      [sources.get(selectedAppend), sources.get(selectedRole).trim()],
    )
    assert.deepEqual(
      imported.agents
        .find((entry) => entry.name === 'imported')
        .promptBindings.map((entry) => entry.mode),
      ['replace', 'append'],
    )
  }
  assert.equal(
    (await page.evaluate(() => window.agentMatrix.getCredentialStatus())).credentials.length,
    expectedCredentials,
  )
  await page.locator('.native-import-history summary').first().click()
  await page.getByText(diagnosticPath, { exact: true }).waitFor()
  const archivePath = join(dataDirectory, 'native-imports', `${record.id}.json`)
  const encrypted = JSON.parse(await readFile(archivePath, 'utf8'))
  assert.equal(
    await app.evaluate(
      async ({ safeStorage }, { ciphertext, expected }) => {
        const decrypted = await safeStorage.decryptStringAsync(Buffer.from(ciphertext, 'base64'))
        const payload = Buffer.from(decrypted.result, 'base64').toString('utf8')
        return (
          JSON.stringify(
            JSON.parse(payload).map((file) => Buffer.from(file.bytes, 'base64').toString('utf8')),
          ) === JSON.stringify(expected)
        )
      },
      { ciphertext: encrypted.ciphertext, expected: [...sources.values()] },
    ),
    true,
  )
  for (const path of [
    archivePath,
    join(dataDirectory, 'workspace.json'),
    join(dataDirectory, 'credentials/vault.json'),
  ]) {
    const stored = await readFile(path, 'utf8')
    for (const value of secretValues)
      assert.ok(!stored.includes(value), 'Plaintext secret persisted')
  }
  assert.equal(await readFile(source, 'utf8'), sourceBytes)
  assert.deepEqual(
    await page.evaluate((input) => window.agentMatrix.applyNativeImport(input), {
      id: record.id,
      workspaceRevision: workspace.revision,
    }),
    imported,
  )
  await app.close()
  await launch()
  await language('en')
  await navigate('Settings')
  await page.locator('.native-import-history summary').first().click()
  await page.getByText(diagnosticPath, { exact: true }).waitFor()
  assert.deepEqual((await state()).nativeImports, imported.nativeImports)
  // Only after import acceptance, select a real executable and explicitly probe it.
  await page.evaluate(async (path) => {
    const next = await window.agentMatrix.loadWorkspace()
    next.installations[0].executable = path
    await window.agentMatrix.saveWorkspace(next)
  }, executable)
  await page.reload()
  await page.locator('.card-grid').waitFor()
  await navigate('Engines')
  await page.getByRole('button', { name: 'Check installation', exact: true }).click()
  await poll(
    async () => (await state()).installations[0].version === version,
    'Selected installation probe',
  )
  await navigate('My Agents')
  await page.getByRole('button', { name: `Edit ${profileName}`, exact: true }).click()
  const editor = page.getByRole('dialog')
  await editor.getByLabel('Working directory', { exact: true }).fill(cwd)
  if (isPi)
    await chooseOption(
      page,
      editor.getByLabel('Requested execution policy', { exact: true }),
      'unrestricted',
    )
  await editor.locator('input[type="checkbox"]').first().check()
  await editor.getByRole('button', { name: 'Save Agent', exact: true }).click()
  await editor.waitFor({ state: 'hidden' })
  const agent = (await state()).agents.find((entry) => entry.name === profileName)
  await navigate('Sessions')
  await chooseOption(page, page.getByLabel('Agent configuration', { exact: true }), agent.id)
  await page.getByRole('button', { name: 'Start new session', exact: true }).click()
  let sessionId
  await poll(async () => {
    const sessions = await page.evaluate(() => window.agentMatrix.sessions.list())
    const value = sessions[0]
    assert.ok(!value?.failure, 'Imported profile failed to start')
    if (value?.status === 'ready') {
      sessionId = value.id
      return true
    }
    return false
  }, 'Imported native session Ready')
  await page
    .getByRole('textbox', { name: 'Message', exact: true })
    .fill('Check the imported configuration.')
  await page.getByRole('button', { name: 'Send message', exact: true }).click()
  await poll(async () => {
    const value = await page.evaluate(
      (id) => window.agentMatrix.sessions.get({ sessionId: id }),
      sessionId,
    )
    assert.ok(!value.failure, 'Imported native turn failed')
    return value.status === 'ready' && value.lastTurn?.outcome === 'completed'
  }, 'Imported native turn completed')
  await page
    .locator('.message.assistant pre')
    .filter({ hasText: 'IMPORTED_NATIVE_REPLY' })
    .waitFor()
  assert.ok(primaryRequests > 0)
  for (const [path, content] of sources) assert.equal(await readFile(path, 'utf8'), content)
  await assert.rejects(readFile(commandMarker), { code: 'ENOENT' })
  assert.deepEqual((await state()).nativeImports, imported.nativeImports)
  assert.deepEqual(errors, [])
  passed = true
  console.log(
    JSON.stringify(
      {
        checkedAt: new Date().toISOString(),
        platform: process.platform,
        architecture: process.arch,
        passed: true,
        engine: `${engineLabel} ${version}`,
        locales: ['en', 'zh-CN'],
        readOnlyPreview: true,
        copiedCredentialPreviewRejected: true,
        rejectionLeavesWorkspaceAndVaultUnchanged: true,
        correctedImportSucceeds: true,
        staleSourceRejected: true,
        exactEncryptedArchive: true,
        importedCredentials: expectedCredentials,
        sourceFiles: sources.size,
        ...(isOpenCode
          ? {
              explicitPromptSelections: true,
              replacementAndAppend: true,
              nestedMacrosRemainLiteral: true,
              crossFolderSelection: true,
              selectionProvenance: true,
              selectionCancelPreservesPreview: true,
              secondarySourceChangeRejected: true,
            }
          : {}),
        ...(isPi
          ? {
              storedAuthPrecedence: true,
              replacementAndAppend: true,
              escapedAndEnvironmentHeaders: true,
              commandsNotExecuted: true,
            }
          : {}),
        ...(isDsh
          ? {
              route: nativeDsh ? 'deepseek-native' : 'pi-ai',
              patchAndSettingsPrecedence: true,
              storedCredentialCopy: true,
              precedenceDiagnostic: true,
              crossFolderSelection: true,
              expressionsNotExecuted: true,
            }
          : {}),
        restartAndIdempotentRetry: true,
        importedNativeTurn: true,
        primaryRequests,
        externalProvider: false,
      },
      null,
      2,
    ),
  )
} catch (error) {
  if (page && !page.isClosed())
    await page
      .screenshot({ path: join(root, 'failure.png'), fullPage: true })
      .catch(() => undefined)
  throw error
} finally {
  if (app) await app.close().catch(() => undefined)
  await new Promise((resolve) => server.close(resolve))
  if (passed) await rm(root, { recursive: true, force: true })
  else console.error(`Native import fixture retained: ${root}`)
}
