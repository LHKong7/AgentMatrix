import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { isAbsolute, join } from 'node:path'
import { _electron as electron } from 'playwright'
import { openCodeWorkspace } from '../tests/helpers/opencode-fixture.ts'

const engine = process.env.AGENT_MATRIX_IMPORT_ENGINE ?? 'opencode'
assert.ok(['opencode', 'pi'].includes(engine), 'Choose opencode or pi')
const isPi = engine === 'pi'
const version = isPi ? '0.85.1' : '1.18.16'
const executable = process.env[isPi ? 'AGENT_MATRIX_TEST_PI' : 'AGENT_MATRIX_TEST_OPENCODE']
assert.ok(
  executable && isAbsolute(executable),
  'Set the selected engine test executable to an absolute path',
)
const root = await realpath(await mkdtemp(join(tmpdir(), 'agentmatrix-native-import-desktop-')))
const dataDirectory = join(root, 'data'),
  cwd = join(root, 'project'),
  testHome = join(root, 'home')
for (const directory of [dataDirectory, join(cwd, '.git'), testHome])
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
    assert.equal(request.headers['x-imported'], headerSecret)
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
      primaryRequests++
      if (isPi)
        assert.ok(
          JSON.stringify(
            input.messages.filter((message) => ['system', 'developer'].includes(message.role)),
          ).includes('IMPORTED_APPEND_MARKER'),
        )
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
const source = join(root, isPi ? 'models.json' : 'native-source.jsonc')
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
    imported: { prompt: 'IMPORTED_SYSTEM_MARKER. Follow the user request.', permission: 'ask' },
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
  future: { credential: unknownSecret },
}
const sourceBytes = isPi
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
]
const diagnosticPath = isPi ? '/models.json/future/credential' : '/future/credential'
const profileName = isPi ? 'Imported Pi profile' : 'imported'
const workspace = openCodeWorkspace('/not-executed-during-import', cwd)
workspace.installations[0].kind = engine
workspace.installations[0].name = isPi ? 'Pi' : 'OpenCode'
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
  await page.locator('.language-select select').first().selectOption(locale)
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
async function choose(locale = 'en', cancel = false) {
  await app.evaluate(
    ({ dialog }, selection) => {
      const original = dialog.showOpenDialog
      dialog.showOpenDialog = async () => {
        dialog.showOpenDialog = original
        return { canceled: selection.cancel, filePaths: selection.cancel ? [] : selection.paths }
      }
    },
    { paths: [...sources.keys()].reverse(), cancel },
  )
  await page
    .getByRole('button', {
      name: locale === 'en' ? 'Choose configuration file' : '选择配置文件',
      exact: true,
    })
    .click()
  if (!cancel) await page.locator('.native-import-preview').waitFor()
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
  await choose()
  await page
    .getByText('3 literal secrets will be stored as encrypted credentials.', { exact: false })
    .waitFor()
  if (process.env.AGENT_MATRIX_SMOKE_SCREENSHOT)
    await page.screenshot({ path: process.env.AGENT_MATRIX_SMOKE_SCREENSHOT, fullPage: true })
  assert.equal((await state()).nativeImports, undefined)
  for (const value of secretValues)
    assert.ok(!(await page.locator('body').innerText()).includes(value), 'Preview exposed a secret')
  const changedSource = isPi ? join(root, 'auth.json') : source
  await writeFile(changedSource, sources.get(changedSource) + '\n')
  await page.getByRole('button', { name: 'Import configuration', exact: true }).click()
  await page.getByRole('alert').filter({ hasText: 'source file or installation changed' }).waitFor()
  assert.equal((await state()).nativeImports, undefined)
  await writeFile(changedSource, sources.get(changedSource))
  await language('zh-CN')
  await choose('zh-CN')
  await page.getByRole('heading', { name: '导入预览', exact: true }).waitFor()
  await page.getByRole('button', { name: '导入配置', exact: true }).click()
  await page.getByRole('status').filter({ hasText: '配置已导入' }).waitFor()
  const imported = await state()
  const record = imported.nativeImports[0]
  assert.equal(imported.nativeImports.length, 1)
  assert.equal(imported.agents.length, isPi ? 1 : 2)
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
  } else assert.equal(imported.mcpServers[0].envRefs.ENV_REFERENCE.name, 'IMPORT_ENV_REFERENCE')
  assert.equal(
    (await page.evaluate(() => window.agentMatrix.getCredentialStatus())).credentials.length,
    3,
  )
  await page.locator('.native-import-history summary').first().click()
  await page.getByText(diagnosticPath, { exact: true }).waitFor()
  const archivePath = join(dataDirectory, 'native-imports', `${record.id}.json`)
  const encrypted = JSON.parse(await readFile(archivePath, 'utf8'))
  assert.equal(
    await app.evaluate(
      async ({ safeStorage }, { ciphertext, expected, pi }) => {
        const decrypted = await safeStorage.decryptStringAsync(Buffer.from(ciphertext, 'base64'))
        const payload = Buffer.from(decrypted.result, 'base64').toString('utf8')
        if (!pi) return payload === expected[0]
        return (
          JSON.stringify(
            JSON.parse(payload).map((file) => Buffer.from(file.bytes, 'base64').toString('utf8')),
          ) === JSON.stringify(expected)
        )
      },
      { ciphertext: encrypted.ciphertext, expected: [...sources.values()], pi: isPi },
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
    await editor
      .getByLabel('Requested execution policy', { exact: true })
      .selectOption('unrestricted')
  await editor.locator('input[type="checkbox"]').first().check()
  await editor.getByRole('button', { name: 'Save Agent', exact: true }).click()
  await editor.waitFor({ state: 'hidden' })
  const agent = (await state()).agents.find((entry) => entry.name === profileName)
  await navigate('Sessions')
  await page.getByLabel('Agent configuration', { exact: true }).selectOption(agent.id)
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
        passed: true,
        engine: `${isPi ? 'Pi' : 'OpenCode'} ${version}`,
        locales: ['en', 'zh-CN'],
        readOnlyPreview: true,
        staleSourceRejected: true,
        exactEncryptedArchive: true,
        importedCredentials: 3,
        sourceFiles: sources.size,
        ...(isPi
          ? {
              storedAuthPrecedence: true,
              replacementAndAppend: true,
              escapedAndEnvironmentHeaders: true,
              commandsNotExecuted: true,
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
} finally {
  if (app) await app.close().catch(() => undefined)
  await new Promise((resolve) => server.close(resolve))
  if (passed) await rm(root, { recursive: true, force: true })
  else console.error(`Native import fixture retained: ${root}`)
}
