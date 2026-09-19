import { contextBridge, ipcRenderer } from 'electron'
import { channels, type AgentMatrixApi } from '../shared/api'
import { sessionChannels } from '../shared/sessions/channels'
import type { SessionDelivery } from '../shared/sessions/schema'

const api: AgentMatrixApi = {
  loadWorkspace: () => ipcRenderer.invoke(channels.load),
  saveWorkspace: (workspace) => ipcRenderer.invoke(channels.save, workspace),
  getAppInfo: () => ipcRenderer.invoke(channels.info),
  getCredentialStatus: () => ipcRenderer.invoke(channels.credentialStatus),
  setCredential: (input) => ipcRenderer.invoke(channels.credentialSet, input),
  deleteCredential: (input) => ipcRenderer.invoke(channels.credentialDelete, input),
  importSkillDirectory: () => ipcRenderer.invoke(channels.skillImport),
  chooseWorkingDirectory: (input) => ipcRenderer.invoke(channels.workingDirectory, input),
  probeEngine: (input) => ipcRenderer.invoke(channels.engineProbe, input),
  inspectNativePlugin: (input) => ipcRenderer.invoke(channels.pluginInspect, input),
  previewNativeImport: (input) => ipcRenderer.invoke(channels.nativeImportPreview, input),
  applyNativeImport: (input) => ipcRenderer.invoke(channels.nativeImportApply, input),
  sessions: {
    history: (input) => ipcRenderer.invoke(sessionChannels.history, input),
    exportHistory: (input) => ipcRenderer.invoke(sessionChannels.exportHistory, input),
    impact: (input) => ipcRenderer.invoke(sessionChannels.impact, input),
    configuration: (input) => ipcRenderer.invoke(sessionChannels.configuration, input),
    command: (input) => ipcRenderer.invoke(sessionChannels.command, input),
    get: (input) => ipcRenderer.invoke(sessionChannels.get, input),
    list: () => ipcRenderer.invoke(sessionChannels.list),
    readEvents: (input) => ipcRenderer.invoke(sessionChannels.events, input),
    async subscribe(input, receive) {
      let active = true
      const listener = (_event: Electron.IpcRendererEvent, delivery: SessionDelivery) => {
        if (active && delivery.subscriptionId === input.subscriptionId) receive(delivery)
      }
      ipcRenderer.on(sessionChannels.delivery, listener)
      try {
        const { snapshot } = await ipcRenderer.invoke(sessionChannels.subscribe, input)
        return {
          snapshot,
          unsubscribe: async () => {
            if (!active) return
            active = false
            ipcRenderer.removeListener(sessionChannels.delivery, listener)
            await ipcRenderer.invoke(sessionChannels.unsubscribe, {
              sessionId: input.sessionId,
              subscriptionId: input.subscriptionId,
            })
          },
        }
      } catch (error) {
        active = false
        ipcRenderer.removeListener(sessionChannels.delivery, listener)
        throw error
      }
    },
  },
}

contextBridge.exposeInMainWorld('agentMatrix', api)
