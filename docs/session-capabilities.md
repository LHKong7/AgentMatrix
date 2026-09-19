# Native capability evidence for captured sessions

The session configuration report includes an expandable **Native capability evidence** table in English and Simplified Chinese. Eighteen narrowly named capabilities have independent mechanism, verification, and current availability. Each row states its verification scope and exposes dated contract, native declaration, or runtime evidence.

This complements the [saved-profile compatibility preview](engine-capabilities.md). A draft passing static validation never inherits another session's runtime evidence. A successful configuration readback does not establish model service acceptance, complete Prompt application, MCP connectivity, or universal policy enforcement.

## Native observations

ACP initialization negotiates protocol support and advertises optional methods. Advertising a method is distinct from successfully invoking it. The OpenCode adapter records the restoration route it actually selects: `session/resume`, fallback `session/load`, or unavailable. DSH records its required `session/resume` route. The receipt includes only the fixed protocol version, restoration route, and whether the acknowledged attachment actually restored a previous native identity; raw initialization objects, authentication methods, and arbitrary metadata are excluded. [ACP initialization](https://agentclientprotocol.com/protocol/v1/initialization).

Pi has a separate RPC contract. Its observation is produced after `get_state`/`get_commands` validation; successful `switch_session` with matching session identity marks restoration. No ACP-style advertisement is invented for Pi. A new Pi session therefore has unknown restoration availability until restoration is observed. This does not disable the existing explicit Resume operation, which performs native checks. [Pi RPC documentation](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/rpc.md).

The coordinator saves these optional, strictly validated observations in the durable `run.ready` event alongside existing native check identifiers and credential revision metadata. Projection rejects protocol/mode mismatch and a restoration receipt inconsistent with start versus resume. A failed Ready write cannot publish the observation. Legacy journals remain readable without these fields and receive no inferred protocol/restoration evidence from Ready state alone.

## Evidence mapping

| Capability                   | Evidence used                                                               | Scope and limits                                                                                                                                |
| ---------------------------- | --------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| Installed version            | `cli.version`                                                               | Version at attachment, not continuous binary monitoring.                                                                                        |
| Session connection           | Acknowledged native protocol receipt                                        | ACP or Pi session connection, not a provider call.                                                                                              |
| Native restoration           | Native method declaration and successful restoration receipt, kept separate | An ACP declaration can mean available but unverified. Only a successful restore verifies use.                                                   |
| Selected model               | OpenCode config plus ACP selection; Pi state; DSH ACP selection             | Selected native model, not service acceptance.                                                                                                  |
| Connection mapping           | OpenCode config, Pi state, DSH composition                                  | Native configuration readback. DSH dumps do not activate provider components.                                                                   |
| Secret resolution            | Complete matching launch-reference observations                             | Values resolved for this process; vault rotation and deletion are reported separately.                                                          |
| Model service                | No automatic promotion                                                      | Remains unverified; extension-handled turns and Ready state cannot establish provider acceptance.                                               |
| Sampling mapping             | Explicit OpenCode values with config readback                               | Pi generated settings have no equivalent readback here; DSH sampling is unsupported.                                                            |
| Reasoning selection          | Pi state or native DeepSeek ACP option                                      | DSH generic provider route remains distinct. No claim about internal model behavior.                                                            |
| Prompt mapping / application | OpenCode config or DSH composition for mapping only                         | Application remains unknown; Pi state is not Prompt readback.                                                                                   |
| Skill mapping / discovery    | OpenCode/DSH configuration; Pi Skill command discovery                      | Only Pi's command list verifies discovery. No invocation claim.                                                                                 |
| MCP mapping / connectivity   | Native mapping checks; optional OpenCode MCP status receipt                 | [OpenCode status at attachment](opencode-mcp-status.md) can verify selected connections. DSH remains unknown; Pi requires a verified extension. |
| Selected plugin activation   | Existing instance-specific adapter activation checks                        | Selected startup/instance checks, not every hook or complete dependency coverage.                                                               |
| Policy mapping / enforcement | OpenCode config or DSH composition for mapping only                         | Universal enforcement remains unverified, and Pi universal approval remains unsupported.                                                        |

Unused optional inputs do not acquire verification merely because an engine returned other checks. Missing checks, partial conjunctions, and foreign-engine checks cannot verify a row. Unsupported mechanisms and missing extensions stay distinct from unknown availability. No startup error is guessed to be a field-specific failed verification; the existing session failure appears separately, with prior successful observations retained as historical.

## Identity and lifecycle

Reports bind evidence to the captured manifest digest, installation/version/mode, adapter contract, Agent profile, connection/protocol/model route, application session, native session, and process run. Runtime descriptors use the manifest digest as their `profileDigest`; static previews use their separate resolved-draft digest. These identity domains are not interchangeable.

Only a matching current adapter contract and an active attachment (`ready`, `running`, `waiting`, or `cancelling`) can have currently available verified rows. Interruption, failure, close, and a pending new resume preserve recorded verification but remove current availability. A successful resume creates fresh evidence for a different process run while retaining the same native conversation identity. A changed adapter contract prevents promotion of historical checks. The identity predicate rejects another snapshot, route, process, native conversation, or installation.

Availability describes the report's observed attachment state. It is not continuous process monitoring or authorization to bypass coordinator/adapter checks; callers must fetch a current report. Editing the shared library does not reconfigure a running process, so its old captured capabilities remain scoped to that process. A new session gets a new capture and fresh startup validation. Reports neither execute CLIs nor resolve secrets. They omit executable paths, endpoint paths, headers, Prompt contents, secret references and raw native protocol payloads from the capability descriptors.

## Verification

Unit tests cover all three engines, exact and partial evidence combinations, ACP declaration versus invocation, Pi's separate restore route, unsupported optional features, separate DSH reasoning routes, legacy journals, mismatched identities/contracts, privacy, bilingual labels, and invalid restoration receipts. Journal tests verify restart and replacement on successful resume; coordinator tests verify failed Ready persistence does not publish success.

The extended `scripts/session-smoke.mjs` runs real installed CLIs through the desktop factory, coordinator, journal, IPC and report UI. It checks all eighteen rows, selected plugin activation, captured identity, unavailable historical observations, unverified service/enforcement claims, and a newly verified restoration after restarting Electron. The existing tools, permissions, cancellation, history/export, shared edits, and per-session working-directory flows remain part of the same fixture. See [desktop commands](desktop-sessions.md); `AGENT_MATRIX_CAPABILITY_SCREENSHOT` saves English and Chinese capability-table screenshots.

This implements attachment-scoped aggregation for the current native observations. It does not add new provider, Prompt execution, OAuth, DSH MCP observations, every plugin hook, continuous native-policy monitoring, or cross-platform probes. Those unresolved verification scopes remain explicit; A8 and the delivery gates are not marked complete solely by this report.

Recorded macOS arm64 desktop runs on 2026-09-19 all passed against local synthetic providers: [OpenCode 1.18.16](probes/2026-09-19-session-capabilities-opencode.json), [Pi 0.85.1](probes/2026-09-19-session-capabilities-pi.json), and [DSH 0.1.5-rc.2](probes/2026-09-19-session-capabilities-dsh.json). The DSH desktop fixture exercises its generic Pi-AI route; route-specific native DeepSeek reasoning aggregation is covered by unit evidence mapping, not a new native DeepSeek capability-table run. English and Chinese table screenshots were inspected for readable layout.

ESLint, TypeScript, the production build, all 654 unit tests across 47 files (two workers), and changed-file formatting passed.

[OpenCode MCP connection receipts](opencode-mcp-status.md) now add per-service native status at attachment. All selected services must be connected for a passing capability; explicit unavailable states fail it and unobserved states remain unknown. Historical availability stays unknown. These records establish neither tool execution nor continuing connectivity.
