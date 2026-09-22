/** Pinned adapter contracts. A matching version still requires startup and native-state checks. */
export const engineContracts = {
  opencode: { id: 'opencode-acp', version: '1', engineVersion: '1.18.16', mode: 'acp' },
  pi: { id: 'pi-rpc', version: '1', engineVersion: '0.85.1', mode: 'pi-rpc' },
  'deepseek-harness': { id: 'dsh-acp', version: '1', engineVersion: '0.1.5-rc.2', mode: 'acp' },
} as const
export type SupportedEngine = keyof typeof engineContracts
export function isSupportedEngine(kind: string): kind is SupportedEngine {
  return Object.hasOwn(engineContracts, kind)
}

export const openCodeProviders = {
  'openai-chat-completions': '@ai-sdk/openai-compatible',
  'openai-responses': '@ai-sdk/openai',
  'anthropic-messages': '@ai-sdk/anthropic',
  gemini: '@ai-sdk/google',
} as const
export const piApis = {
  'openai-chat-completions': 'openai-completions',
  'openai-responses': 'openai-responses',
  'anthropic-messages': 'anthropic-messages',
  gemini: 'google-generative-ai',
} as const
