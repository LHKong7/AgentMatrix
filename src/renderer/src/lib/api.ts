import { appError } from '../../../shared/errors'
import { getInitialLocale } from '../i18n/preferences'
import type { AgentMatrixApi } from '../../../shared/api'
import { BrowserWorkspaceStore } from '../../../shared/engines/browser-store'

// Browser preview never reads desktop files or stores plaintext credentials.
const browserApi: AgentMatrixApi = {
  async importSkillDirectory() {
    throw appError('error.skillDesktopOnly')
  },
  async getCredentialStatus() {
    return { available: false, credentials: [] }
  },
  async setCredential() {
    throw appError('error.credentialsUnavailable')
  },
  async deleteCredential() {
    throw appError('error.credentialsUnavailable')
  },
  async loadWorkspace() {
    return new BrowserWorkspaceStore(localStorage, getInitialLocale()).load()
  },
  async saveWorkspace(input) {
    return new BrowserWorkspaceStore(localStorage, getInitialLocale()).save(input)
  },
  async getAppInfo() {
    return { version: '0.1.0', platform: 'browser', configPath: 'localStorage', storage: 'browser' }
  },
}

export const api = window.agentMatrix ?? browserApi
