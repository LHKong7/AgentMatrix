# One setup for every CLI agent, one configuration per agent

Instructions, Skills and tools describe _what_ an assistant should do, and they read the same on
OpenCode, Pi or DeepSeek Harness. The engine, the model route, the endpoint and the credential
describe _how_ a particular agent reaches a provider, and those differ per CLI and per project.
AgentMatrix therefore splits the two.

| Shared once, in **Shared setup**                                   | Kept on each agent                                                               |
| ------------------------------------------------------------------ | -------------------------------------------------------------------------------- |
| System prompts (with their version selection and instruction mode) | Which CLI agent runs it (engine installation)                                    |
| Skills                                                             | Model profile, and through it the connection: protocol, API endpoint, credential |
| Tools — MCP servers                                                | Working directory                                                                |
| Resource bundles                                                   | Requested execution policy and timeout                                           |
|                                                                    | Engine-specific options and native plugin bindings                               |

## How it resolves

`workspace.sharedSetup` holds the shared bindings plus `excludedAgentIds`. When an agent resolves
(`resolveAgentProfile`), the shared entries join the ones from its bundles, and the agent's own
bindings take precedence for the same asset — the existing bundle rule, extended to the shared
setup. Resolved prompts and Skills carry `source: 'shared'`, so a session's configuration report
still shows where each instruction came from.

An agent listed in `excludedAgentIds` inherits nothing and runs on its own bindings only. Its
engine, model and endpoint are unaffected either way: the shared setup never contains them, and it
never makes a connection available to a CLI — that is a separate, explicit
[grant](provider-connections.md).

Deleting a prompt, Skill, MCP server, bundle or agent clears the matching reference from the shared
setup, exactly as it does for agents and bundles, so the workspace stays valid.

## In the interface

- **Shared setup** (sidebar) edits the four shared groups, lists the agents that use them, and
  states in one card what stays per agent.
- An agent's **Bindings** tab opens with _Inherited from the shared setup_ — a count, the names, and
  a reminder that a binding below replaces an inherited one for the same resource — followed by
  _This agent only_. An excluded agent sees that instead.
- An agent's **General** tab keeps the per-agent part: engine, model profile, working directory and
  execution policy, with the engine requirements checklist for the model route.

## Boundaries

Saved changes apply to new sessions. A running or saved conversation keeps the configuration it
captured when it started, so editing the shared setup never rewrites history. The shared setup is
intent: whether an engine can actually apply a prompt mode, a Skill or an MCP transport is still
decided by that engine's adapter rules and the startup checks.

## Verification

`tests/shared-setup.test.ts` covers inheritance by every agent, per-agent engine/model/endpoint
staying separate, an agent binding replacing an inherited one, opting out and back in, reference
cleanup on removal, rejection of a shared reference to something that does not exist, and a newly
created agent inheriting without extra setup.
