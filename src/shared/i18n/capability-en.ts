export const capabilityEn = {
  'capability.title': 'Native capability evidence',
  'capability.hint':
    'These checks belong to the captured configuration and the last successful process attachment. Saved-profile previews remain separate. Verification covers only the stated scope; native declarations do not prove successful use.',
  'capability.current':
    'Evidence belongs to the current attachment. Availability is a recorded observation, not continuous monitoring.',
  'capability.historical': 'Historical or absent evidence. No current attachment is verified.',
  'capability.identity': 'Captured configuration digest / observed process run',
  'capability.feature': 'Capability / verification scope',
  'capability.evidence': 'Evidence',
  'capability.verification.untested': 'No recorded verification',
  'capability.verification.passed': 'Verified within this scope',
  'capability.verification.failed': 'Recorded check failed',
  'capability.availability.unknown': 'Current availability unknown',
  'capability.evidence.contract': 'Adapter contract',
  'capability.evidence.advertisement': 'Native declaration',
  'capability.evidence.runtime': 'Recorded native check',
  'capability.reason.contract-changed':
    'The captured adapter contract no longer matches this application. Prior checks are not promoted.',
  'capability.reason.extension-required':
    'A compatible, verified MCP extension is not available in this adapter.',
  'capability.reason.unsupported': 'Not supported by this adapter and selected route.',
  'capability.reason.unused': 'This optional feature was not captured for the session.',
  'capability.reason.historical':
    'The recorded process is no longer attached. A new start or resume must perform fresh checks.',
  'capability.reason.not-advertised':
    'This native process did not advertise a supported restoration method.',
  'capability.reason.verified': 'The recorded check passed for this attachment and scope.',
  'capability.reason.advertised':
    'The native process advertises restoration. Successful restoration has not been observed for this attachment.',
  'capability.reason.unknown':
    'No matching check was recorded. Ready state or successful file generation is insufficient.',
  'capability.feature.installation-version': 'Installed CLI version',
  'capability.feature.session-protocol': 'Native session connection',
  'capability.feature.native-restore': 'Native session restoration',
  'capability.feature.model-selection': 'Selected native model',
  'capability.feature.connection-mapping': 'Connection configuration',
  'capability.feature.credential-resolution': 'Captured secret resolution',
  'capability.feature.model-service': 'Model service acceptance',
  'capability.feature.sampling-mapping': 'Sampling configuration',
  'capability.feature.reasoning-selection': 'Selected reasoning setting',
  'capability.feature.prompt-mapping': 'Prompt configuration',
  'capability.feature.prompt-loading': 'Prompt application',
  'capability.feature.skill-mapping': 'Skill configuration',
  'capability.feature.skill-discovery': 'Native Skill discovery',
  'capability.feature.mcp-mapping': 'MCP configuration',
  'capability.feature.mcp-connectivity': 'MCP connectivity',
  'capability.feature.plugin-activation': 'Selected plugin activation',
  'capability.feature.policy-mapping': 'Requested policy configuration',
  'capability.feature.policy-enforcement': 'Universal tool approval',
  'capability.scope.installation-version':
    'Version checked at attachment; no continuous binary monitoring.',
  'capability.scope.session-protocol':
    'Native session acknowledged after ACP initialization or Pi RPC state checks.',
  'capability.scope.native-restore':
    'Resume/load/switch acknowledged with the same native identity; future restore remains subject to startup checks.',
  'capability.scope.model-selection':
    'Native selected model matched; no provider request is implied.',
  'capability.scope.connection-mapping':
    'OpenCode config, Pi state, or DSH composition matched. DSH dumps do not activate provider components.',
  'capability.scope.credential-resolution':
    'All captured secret references resolved for launch; no provider authentication claim.',
  'capability.scope.model-service':
    'Provider acceptance requires separate evidence. A completed workflow can be handled by an extension.',
  'capability.scope.sampling-mapping':
    'Only explicitly requested values with native configuration readback.',
  'capability.scope.reasoning-selection':
    'Pi or native DeepSeek selected setting; no claim about model reasoning behavior.',
  'capability.scope.prompt-mapping':
    'Native configuration wiring, not complete instructions received by a model.',
  'capability.scope.prompt-loading':
    'Actual instruction application is not established by configuration readback.',
  'capability.scope.skill-mapping':
    'Configured paths or discovered command names, not Skill execution.',
  'capability.scope.skill-discovery':
    'Pi command discovery checked names; OpenCode/DSH configuration alone cannot prove discovery.',
  'capability.scope.mcp-mapping': 'Server configuration wiring, not connection or authentication.',
  'capability.scope.mcp-connectivity':
    'Requires server-specific connection/tool evidence; configuration and ACP flags are insufficient.',
  'capability.scope.plugin-activation':
    'Selected plugin startup and native instance checks; arbitrary hooks and full dependencies remain outside scope.',
  'capability.scope.policy-mapping':
    'Requested native policy readback; no sandbox or enforcement guarantee.',
  'capability.scope.policy-enforcement':
    'No blanket guarantee for all native or plugin tools. Pi does not provide universal approval.',
} as const
