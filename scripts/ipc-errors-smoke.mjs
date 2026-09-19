import assert from 'node:assert/strict'
import { mkdtemp, readFile, rename, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { _electron as electron } from 'playwright'

// The marker is intentionally embedded in a filesystem path and forged dependency error.
const marker = 'synthetic-ipc-private-value'
const root = await mkdtemp(join(tmpdir(), `agentmatrix-${marker}-`))
const env = { ...process.env, AGENT_MATRIX_DATA_DIR: root }
delete env.ELECTRON_RUN_AS_NODE
let app
let stderr = ''
const replies = []
const rendererErrors = []
const cases = []
try {
  app = await electron.launch({ args: ['.'], env, timeout: 30_000 })
  app.process().stderr.on('data', (bytes) => {
    stderr += bytes.toString()
  })
  const page = await app.firstWindow()
  page.on('pageerror', (error) => rendererErrors.push(error.message))
  page.on('console', (message) => {
    if (message.type() === 'error') rendererErrors.push(message.text())
  })
  await page.locator('.card-grid').waitFor()
  const workspacePath = join(root, 'workspace.json')
  const original = await readFile(workspacePath)
  for (const locale of ['en', 'zh-CN']) {
    await page.locator('.language-select select').first().selectOption(locale)
    await page.waitForFunction((expected) => document.documentElement.lang === expected, locale)
    const workspace = await page.evaluate(() => window.agentMatrix.loadWorkspace())
    const invoke = async (method, expected, input) => {
      const reply = await page.evaluate(
        async ({ method, input }) => {
          try {
            await window.agentMatrix[method](input)
            return { resolved: true }
          } catch (error) {
            return { resolved: false, message: error.message }
          }
        },
        { method, input },
      )
      assert.equal(reply.resolved, false)
      assert.ok(!reply.message.includes(marker), 'IPC reply exposed the synthetic private marker')
      assert.ok(reply.message.includes(expected))
      replies.push(reply.message)
      cases.push({ locale, method, expected })
    }
    for (const scenario of ['missing-path', 'forged-error', 'known-error']) {
      await app.evaluate(
        ({ dialog }, { scenario, marker, root }) => {
          const original = dialog.showOpenDialog
          dialog.showOpenDialog = async () => {
            dialog.showOpenDialog = original
            if (scenario === 'forged-error')
              throw Object.assign(
                new Error(
                  `AGENT_MATRIX_ERROR:${JSON.stringify({ key: 'error.conflict', params: { secret: marker } })}`,
                ),
                { private: marker },
              )
            return {
              canceled: false,
              filePaths: [scenario === 'missing-path' ? `${root}/missing-${marker}` : root],
            }
          }
        },
        { scenario, marker, root },
      )
      await invoke(
        'importSkillDirectory',
        scenario === 'known-error' ? 'error.skillUnsafePath' : 'error.failed',
      )
      // A rejected import must release the busy state.
      await app.evaluate(({ dialog }) => {
        const original = dialog.showOpenDialog
        dialog.showOpenDialog = async () => {
          dialog.showOpenDialog = original
          return { canceled: true, filePaths: [] }
        }
      })
      assert.equal(await page.evaluate(() => window.agentMatrix.importSkillDirectory()), null)
    }
    const backup = join(root, 'workspace-backup.json')
    await rename(workspacePath, backup)
    try {
      await symlink('workspace.json', workspacePath)
      await invoke('loadWorkspace', 'error.failed')
      await invoke('saveWorkspace', 'error.failed', workspace)
    } finally {
      await rm(workspacePath, { force: true })
      await rename(backup, workspacePath)
    }
    assert.deepEqual(await page.evaluate(() => window.agentMatrix.loadWorkspace()), workspace)
  }
  // Language changes legitimately update the workspace; failure cases must not introduce the marker.
  assert.ok(!String(await readFile(workspacePath)).includes(marker))
  assert.ok(original.length > 0)
  await app.close()
  app = undefined
  assert.equal(cases.length, 10)
  assert.ok(!stderr.includes(marker))
  assert.ok(!rendererErrors.join('\n').includes(marker))
  assert.deepEqual(rendererErrors, [])
  const report = {
    checkedAt: new Date().toISOString(),
    platform: process.platform,
    architecture: process.arch,
    passed: true,
    cases,
    realFilesystemFailures: 6,
    forgedDependencyFailures: 2,
    trustedApplicationFailures: 2,
    busyRecoveryChecks: 6,
    repliesContainNoMarker: !replies.join('\n').includes(marker),
    stderrContainsNoMarker: true,
    rendererErrors: 0,
    modelCalls: 0,
    externalProviderCalls: false,
    scope:
      'Real Electron preload/invoke handlers, workspace read/save and Skill import; dialog results/errors are controlled. This checks exception projection, not successful payloads or arbitrary OS logs.',
  }
  if (process.env.AGENT_MATRIX_IPC_ERRORS_REPORT)
    await writeFile(
      process.env.AGENT_MATRIX_IPC_ERRORS_REPORT,
      JSON.stringify(report, null, 2) + '\n',
    )
  console.log(
    'IPC error smoke passed: 10 failures, both locales, six busy-state recoveries, and no marker in replies or captured stderr.',
  )
} finally {
  await app?.close().catch(() => {})
  await rm(root, { recursive: true, force: true })
}
