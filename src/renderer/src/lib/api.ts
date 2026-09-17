import { appError } from '../../../shared/errors'
import { getInitialLocale } from '../i18n/preferences'
import type { AgentMatrixApi } from '../../../shared/api'
import { createWorkspace, workspaceSchema } from '../../../shared/workspace'

const storageKey = 'agent-matrix:preview:v1'

// Browser preview uses its own storage; it never reads desktop configuration files.
const browserApi: AgentMatrixApi = {
  async loadWorkspace() {
    const saved = localStorage.getItem(storageKey)
    if (!saved) return createWorkspace(getInitialLocale())
    try {
      return workspaceSchema.parse(JSON.parse(saved))
    } catch {
      throw appError('error.unreadable', { path: 'localStorage' })
    }
  },
  async saveWorkspace(input) {
    const workspace = workspaceSchema.parse(input)
    const current = await this.loadWorkspace()
    if (current.revision !== workspace.revision) throw appError('error.conflict')
    const next = { ...workspace, revision: current.revision + 1 }
    localStorage.setItem(storageKey, JSON.stringify(next))
    return next
  },
  async getAppInfo() {
    return {
      version: '0.1.0',
      platform: 'browser',
      configPath: 'localStorage',
      storage: 'browser',
    }
  },
}

export const api = window.agentMatrix ?? browserApi
