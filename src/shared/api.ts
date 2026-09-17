import type { Workspace } from './workspace'

export interface AppInfo {
  version: string
  platform: string
  configPath: string
  storage: 'desktop' | 'browser'
}

export interface AgentMatrixApi {
  loadWorkspace(): Promise<Workspace>
  saveWorkspace(workspace: Workspace): Promise<Workspace>
  getAppInfo(): Promise<AppInfo>
}

export const channels = {
  load: 'workspace:load',
  save: 'workspace:save',
  info: 'app:info',
} as const
