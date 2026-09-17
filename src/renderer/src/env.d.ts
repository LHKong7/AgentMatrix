import type { AgentMatrixApi } from '../../shared/api'

declare global {
  interface Window {
    agentMatrix?: AgentMatrixApi
  }
}
