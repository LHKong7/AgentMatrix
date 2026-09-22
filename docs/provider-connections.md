# One connection, granted to each CLI separately

A connection describes a provider: where its endpoint is, how it authenticates, and — once it is
known — who it belongs to. It is set up once for the whole workspace. Being set up is not the same
as being usable: each CLI is handed a connection only after that grant is given explicitly, and
nothing about the connection itself gives it.

## The three records

| Record                | What it says                                                                                          | Where it lives             |
| --------------------- | ----------------------------------------------------------------------------------------------------- | -------------------------- |
| Provider identity     | Who the endpoint and credential belong to: vendor, product, region, account, and what the base URL is | `provider` on a connection |
| Engine grant          | That one installation may use one connection, over one route, through one adapter                     | `engineBindings`           |
| Verification evidence | What has actually been observed about an engine, connection, grant or agent, and under which state    | `evidence`                 |

The identity matters because the endpoint does not identify a provider. Two vendors can speak the
same protocol, and one vendor can need a different key per product, so `openai-chat-completions` at
some base URL is not an identity — `minimax`, its account and its region are.

## Granting a connection to a CLI

`bindConnectionToEngine` records the grant. It refuses a second grant for the same pair, a route
the CLI has no adapter for, and a route other than the one the connection states, because binding
another route to a connection would silently send its credential to a different API.

A grant covers one route. Repointing the connection afterwards — `openai-chat-completions` to
`anthropic-messages`, say — is a request to a different API with the same credential, so the grant
stops covering it and `resolveAgentProfile` reports `engine-binding-route` until it is given again.
Removing the engine or the connection withdraws the grant with it.

## What each CLI means by an agent

`agentConfigurationDefinitions` describes an agent per CLI rather than offering one form to all
three: which engine options must be chosen, which execution policies the CLI maps, whether tool
servers reach it directly, and which reasoning values exist. Pi has no per-request approval prompt,
so `ask` is offered as a choice to make, never quietly downgraded to something Pi can run.
`tests/agent-definition.test.ts` checks every row against `engineConfigurationIssues`, so the
description cannot drift from what a session will accept.

## Adopting what a CLI already has

Reading a provider out of a CLI's own configuration goes through three stages, and only the last
one writes anything:

1. **Discover** — read the selected native files, unchanged, and report what is there.
2. **Interpret** — map native values to workspace records with an explicit pointer per mapping and
   a diagnostic for anything not converted.
3. **Adopt** — write credentials, records, the grant and the evidence in one transaction, keeping
   the exact source bytes encrypted alongside.

Adoption names the provider from the key the CLI files it under, records the file it was read from,
and grants the adopting installation that connection: its own configuration is what establishes it
already uses the provider. A connection whose route the adapter could not identify is adopted
without a grant. No other CLI is granted anything, and the native files are never modified.

## Evidence

Each observation is filed against the fingerprint of the subject as it stood, in one of five
states that cost progressively more to obtain:

`discovered` → `configuration-valid` → `connection-tested` → `session-ready` → `model-response`

A stronger observation covers the weaker states it necessarily passed through. A weaker one never
becomes a stronger one: finding a CLI on disk is not a validated configuration, and a validated
configuration is not a tested credential. When the subject changes — a rotated key, a new endpoint,
a different adapter — the record stops applying and is reported as changed rather than carried
over. The interface says exactly what was observed: _found, not verified_ until something actually
called the endpoint.

Each state is filed by whatever actually establishes it. Adoption files `discovered`. Preparing a
session files `configuration-valid` once the adapter has accepted the values, against the agent and
the grant it runs on. The session's own durable events file the rest: `run.ready` is a session that
started, and the first assistant message is a provider that answered, so they file `session-ready`
and `model-response`. A session started from a per-launch working directory, or resumed by a
process that never prepared it, files nothing — the observation would be about a configuration
other than the saved one. Filing never advances the workspace revision, because nobody edited
anything. Only this application files observations: a saved document is a statement of intent, so
the store keeps the records it made and ignores any the document carries — what a save can do is
remove the subject, and a record about something that no longer exists goes with it.

## In the interface

The sidebar reads as the workspace is used: **Conversations**, **My agents**, **Engines** —
installed CLIs, the connections each may use, model routes and native plugins — and **Library**,
which holds what is shared across every CLI.

- **Engines** lists, per installed CLI, every connection with the route it was granted for, the
  provider key it carries in that CLI's own configuration, what has been observed, and an action to
  make it available or withdraw it. A grant given for a route the connection has since left is
  named as such, with the option to give it again.
- **Connections** shows how many CLIs each connection is available to, what has been observed about
  it, and carries the provider identity fields.
- An agent's **General** tab asks in the order the choice is made: the CLI, then a connection —
  marked where it is not available to that CLI, with the grant offered inline — then a model on
  that connection, then where it runs. Switching the agent to another CLI marks the same connection
  unavailable again, because the grant is per CLI. The execution policy names a value the CLI does
  not map instead of quietly offering something else.

## Boundaries

A grant is authorization, not proof. It says this CLI may be handed this connection; whether the
provider accepts the request is still decided when a session starts, and the session's
configuration report remains the record of what was actually used. The identity is descriptive:
AgentMatrix does not contact a vendor to confirm it.

## Verification

`tests/engine-bindings.test.ts` covers a connection granted to one CLI and refused to another
that speaks the same protocol, withdrawal with the engine, the connection or the grant, the refusal
of a duplicate or wrong-route grant, an upgraded workspace receiving exactly the pairs its agents
already used, the one-route rule, and the evidence rules — no promotion, retirement on change, one
record per subject and kind, and separate observation of a grant and its engine.
`tests/native-adoption.test.ts` covers naming the provider, recording the source, granting the
adopting CLI alone, and adopting an unidentified route without a grant. `tests/digest.test.ts`
checks the fingerprint digest against `node:crypto`.
