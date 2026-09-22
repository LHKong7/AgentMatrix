export const sharedSetupEn = {
  'nav.sharedSetup': 'Shared setup',
  'sharedSetup.eyebrow': 'EVERY CLI AGENT',
  'sharedSetup.description':
    'System prompt, Skills and tools are configured once here and apply to every CLI agent. Engine, model route, endpoint and credentials stay on each agent, because those differ per CLI and per project.',
  'sharedSetup.prompts': 'System prompts',
  'sharedSetup.promptsHint':
    'Instructions every agent receives. An agent can still bind the same prompt itself, which replaces the shared binding for that prompt.',
  'sharedSetup.skills': 'Skills',
  'sharedSetup.skillsHint': 'Reusable knowledge every agent can load.',
  'sharedSetup.tools': 'Tools · MCP servers',
  'sharedSetup.toolsHint': 'Tool servers every agent may connect to, subject to its own policy.',
  'sharedSetup.bundles': 'Resource bundles',
  'sharedSetup.save': 'Save shared setup',
  'sharedSetup.applies': 'Applied to {count} of {total} agents',
  'sharedSetup.participants': 'Agents using this setup',
  'sharedSetup.participantHint':
    'Clear an agent to keep it on its own bindings only. Its engine, model and endpoint are unaffected either way.',
  'sharedSetup.noAgents': 'No agent configurations yet.',
  'sharedSetup.personal': 'Stays per agent',
  'sharedSetup.personalHint':
    'Which CLI agent runs, the model route it calls, the API endpoint and credential, the working directory and the execution policy are set on the agent itself.',
  'sharedSetup.inherited': 'Inherited from the shared setup',
  'sharedSetup.inheritedHint':
    'These already apply to this agent. The bindings below are the agent’s own and replace an inherited entry for the same resource.',
  'sharedSetup.inheritedEmpty': 'The shared setup has no prompts, Skills or tools yet.',
  'sharedSetup.excluded':
    'This agent is excluded from the shared setup and uses only its own bindings.',
  'sharedSetup.own': 'This agent only',
  'sharedSetup.boundary':
    'Saved changes apply to new sessions. Existing conversations keep the configuration they captured.',
  'sharedSetup.count': '{prompts} prompts · {skills} Skills · {tools} tools · {bundles} bundles',
} as const
