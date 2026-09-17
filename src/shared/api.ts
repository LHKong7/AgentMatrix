import type { Workspace } from './workspace'
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
  loadWorkspace(): Promise<Workspace>
  saveWorkspace(workspace: Workspace): Promise<Workspace>
  getAppInfo(): Promise<AppInfo>
  getCredentialStatus(): Promise<CredentialStatus>
  setCredential(input: CredentialInput): Promise<CredentialMetadata>
  deleteCredential(input: DeleteCredentialInput): Promise<void>
}

export const channels = {
  load: 'workspace:load',
  save: 'workspace:save',
  info: 'app:info',
  credentialStatus: 'credentials:status',
  credentialSet: 'credentials:set',
  credentialDelete: 'credentials:delete',
} as const
