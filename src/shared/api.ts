import type { EngineWorkspace } from './engines/workspace'
import type { CapturedSkillDirectory } from './engines/skill-import'
import type { PluginInspection, PluginInspectionQuery } from './engines/plugin-inspection'
import type { SessionApi } from './sessions/schema'
import type { NativeImportPreview } from './engines/native-import'
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
  chooseWorkingDirectory(input: { defaultPath?: string }): Promise<string | null>
  probeEngine(input: { installationId: string }): Promise<EngineWorkspace>
  inspectNativePlugin(input: PluginInspectionQuery): Promise<PluginInspection>
  previewNativeImport(input: {
    installationId: string
    previousPreviewId?: string
  }): Promise<NativeImportPreview | null>
  applyNativeImport(input: { id: string; workspaceRevision: number }): Promise<EngineWorkspace>
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
  workingDirectory: 'sessions:choose-working-directory',
  engineProbe: 'engines:probe',
  pluginInspect: 'plugins:inspect-installed',
  nativeImportPreview: 'native-import:preview',
  nativeImportApply: 'native-import:apply',
} as const
