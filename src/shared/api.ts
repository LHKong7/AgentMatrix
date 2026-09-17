import type { EngineWorkspace } from './engines/workspace'
import type { CapturedSkillDirectory } from './engines/skill-import'
import type { SessionApi } from './sessions/schema'
import type {
  CredentialInput,
  CredentialMetadata,
  CredentialStatus,
  DeleteCredentialInput,
} from './credentials'

export interface AppInfo {
  version: string
  platform: string
  configPath: string
  storage: 'desktop' | 'browser'
}

export interface AgentMatrixApi {
  loadWorkspace(): Promise<EngineWorkspace>
  saveWorkspace(workspace: EngineWorkspace): Promise<EngineWorkspace>
  getAppInfo(): Promise<AppInfo>
  getCredentialStatus(): Promise<CredentialStatus>
  setCredential(input: CredentialInput): Promise<CredentialMetadata>
  deleteCredential(input: DeleteCredentialInput): Promise<void>
  importSkillDirectory(): Promise<CapturedSkillDirectory | null>
  probeEngine(input: { installationId: string }): Promise<EngineWorkspace>
  sessions: SessionApi
}

export const channels = {
  load: 'workspace:load',
  save: 'workspace:save',
  info: 'app:info',
  credentialStatus: 'credentials:status',
  credentialSet: 'credentials:set',
  credentialDelete: 'credentials:delete',
  skillImport: 'skills:import-directory',
  engineProbe: 'engines:probe',
} as const
