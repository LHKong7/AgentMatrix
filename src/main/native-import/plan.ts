import type { CredentialInput } from '../../shared/credentials'
import type { NativeImportRecord } from '../../shared/engines/native-import'
import type { EngineWorkspace } from '../../shared/engines/workspace'

export interface NativeImportPlan {
  additions: Pick<EngineWorkspace, 'connections' | 'models' | 'agents' | 'prompts' | 'mcpServers'>
  credentials: CredentialInput[]
  mappings: NativeImportRecord['mappings']
  diagnostics: NativeImportRecord['diagnostics']
}
