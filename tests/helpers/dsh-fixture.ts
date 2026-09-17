import { openCodeWorkspace } from './opencode-fixture'

export function dshWorkspace(executable: string, cwd: string) {
  const workspace = openCodeWorkspace(executable, cwd)
  workspace.installations[0] = {
    ...workspace.installations[0]!,
    id: 'dsh',
    kind: 'deepseek-harness',
    name: 'DeepSeek Harness',
    version: '0.1.5-rc.2',
    modes: ['acp'],
  }
  workspace.agents[0]!.engineInstallationId = 'dsh'
  workspace.agents[0]!.engineOptions = {
    kind: 'deepseek-harness',
    profileTemplate: 'acp',
    patchReload: 'startup',
  }
  workspace.agents[0]!.execution.approval = 'unrestricted'
  return workspace
}
