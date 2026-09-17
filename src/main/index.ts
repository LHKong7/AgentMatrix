import { appError } from '../shared/errors'
import { resolveLocale, translate } from '../shared/i18n'
import { app, BrowserWindow, dialog, ipcMain, session, type IpcMainInvokeEvent } from 'electron'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { channels, type AppInfo } from '../shared/api'
import { EngineWorkspaceStore } from './engine-workspace-store'
import { CredentialVault } from './credentials/vault'
import { electronCipher } from './credentials/electron-cipher'
import { SkillDirectoryStore } from './assets/skill-directory-store'
import { RunInputStore } from './engines/run-input-store'
import { SessionJournal } from './sessions/journal'
import { SessionCoordinator } from './sessions/coordinator'
import { DesktopSessionFactory } from './sessions/desktop-factory'
import { registerSessionIpc, safeSessionOperation, verifyRenderer } from './sessions/ipc'
import { stopOwnedProcesses } from './engines/process/managed-process'

app.setName('AgentMatrix')
if (!app.isPackaged && process.env.AGENT_MATRIX_DATA_DIR) {
  app.setPath('userData', process.env.AGENT_MATRIX_DATA_DIR)
}

let mainWindow: BrowserWindow | null = null
let sessionBridge: ReturnType<typeof registerSessionIpc> | undefined
const rendererFile = join(__dirname, '../renderer/index.html')
const rendererUrl = new URL(
  !app.isPackaged && process.env.ELECTRON_RENDERER_URL
    ? process.env.ELECTRON_RENDERER_URL
    : pathToFileURL(rendererFile).href,
).href

function verifySender(event: IpcMainInvokeEvent): void {
  verifyRenderer(event, mainWindow?.webContents ?? null, rendererUrl)
}

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1360,
    height: 900,
    minWidth: 1000,
    minHeight: 680,
    title: 'AgentMatrix',
    backgroundColor: '#f8faf9',
    show: false,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  })
  mainWindow.once('ready-to-show', () => mainWindow?.show())
  sessionBridge?.attach(mainWindow.webContents)
  mainWindow.on('closed', () => {
    mainWindow = null
  })
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  mainWindow.webContents.on('will-navigate', (event) => event.preventDefault())
  mainWindow.webContents.on('will-attach-webview', (event) => event.preventDefault())
  void mainWindow.loadURL(rendererUrl)
}

if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', () => {
    if (mainWindow?.isMinimized()) mainWindow.restore()
    mainWindow?.focus()
  })

  void app.whenReady().then(() => {
    const skillDirectories = new SkillDirectoryStore(
      join(app.getPath('userData'), 'assets', 'skills'),
    )
    const store = new EngineWorkspaceStore(
      join(app.getPath('userData'), 'workspace.json'),
      resolveLocale([app.getLocale()]),
      (revision) => skillDirectories.verify(revision),
    )
    const vault = new CredentialVault(
      join(app.getPath('userData'), 'credentials', 'vault.json'),
      electronCipher,
    )
    const factory = new DesktopSessionFactory({
      workspace: store,
      runs: new RunInputStore(join(app.getPath('userData'), 'runs'), skillDirectories),
      skills: skillDirectories,
      dataDirectory: app.getPath('userData'),
      environment: process.env,
      resolveSecret: (reference) => vault.resolve(reference, process.env),
    })
    const coordinator = new SessionCoordinator(
      new SessionJournal(join(app.getPath('userData'), 'sessions')),
      factory,
    )
    sessionBridge = registerSessionIpc(ipcMain, coordinator, verifySender)
    ipcMain.handle(channels.engineProbe, (event, input: unknown) =>
      safeSessionOperation(async () => {
        verifySender(event)
        return factory.probe(input)
      }),
    )
    let quitReady = false
    let quitting = false
    app.on('before-quit', (event) => {
      if (quitReady) return
      event.preventDefault()
      if (quitting) return
      quitting = true
      void (async () => {
        const stopped = await Promise.allSettled([coordinator.shutdown(), factory.shutdown()])
        stopped.push(...(await Promise.allSettled([stopOwnedProcesses()])))
        if (stopped.some((result) => result.status === 'rejected')) {
          quitting = false
          const locale = resolveLocale([app.getLocale()])
          dialog.showErrorBox('AgentMatrix', translate(locale, 'error.runtimeShutdown'))
          return
        }
        quitReady = true
        app.quit()
      })()
    })
    session.defaultSession.setPermissionRequestHandler((_contents, _permission, callback) =>
      callback(false),
    )
    session.defaultSession.setPermissionCheckHandler(() => false)
    ipcMain.handle(channels.load, (event) => {
      verifySender(event)
      return store.load()
    })
    ipcMain.handle(channels.save, (event, workspace: unknown) => {
      verifySender(event)
      return store.save(workspace)
    })
    ipcMain.handle(channels.info, (event): AppInfo => {
      verifySender(event)
      return {
        version: app.getVersion(),
        platform: process.platform,
        configPath: store.filePath,
        storage: 'desktop',
      }
    })
    ipcMain.handle(channels.credentialStatus, (event) => {
      verifySender(event)
      return vault.status()
    })
    ipcMain.handle(channels.credentialSet, (event, input: unknown) => {
      verifySender(event)
      return vault.set(input)
    })
    ipcMain.handle(channels.credentialDelete, (event, input: unknown) => {
      verifySender(event)
      return vault.remove(input)
    })
    let importingSkill = false
    ipcMain.handle(channels.skillImport, async (event) => {
      verifySender(event)
      if (importingSkill) throw appError('error.skillImportBusy')
      importingSkill = true
      try {
        const result = await dialog.showOpenDialog(mainWindow!, { properties: ['openDirectory'] })
        if (result.canceled || !result.filePaths[0]) return null
        verifySender(event)
        return await skillDirectories.capture(result.filePaths[0])
      } finally {
        importingSkill = false
      }
    })
    createWindow()
    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow()
    })
  })
}

app.on('window-all-closed', () => {
  app.quit()
})
