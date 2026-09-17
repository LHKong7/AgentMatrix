import { contextBridge, ipcRenderer } from 'electron'
import { channels, type AgentMatrixApi } from '../shared/api'

const api: AgentMatrixApi = {
  loadWorkspace: () => ipcRenderer.invoke(channels.load),
  saveWorkspace: (workspace) => ipcRenderer.invoke(channels.save, workspace),
  getAppInfo: () => ipcRenderer.invoke(channels.info),
  getCredentialStatus: () => ipcRenderer.invoke(channels.credentialStatus),
  setCredential: (input) => ipcRenderer.invoke(channels.credentialSet, input),
  deleteCredential: (input) => ipcRenderer.invoke(channels.credentialDelete, input),
}

contextBridge.exposeInMainWorld('agentMatrix', api)
