import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, readdir, rename, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { _electron as electron } from 'playwright'
import { openCodeWorkspace } from '../tests/helpers/opencode-fixture.ts'
import { chooseOption, languageSelect } from './lib/select.mjs'

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
let credentialRecoveryChecks = 0
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
    await chooseOption(page, languageSelect(page), locale)
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
    const labels =
      locale === 'en'
        ? {
            settings: 'Settings',
            name: 'Credential name',
            value: 'Secret value',
            replace: 'Replace secret',
            saved: 'Credential saved.',
            error:
              'The credential name or ID contains its secret value. Use a different name or ID; nothing was saved.',
          }
        : {
            settings: '设置',
            name: '凭据名称',
            value: '密钥',
            replace: '替换密钥',
            saved: '凭据已保存。',
            error: '凭据名称或 ID 包含密钥内容。请使用其他名称或 ID，本次未保存。',
          }
    await page.getByRole('button', { name: labels.settings, exact: true }).click()
    const panel = page.locator('.credential-panel')
    await panel.locator('form').waitFor()
    const credentialPath = join(root, 'credentials', 'vault.json')
    const credentialBytes = async () =>
      readFile(credentialPath).catch((error) => {
        if (error.code === 'ENOENT') return null
        throw error
      })
    const before = await page.evaluate(() => window.agentMatrix.getCredentialStatus())
    assert.equal(before.available, true, 'Credential checks require real OS secure storage')
    const bytesBefore = await credentialBytes()
    await invoke('setCredential', 'error.credentialMetadataSecret', {
      id: marker,
      name: 'Public name',
      kind: 'api-key',
      value: marker,
      expectedRevision: null,
    })
    assert.deepEqual(await page.evaluate(() => window.agentMatrix.getCredentialStatus()), before)
    assert.deepEqual(await credentialBytes(), bytesBefore)
    const publicName = `Desktop credential ${locale}`
    for (const replacement of [false, true]) {
      const value = replacement ? `replacement-${marker}` : marker
      const status = await page.evaluate(() => window.agentMatrix.getCredentialStatus())
      const bytes = await credentialBytes()
      if (replacement)
        await panel
          .locator('li')
          .filter({ hasText: publicName })
          .getByRole('button', { name: labels.replace, exact: true })
          .click()
      await panel.getByLabel(labels.name, { exact: true }).fill(value)
      await panel.getByLabel(labels.value, { exact: true }).fill(value)
      await panel.locator('form button[type="submit"]').click()
      await panel.getByRole('alert').filter({ hasText: labels.error }).waitFor()
      assert.equal(await panel.getByRole('alert').textContent(), labels.error)
      assert.deepEqual(await page.evaluate(() => window.agentMatrix.getCredentialStatus()), status)
      assert.deepEqual(await credentialBytes(), bytes)
      if (replacement) {
        const previous = JSON.parse(bytes).entries.find((entry) => entry.name === publicName)
        assert.equal(
          await app.evaluate(
            async ({ safeStorage }, ciphertext) =>
              (await safeStorage.decryptStringAsync(Buffer.from(ciphertext, 'base64'))).result,
            previous.ciphertext,
          ),
          marker,
        )
      }
      cases.push({ locale, method: 'credential-form', replacement, expected: labels.error })
      // Correcting the name must recover the same draft and keep the exact secret value.
      await panel.getByLabel(labels.name, { exact: true }).fill(publicName)
      await panel.locator('form button[type="submit"]').click()
      await panel.getByRole('status').filter({ hasText: labels.saved }).waitFor()
      assert.equal(await panel.getByLabel(labels.value, { exact: true }).inputValue(), '')
      const savedStatus = await page.evaluate(() => window.agentMatrix.getCredentialStatus())
      assert.ok(!JSON.stringify(savedStatus).includes(marker))
      const savedBytes = await credentialBytes()
      assert.ok(!String(savedBytes).includes(marker))
      const saved = JSON.parse(savedBytes).entries.find((entry) => entry.name === publicName)
      assert.equal(saved.revision, replacement ? 2 : 1)
      assert.equal(
        await app.evaluate(
          async ({ safeStorage }, ciphertext) =>
            (await safeStorage.decryptStringAsync(Buffer.from(ciphertext, 'base64'))).result,
          saved.ciphertext,
        ),
        value,
      )
      credentialRecoveryChecks++
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
  assert.equal(cases.length, 20)
  assert.equal(credentialRecoveryChecks, 4)
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
    credentialMetadataFailures: 6,
    credentialRejectionsPreserveVaultBytesAndMetadata: true,
    credentialReplacementRejectionsPreserveDecryptableOriginal: true,
    credentialRecoveryChecks,
    credentialRecoveryUsesRealOsEncryption: true,
    duplicateFailuresPublishNoSessionOrCapture: true,
    busyRecoveryChecks: 6,
    repliesContainNoMarker: !replies.join('\n').includes(marker),
    stderrContainsNoMarker: true,
    rendererErrors: 0,
    modelCalls: 0,
    externalProviderCalls: false,
    scope:
      'Real Electron preload/invoke handlers, workspace read/save, Skill import, duplicate-Skill capture rejection, and bilingual credential forms with real OS encryption. Credential checks cover rejected name/ID copies, unchanged vault bytes/metadata, retained original decryption and corrected draft saves. Dialog results/errors and installation metadata are controlled. No native runtime is attached; this is not a general audit of successful payloads or arbitrary OS logs.',
  }
  if (process.env.AGENT_MATRIX_IPC_ERRORS_REPORT)
    await writeFile(
      process.env.AGENT_MATRIX_IPC_ERRORS_REPORT,
      JSON.stringify(report, null, 2) + '\n',
    )
  console.log(
    'IPC error smoke passed: 20 failures, both locales, six busy-state recoveries, four duplicate-Skill rejections, six credential-metadata rejections, four corrected credential saves, and no marker in replies or captured stderr.',
  )
} finally {
  await app?.close().catch(() => {})
  await rm(root, { recursive: true, force: true })
}
