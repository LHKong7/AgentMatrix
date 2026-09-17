# Pi runtime and desktop sessions

The production adapter connects **Pi 0.85.1 over RPC** to the shared session coordinator and bilingual desktop UI. Installed-engine and Electron fixtures pass on macOS arm64 using a local Chat Completions provider with synthetic credentials. This is local integration evidence; external provider acceptance, complete configuration application reporting, and other platforms remain open.

## Turn boundaries and events

Pi acknowledges a `prompt` before the model run completes. The adapter waits for `agent_settled`; `agent_end` alone can precede retry or compaction. The pinned adapter disables automatic retries and compaction through RPC, because project settings can override generated global defaults. Unexpected queued continuations are rejected rather than attributed to a new desktop command.

Assistant text and reasoning use separate application message IDs. Streaming deltas and authoritative final content are reconciled without duplicating output. Native tool IDs map to application IDs; tools must start before updates and finish before successful settlement. Tool content has a visible truncation marker. Known launch secrets are redacted before publication, including secrets split across text deltas. Unknown event contracts fail explicitly. Retry, compaction, extension, and unsupported-content notices retain a bounded, redacted native event name without copying redundant native history.

The final assistant stop reason remains visible. Provider errors after prompt acceptance produce a failed turn while allowing the verified idle conversation to accept a later message. Input usage includes cache reads/writes; native output usage already includes reasoning. Missing or all-zero provider usage remains unknown, and custom-model cost is not invented from Pi's default zero price. Totals are calculated from final assistant messages only, avoiding duplicate `turn_end` and `agent_end` payloads.

## Interactions and cancellation

The shared runtime contract carries typed permission, selection, confirmation, and text-input responses. The coordinator persists interaction resolution before returning a response to the native adapter. Response text stays out of the event journal. Opaque option IDs map back to the exact native choice, including duplicate or redacted labels. Editor requests preserve their initial text; a prefill containing a known launch secret is rejected instead of silently substituting masked text.

Pi cancellation invalidates pending dialogs, waits for prompt acceptance, clears native queued messages, and sends `abort`. The coordinator waits for terminal output or confirmed process cleanup. Cancelling during preflight does not submit the prompt. A turn deadline closes a nonresponsive attachment; the existing coordinator also escalates stalled cancellation. Neither an acknowledgement nor a button click is recorded as proof that native work stopped.

These dialog mappings do not establish universal tool approvals. The current saved-profile adapter disables unselected extensions and rejects native plugin bindings, MCP bindings, and the shared `ask` execution policy. It accepts explicit no-tools or unrestricted-tool policies, with project trust configured separately. Registered extension slash commands are blocked because they may acknowledge without starting a model turn or may switch native sessions. Broader extension activation requires its own contract and acceptance evidence.

## Native persistence

Each captured run input owns a separate mutable Pi home and session directory. A private `pi-session.json` reference records the native UUID, session filename, and immutable input digest. It is created once and never overwritten by a retry. Resume verifies the reference, native session header, working directory, and input digest before `switch_session`, then checks the returned native identity and effective model/Skill settings. A replaced, missing, malformed, oversized, or symlinked reference/session fails explicitly. Native history is read by Pi; the application does not resubmit earlier messages to reconstruct it.

Pi may defer creating its native session file until a model turn writes history. An empty newly created conversation is therefore not guaranteed to resume. Failed restoration preserves the application history and does not create a replacement conversation. Known-secret redaction applies to AgentMatrix journals and UI, not to Pi's engine-owned transcript files.

## Verification

```sh
AGENT_MATRIX_TEST_PI=/absolute/path/to/pi \
AGENT_MATRIX_PI_RUNTIME_REPORT=/absolute/path/to/runtime-report.json \
npx vitest run --config vitest.pi.config.ts tests/pi-runtime-installed.probe.ts

AGENT_MATRIX_SESSION_ENGINE=pi \
AGENT_MATRIX_TEST_PI=/absolute/path/to/pi \
AGENT_MATRIX_SESSION_REPORT=/absolute/path/to/desktop-report.json \
npm run test:sessions
```

The [runtime record](probes/2026-09-18-pi-runtime.json) verifies normalized streaming/tools, Unicode, split-key redaction, durable command replay, cancellation, coordinator restart, native restoration with retained file-tool context, post-acceptance provider failure, and unchanged captured inputs. Unit tests cover malformed events, final-content reconciliation, interaction reply types and cancellation, unknown usage, and native reference corruption.

The [desktop record](probes/2026-09-18-pi-desktop-sessions.json) verifies explicit installation checking, saved-profile launch, tools, escaped output, renderer reload without resubmission, cancellation, shared-Prompt edits across old/new sessions, app quit/restart, native resume, confirmed close, and English/Chinese controls. Pi's unsupported universal permission actions are recorded as unsupported. The [configuration fixture](pi-configuration.md) separately exercises directory Skills and their reference files. See the [native RPC contract](https://github.com/earendil-works/pi/blob/v0.85.1/packages/coding-agent/docs/rpc.md) and [transport notes](pi-rpc.md) for the pinned protocol.
