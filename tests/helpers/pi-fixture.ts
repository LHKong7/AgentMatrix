import { openCodeWorkspace } from './opencode-fixture'

export function piWorkspace(executable: string, cwd: string) {
  const workspace = openCodeWorkspace(executable, cwd)
  workspace.installations[0] = {
    ...workspace.installations[0]!,
    id: 'pi',
    kind: 'pi',
    name: 'Pi',
    version: '0.85.1',
    modes: ['pi-rpc'],
  }
  workspace.agents[0]!.engineInstallationId = 'pi'
  workspace.agents[0]!.engineOptions = { kind: 'pi', projectTrust: 'deny', contextFiles: 'inherit' }
  workspace.agents[0]!.execution.approval = 'unrestricted'
  return workspace
}
