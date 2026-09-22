import type { CredentialInput } from '../../shared/credentials'
import type { NativeImportRecord } from '../../shared/engines/native-import'
import type { EngineProviderBinding } from '../../shared/engines/provider'
import type { EngineWorkspace } from '../../shared/engines/workspace'

export interface NativeImportPlan {
  additions: Pick<EngineWorkspace, 'connections' | 'models' | 'agents' | 'prompts' | 'mcpServers'>
  /** Grants the adopting CLI the connections its own configuration already uses. */
  bindings: EngineProviderBinding[]
  credentials: CredentialInput[]
  mappings: NativeImportRecord['mappings']
  diagnostics: NativeImportRecord['diagnostics']
}
