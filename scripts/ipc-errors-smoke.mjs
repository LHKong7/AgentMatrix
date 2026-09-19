import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, readdir, rename, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { _electron as electron } from 'playwright'
import { openCodeWorkspace } from '../tests/helpers/opencode-fixture.ts'

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
  const project = join(root, 'project')
  const executable = join(root, 'unused-engine')
  await mkdir(join(project, '.git'), { recursive: true })
  await writeFile(executable, '#!/bin/sh\nexit 99\n', { mode: 0o700 })
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
    let workspace = await page.evaluate(() => window.agentMatrix.loadWorkspace())
    const invoke = async (method, expected, input) => {
      const reply = await page.evaluate(
        async ({ method, input }) => {
          try {
            if (method === 'sessions.command') await window.agentMatrix.sessions.command(input)
            else await window.agentMatrix[method](input)
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
    for (const kind of ['opencode', 'pi']) {
      const fixture = openCodeWorkspace(executable, project)
      fixture.revision = workspace.revision
      fixture.prompts = []
      fixture.agents[0].promptBindings = []
      if (kind === 'pi') {
        Object.assign(fixture.installations[0], {
          kind,
          version: '0.85.1',
          modes: ['pi-rpc'],
        })
        fixture.agents[0].engineOptions = {
          kind,
          projectTrust: 'deny',
          contextFiles: 'ignore',
        }
        fixture.agents[0].execution.approval = 'unrestricted'
      }
      fixture.skills[0].versions[0].content = `---\nname: ${marker}\ndescription: Example\n---\nPrivate fixture Skill.`
      fixture.skills.push({ ...structuredClone(fixture.skills[0]), id: 'duplicate-skill' })
      fixture.agents[0].skillBindings.push({
        assetId: 'duplicate-skill',
        selection: { follow: 'latest' },
      })
      const saved = await page.evaluate((value) => window.agentMatrix.saveWorkspace(value), fixture)
      await invoke(
        'sessions.command',
        kind === 'pi' ? 'error.piConfiguration' : 'error.openCodeConfiguration',
        { kind: 'create', agentId: 'reviewer', commandId: `${kind}-${locale}-duplicate` },
      )
      assert.ok(replies.at(-1).includes('skill.duplicate'))
      assert.deepEqual(await page.evaluate(() => window.agentMatrix.loadWorkspace()), saved)
      assert.deepEqual(await page.evaluate(() => window.agentMatrix.sessions.list()), [])
      assert.deepEqual(await readdir(join(root, 'runs')), [])
      workspace = await page.evaluate((value) => window.agentMatrix.saveWorkspace(value), {
        ...workspace,
        revision: saved.revision,
      })
    }
    assert.deepEqual(await page.evaluate(() => window.agentMatrix.loadWorkspace()), workspace)
  }
  // Language changes legitimately update the workspace; failure cases must not introduce the marker.
  assert.ok(!String(await readFile(workspacePath)).includes(marker))
  assert.ok(original.length > 0)
  await app.close()
  app = undefined
  assert.equal(cases.length, 14)
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
    duplicateSkillFailures: 4,
    duplicateFailuresPublishNoSessionOrCapture: true,
    busyRecoveryChecks: 6,
    repliesContainNoMarker: !replies.join('\n').includes(marker),
    stderrContainsNoMarker: true,
    rendererErrors: 0,
    modelCalls: 0,
    externalProviderCalls: false,
    scope:
      'Real Electron preload/invoke handlers, workspace read/save, Skill import and duplicate-Skill capture rejection; dialog results/errors and installation metadata are controlled. No native runtime is attached. This checks exception projection, not successful payloads or arbitrary OS logs.',
  }
  if (process.env.AGENT_MATRIX_IPC_ERRORS_REPORT)
    await writeFile(
      process.env.AGENT_MATRIX_IPC_ERRORS_REPORT,
      JSON.stringify(report, null, 2) + '\n',
    )
  console.log(
    'IPC error smoke passed: 14 failures, both locales, six busy-state recoveries, four duplicate-Skill capture rejections, and no marker in replies or captured stderr.',
  )
} finally {
  await app?.close().catch(() => {})
  await rm(root, { recursive: true, force: true })
}
