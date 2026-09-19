# Session configuration reports

Each desktop conversation now has a **Configuration report** in English and Chinese. It separates immutable captured inputs, recorded native checks, and the current saved profile. Viewing it does not start a CLI, resolve credentials, apply edits, or change the original snapshot.

## Evidence and persistence

After an adapter finishes its startup checks, it returns an allowlisted set of check identifiers. The coordinator writes those identifiers into the same durable `run.ready` event that acknowledges the native session. State projection binds them to the process run ID, native conversation ID, snapshot digest, and event timestamp. The immutable run manifest is not rewritten.

On restart, evidence remains visible as historical. Starting a resume does not promote old checks to evidence for a new process. Only a successful native acknowledgment replaces the last observation. Old journals without this optional data remain readable and show no recorded checks. Reports reject a mismatched snapshot or native identity.

The report reads and verifies the saved manifest and captured files, then compares them with the current workspace resolution. External-source hashes shown in the report describe captured observations; viewing the report does not recheck the installed CLI or scan native configuration. Startup/resume still performs its separate source and native validation.

| Field / engine                                                                                         | Recorded evidence                                | Limits                                                                                                                          |
| ------------------------------------------------------------------------------------------------------ | ------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------- |
| Installed release                                                                                      | Explicit native version command                  | Historical attachment evidence; no continuous executable monitoring                                                             |
| OpenCode model                                                                                         | Native config readback plus ACP selected model   | The native provider alias must match the captured underlying model configuration                                                |
| OpenCode connection, authentication, requested sampling, Prompt/Skill/MCP wiring, policy configuration | `debug config` using the captured launch context | Separate native process; no claim of model service acceptance, resource invocation, MCP connectivity, or OS sandbox enforcement |
| OpenCode agent selection                                                                               | ACP session options                              | Verifies the selected agent                                                                                                     |
| Pi route, endpoint, model, thinking                                                                    | RPC `get_state`                                  | Does not establish API-key acceptance, complete Prompt loading, or universal tool approval                                      |
| Pi Skills                                                                                              | RPC `get_commands`                               | Verifies discovered Skill command names, not invocation                                                                         |
| DSH provider/model and native reasoning                                                                | ACP session options                              | Preserves DSH's separate provider routes                                                                                        |
| DSH connection, authentication references, Prompt/Skill/MCP wiring, policy and profile composition     | Exact native configuration dump                  | Labeled **composition matched; application unknown** because the dump does not activate plugins                                 |
| Missing readback                                                                                       | None                                             | Explicitly unknown; generated files or Ready state are not substituted as proof                                                 |

For selected OpenCode ESM plugins, `opencode.plugins` records initializer and config-hook completion in the instance acknowledged by ACP. It is checked on new sessions and resume; read-only file inspection cannot supply it. Complete dependency capture and arbitrary hook behavior remain outside this observation. See [activation checks](opencode-plugin-activation.md).

For selected Pi extensions, `pi.plugins` checks native witness registration and current-session factory/startup receipts on launch, turns, and resume. It does not verify every extension feature or complete dependency provenance. See [Pi activation checks](pi-plugin-activation.md).

For selected DSH modules, `dsh.plugins` records native boot completion and fresh observations of active row/fiber identities, captured configuration, owned process, and current native session. Checks repeat around turns and on resume. This evidence is separate from `dsh.composition`, whose dump does not activate modules; it does not prove arbitrary hooks or complete dependency provenance. See [DSH activation checks](dsh-plugin-activation.md).

Unset sampling defaults and unsupported reasoning readback remain unknown. The report presents the captured request and the scope of its native checks; it is not an assertion that every field is applied or continuously unchanged. Failures/interruption remain visible alongside historical evidence.

The expandable [Native capability evidence](session-capabilities.md) table aggregates eighteen precise scopes with independent mechanism, verification, and availability. It distinguishes native restoration declarations from successful restoration, ties observations to the exact captured configuration/process/native conversation, and removes current availability after interruption. Model service acceptance, full Prompt application, MCP connectivity and universal enforcement are not inferred from native config readback. Saved-profile compatibility remains a separate static assessment.

## Saved changes and assets

Reports compare executable installation identity, connection/authentication references and headers, model and parameter choices, requested execution policy, native options, resolved Prompt/Skill revisions and sources, MCP definitions, and native plugin references. Descriptive agent/connection names and a refreshed probe timestamp alone do not create pending changes.

Each captured asset lists its version, direct/bundle binding source, application mode where relevant, captured target, and digest. It also shows the current next-session binding and library latest version. Fixed revisions remain fixed when a library's latest version advances; direct bindings override shadowed bundle bindings. Removed assets, unresolved profiles, and deleted profiles do not destroy the old capture.

Pending configuration-binding changes require a new session and native adapter validation. Reading a report or resuming a conversation never applies them to old inputs. Library editors now offer a separate [impact preview](library-impact.md) of affected profiles and retained conversations before saving. Selected native configuration import is implemented for the three engines; full per-field external override provenance and complete runtime capability reporting remain open.

The separate **Credential revisions** table compares each captured vault reference's last successful attachment revision with current metadata. Replacing its stored value leaves active process inputs unchanged; start and resume resolve its current value again. Deleted, legacy/unverified, unavailable, and environment references have distinct states. Revision observations persist with `run.ready`; failed attachments keep historical evidence. See [credential lifecycle and verification](credential-rotation.md).

## Data boundaries and validation

The sender-checked `sessions.configuration` IPC accepts only a validated session ID. The renderer cannot supply a path or native command. The main process projects an explicit set of metadata: raw native config, Prompt/Skill contents, headers, environment values, CLI arguments, secret values, and credential references are omitted. Endpoint display retains only the origin, removing user information, paths, queries, and fragments. Credential comparison uses random stored-version identifiers, revision numbers, and timestamps without decrypting values; identifiers are omitted from the report response. It compares stored revisions, not plaintext equality or environment-value changes.

Native checks are a bounded, unique enum list rather than raw native output. Existing journal and process ownership rules apply: a failed durable Ready write cannot publish successful evidence. Application history remains the source of truth for observation ownership; no provider fixture result is silently promoted into evidence for a user's conversation.

Unit tests cover legacy journals, absent readback, DSH composition versus runtime evidence, Pi authentication limits, fixed/latest revisions, direct-over-bundle resolution, drafts/removal, immutable captures, metadata-only changes, sensitive-field omission, identity mismatch, journal restart, and evidence replacement on resume. Factory and IPC tests verify report reads without secret resolution and rejection of untrusted senders.

The extended `scripts/session-smoke.mjs` checks each installed engine's report in English and Chinese, pending old/new Prompt versions, persisted observations after application restart, and a new observation after native resume. Use the commands in [desktop sessions](desktop-sessions.md). `AGENT_MATRIX_REPORT_SCREENSHOT` optionally captures the report, with a separate `.zh.png` image for Chinese. All model requests in these fixtures use isolated local providers and synthetic credentials.

Recorded desktop results: [OpenCode](probes/2026-09-18-configuration-report-opencode.json), [Pi](probes/2026-09-18-configuration-report-pi.json), and [DSH](probes/2026-09-18-configuration-report-dsh.json). The installed DSH runtime fixture additionally asserts report evidence for both the generic and native DeepSeek routes, including their different reasoning readback.

The [combined three-engine desktop fixture](shared-asset-acceptance.md) now checks captured, next-session, and library versions for the same shared Prompt and directory Skill in English and Chinese, including reports during old/new session use and historical/fresh observations after native restoration.
