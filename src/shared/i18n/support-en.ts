export const supportEn = {
  'support.issue.endpoint':
    'For Anthropic, enter a provider root or /v1 base URL without login details, a query, fragment, or /messages suffix.',
  'support.issue.native-plugin-options':
    'These plugin options belong to a different engine. Clear or change them before starting.',

  'support.issue.pi-plugin-policy':
    'Selected Pi extensions can register or enable tools. This adapter requires unrestricted execution for these bindings.',
  'support.issue.plugins-pure-mode':
    'OpenCode pure mode skips external plugins. Remove --pure before starting with selected plugins.',
  'support.title': 'Engine compatibility',
  'support.blocked':
    'Keep this profile as a draft. Resolve these adapter constraints before starting a new session.',
  'support.eligible':
    'No known adapter constraint blocks these settings. Startup checks are still required.',
  'support.limits':
    'Starting a session checks the executable, working directory, captured files, native sources, credentials, and native state. This preview does not run a CLI or verify the model service, Skill invocation, MCP connectivity, or sandbox enforcement.',
  'support.details': 'Capability details',
  'support.unavailable': 'Capability details are temporarily unavailable.',
  'support.evidenceScope':
    'Mechanism, runtime verification, and availability are separate. Contract rules describe the adapter; they are not runtime evidence for this profile. Unused optional features do not block startup.',
  'support.mechanism': 'Mechanism',
  'support.verification': 'Runtime verification',
  'support.availability': 'Availability',
  'support.requested': 'Configured',
  'support.unused': 'Not requested',
  'support.identity': '{engine} {version} · {mode} · Configuration digest',
  'support.contractEvidence':
    'Adapter contract evaluated: {time}. See a session configuration report for recorded native checks.',
  'support.mechanism.native': 'Native interface',
  'support.mechanism.adapter': 'Adapter mapping',
  'support.mechanism.extension-required': 'Extension required',
  'support.mechanism.unsupported': 'Not supported by this adapter',
  'support.mechanism.unknown': 'Unknown',
  'support.verification.untested': 'Not verified for this profile',
  'support.verification.passed': 'Verified within recorded scope',
  'support.verification.failed': 'Recorded check failed',
  'support.availability.ready': 'Available within recorded scope',
  'support.availability.missing-dependency': 'Dependency unavailable',
  'support.availability.missing-credential': 'Credential unavailable',
  'support.availability.blocked': 'Blocked',
  'support.availability.unknown': 'Not checked at startup',
  'support.reason.startup': 'Native startup validation is pending.',
  'support.reason.credentials':
    'A credential reference does not prove the credential is available or accepted.',
  'support.reason.assets':
    'Captured files, Skill metadata, name collisions and native discovery require further checks.',
  'support.reason.mcp': 'Mapping a server does not prove connection or authentication succeeds.',
  'support.reason.unsupported':
    'This adapter does not implement this feature for the selected route.',
  'support.reason.unused': 'This optional setting is not requested by the profile.',
  'support.issue.unsupported-engine': 'This engine has no desktop runtime adapter yet.',
  'support.issue.installation-version':
    'The installed version or runtime mode does not match the pinned adapter. Check the installation.',
  'support.issue.platform': 'This installation cannot run on the current desktop platform.',
  'support.issue.prefix-arguments':
    'The prefix arguments are invalid. Select Pi extensions through plugin bindings; DeepSeek Harness requires an empty prefix.',
  'support.issue.native-options':
    'The native options do not match this adapter. OpenCode requires a valid agent name; DeepSeek Harness requires the ACP profile.',
  'support.issue.native-plugins':
    'Activation of selected native plugins is not implemented. Keep the binding as a draft or remove it before starting.',
  'support.issue.protocol':
    'The selected protocol, endpoint, or model cannot be mapped by this adapter.',
  'support.issue.authentication':
    'The authentication strategy or API-key header does not match the selected engine and protocol.',
  'support.issue.secret-reference': 'Select a credential or environment reference.',
  'support.issue.sampling':
    'Sampling parameters cannot be applied on this route. DeepSeek Harness rejects them; Pi supports them on the two OpenAI API routes only.',
  'support.issue.reasoning':
    'The requested reasoning setting is not supported on this route. OpenCode does not map it; DSH supports off, low, high, and max only through its native DeepSeek route, and off on its gateway route.',
  'support.issue.reasoning-conflict': 'Shared reasoning and Pi thinking select different values.',
  'support.issue.thinking-level':
    'Pi thinking must be off, minimal, low, medium, high, xhigh, or max.',
  'support.issue.reserved-header': 'DeepSeek Harness reserves the User-Agent header.',
  'support.issue.native-headers':
    'The native DeepSeek provider route does not accept custom headers through this adapter.',
  'support.issue.empty-prompt': 'The selected prompt mode requires nonempty content.',
  'support.issue.replacement-conflict': 'Only one complete prompt replacement can be applied.',
  'support.issue.mcp-extension':
    'Pi MCP requires an explicitly selected and verified extension. No compatible extension is enabled by this adapter.',
  'support.issue.mcp-transport':
    'Forced legacy SSE is not supported. Select a supported MCP transport.',
  'support.issue.mcp-authentication': 'The DeepSeek Harness adapter does not implement MCP OAuth.',
  'support.issue.universal-approval':
    'Pi cannot guarantee approval for every tool. Select deny or unrestricted; project trust is a separate setting.',
  'support.issue.command-value':
    'An MCP command, argument, or environment value contains an invalid null character.',
} as const
