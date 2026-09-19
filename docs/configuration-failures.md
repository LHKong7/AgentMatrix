# Configuration failure diagnostics

Configuration failures now retain a structured, localizable diagnostic through the runtime, durable session journal, current conversation, history, and Configuration report. The diagnostic identifies the failed check and, when known, affected shared configuration fields. It does not copy native values, dynamic object keys, file contents, command output, or raw exceptions.

## Recorded checks

| Check                    | Current classification                                                                                                                              |
| ------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| Captured inputs          | Integrity failure; field attribution unknown                                                                                                        |
| External sources         | A source, executable, working directory, or observed directory inventory changed or could not be verified; field attribution unknown                |
| Installation             | CLI or protocol identity/version mismatch                                                                                                           |
| OpenCode configuration   | Mismatched requested fields grouped as connection, authentication, model, sampling, execution, engine options, Prompts, Skills, MCP, or plugins     |
| OpenCode session         | Selected model or native Agent mismatch; missing selectors are unavailable                                                                          |
| OpenCode Skill preflight | A selected Skill has no unique matching captured source in the separate native readback process; unreadable output is unavailable                   |
| Pi state                 | Provider/API/endpoint, model, thinking, or required idle/compaction state mismatch                                                                  |
| Pi Skills                | Captured Skill names/source paths differ from native discovery, or another command shadows a selected Skill; missing source metadata is unavailable |
| Pi controls              | Managed native control files changed or became unavailable                                                                                          |
| DSH composition          | The native dump differs from the captured composition, or cannot be parsed; no guessed component attribution                                        |
| DSH session              | Provider/model route or reasoning mismatch; unreadable selectors are unavailable                                                                    |
| DSH controls             | Managed profile/control files changed or became unavailable                                                                                         |

OpenCode still permits added native defaults and extra instruction sources while checking the captured requirements. Its diagnostic traversal classifies mismatches by structural position rather than splitting user-supplied names into field paths. Header names and values are omitted; request-header mismatches identify the connection/authentication groups. Equivalent tool-policy normalization is allowed only under native Agent permissions, not under provider headers that happen to be named `permission`.

Reasons distinguish **mismatch**, **unavailable**, and **changed**. A missing or unreadable result is not presented as an observed conflicting value. The diagnostic is intentionally narrower than a complete configuration diff: native source precedence and the winning external file remain unknown unless a separate feature establishes them. Other runtime errors and older journals may have no detailed diagnostic.

## Ownership and recovery

The session failure schema adds optional `configuration` metadata with fixed enums and a bounded, unique field list. It is valid only for the `configuration` failure code. Runtime failures validate this metadata; the coordinator validates it again and drops malformed payloads. Raw runtime `field` strings and error messages remain excluded from failure receipts. Earlier journals require no migration.

The diagnostic belongs to the failed event's existing session/run/snapshot identity. It survives application restart and appears in read-only history and JSONL exports. It never replaces the previous successful attachment's checks or changes the captured manifest. A report can show a latest field rejection alongside explicitly historical earlier evidence. A failed first start has no successful native observation.

Beginning a new attachment clears the latest visible failure; any new failure records its own diagnostic. Successful native resume records fresh checks under the new run ID. Prior failure events remain in history. Source changes require restoration of the captured sources or a distinct new session; retry does not silently regenerate inputs or create a replacement native conversation.

The conversation renders diagnostics directly from the session state, so an unreadable snapshot can still expose its integrity failure even when the full Configuration report cannot open. The report itself continues to verify stored inputs before presenting captured values. Reading diagnostic details does not execute the engine or resolve credentials.

## Validation

Unit tests cover safe mismatch classification, simultaneous field failures, malformed native readback, fixed-schema rejection, invalid payload dropping, journal restart, historical evidence, retry clearing, and source/input failure before credential resolution.

The extended `scripts/session-smoke.mjs` uses installed OpenCode 1.18.16, Pi 0.85.1, or DSH 0.1.5-rc.2 with an isolated local provider. After a successful session and app restart, it changes an observed OpenCode resource or a managed Pi/DSH control file. Resume fails without another model call; English/Chinese conversation and report diagnostics match the journal, retain prior native identity and snapshot bytes, survive another app restart, and clear after sources are restored and the same native session resumes.

For OpenCode, the fixture additionally captures a native Markdown Prompt override before starting a new session. Actual native readback rejects the Prompt field; the UI identifies it without showing the native body or inventing a successful observation. The native file remains unchanged. Optional `AGENT_MATRIX_DIAGNOSTIC_SCREENSHOT` captures report views with `.en.png` and `.zh.png`, plus OpenCode `.field.en.png` and `.field.zh.png` views.

These fixtures verify local diagnostics and lifecycle behavior. They do not establish external provider acceptance, all native configuration origins, or other-platform compatibility.

Validated on **2026-09-19, macOS arm64**: **685 unit tests in 48 files**, ESLint, TypeScript, production build, and changed-file formatting passed. Final localized presentation changes also passed the localization and DSH runtime tests. Installed desktop results are recorded separately for [OpenCode](probes/2026-09-19-configuration-failure-opencode.json), [Pi](probes/2026-09-19-configuration-failure-pi.json), and [DSH](probes/2026-09-19-configuration-failure-dsh.json). OpenCode's field-level Prompt mismatch was produced by actual native readback; Pi and DSH field classifiers use contract fixtures, while their desktop failure scenarios exercise actual managed-control validation and native recovery.

DSH `dsh-skills` failures identify the `skills` field group: a different entry/provider/source is a mismatch; incomplete or changing native discovery, missing scope/identity, malformed evidence, or an expired bounded observation is unavailable. The diagnostic never includes native paths, bodies, or error text. The [source observer contract](dsh-skill-sources.md) defines the exact scope.

New OpenCode `opencode-instance-skills` failures identify the `skills` group. Selected-source differences are mismatches; failed authentication, session/directory identity checks, missing or malformed output, and expired observations are unavailable. Legacy `opencode-skills` failures retain their separate-process scope. The [ACP source contract](opencode-skill-sources.md) defines bounds and lifecycle behavior.
