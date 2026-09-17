import { app, BrowserWindow, ipcMain, session, type IpcMainInvokeEvent } from 'electron'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { channels, type AppInfo } from '../shared/api'
import { WorkspaceStore } from './workspace-store'

app.setName('AgentMatrix')
if (!app.isPackaged && process.env.AGENT_MATRIX_DATA_DIR) {
  app.setPath('userData', process.env.AGENT_MATRIX_DATA_DIR)
}

let mainWindow: BrowserWindow | null = null
const rendererFile = join(__dirname, '../renderer/index.html')
const rendererUrl = new URL(
  !app.isPackaged && process.env.ELECTRON_RENDERER_URL
    ? process.env.ELECTRON_RENDERER_URL
    : pathToFileURL(rendererFile).href,
).href

function verifySender(event: IpcMainInvokeEvent): void {
  if (
    !mainWindow ||
    event.sender !== mainWindow.webContents ||
    event.senderFrame !== mainWindow.webContents.mainFrame ||
    event.senderFrame.url !== rendererUrl
  ) {
    throw new Error('不受信任的配置访问请求')
  }
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
    const store = new WorkspaceStore(join(app.getPath('userData'), 'workspace.json'))
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
    createWindow()
    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow()
    })
  })
}

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
