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
  // The grant follows the engine: the OpenCode installation this fixture replaced is gone.
  workspace.engineBindings[0] = {
    ...workspace.engineBindings[0]!,
    installationId: 'pi',
    adapterVersion: 'pi-rpc@1+0.85.1',
  }
  return workspace
}
