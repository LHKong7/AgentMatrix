import type { AgentMatrixApi } from '../../../shared/api'
import { createWorkspace, workspaceSchema } from '../../../shared/workspace'

const storageKey = 'agent-matrix:preview:v1'

// Browser preview uses its own storage; it never reads desktop configuration files.
const browserApi: AgentMatrixApi = {
  async loadWorkspace() {
    const saved = localStorage.getItem(storageKey)
    return saved ? workspaceSchema.parse(JSON.parse(saved)) : createWorkspace()
  },
  async saveWorkspace(input) {
    const workspace = workspaceSchema.parse(input)
    const current = await this.loadWorkspace()
    if (current.revision !== workspace.revision) throw new Error('配置已被更新，请刷新后重试。')
    const next = { ...workspace, revision: current.revision + 1 }
    localStorage.setItem(storageKey, JSON.stringify(next))
    return next
  },
  async getAppInfo() {
    return {
      version: '0.1.0',
      platform: 'browser',
      configPath: '当前浏览器的 localStorage',
      storage: 'browser',
    }
  },
}

export const api = window.agentMatrix ?? browserApi
