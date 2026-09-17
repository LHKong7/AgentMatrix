# Session contract and lifecycle

The initial runtime shares application commands and state across OpenCode ACP, Pi RPC, and DeepSeek Harness ACP. Their native protocols, capability checks, and permission behavior remain separate. The shared schemas and state projection are implemented in `src/shared/sessions/`; the bounded recent-event stream is in `src/main/sessions/event-stream.ts`. These modules are not yet connected to Electron IPC or production CLI adapters.

## Identity and commands

- A **session** identifies a desktop conversation and its captured configuration, installation, version, cwd, and native runtime mode.
- A **run** identifies one process attachment. Native resume requires a new run ID while preserving the captured configuration and native session identity.
- A **turn** identifies one submitted message. At most one turn is active per session.
- An **interaction request** identifies one pending permission or extension dialog within a turn. Native request IDs are mapped inside adapters; the renderer receives an application request ID.
- A **command ID** identifies a UI operation. The future coordinator must deduplicate commands before side effects; schema validation alone does not provide exactly-once execution.

Commands cover create, start, send, respond, cancel, resume, and close. Create accepts a saved agent ID and optional cwd, not an executable or arbitrary process arguments. Responses include the session, run, turn, and request IDs. Choices must match options actually offered by the request; expired, settled, cancelled, or foreign requests reject later responses. Permission choices and Pi-style input/select/confirm dialogs have distinct schemas.

The state validator checks addresses and lifecycle. The runtime must additionally check the selected engine's verified capabilities, configuration, credentials, and native-session compatibility. Exposing a permission request type does not establish that Pi can enforce approval for all tools.

## Lifecycle and cancellation

New sessions begin in `created`, transition through `starting`, and become `ready` only after the adapter supplies a native session ID. A submitted turn becomes `running`; pending interactions produce `waiting`. Settling the last interaction returns to `running`.

Cancellation immediately invalidates pending interaction controls and enters `cancelling`. The turn remains active until the adapter confirms a terminal result. Late streamed chunks can still be recorded; they do not make the session ready or authorize another tool. Native completion and stop reason determine the final result. Unknown usage and cost remain `null`.

Process loss clears pending interactions, ends an active turn as interrupted/failed, and preserves the last native session identity. Resume is a separate operation: a new attachment must restore that identity and pass native compatibility checks. A new native conversation cannot masquerade as resume. Closing invalidates interactions; only confirmed shutdown produces the terminal `closed` state.

## Events and renderer reconnection

Events carry a monotonically increasing session cursor and the relevant run/turn IDs. The projection ignores overlapping replay deliveries, rejects cursor gaps, and rejects new events from stale attachments or turns. Message deltas, tool updates, interactions, turn results, and process transitions use bounded, validated payloads. Interaction responses are not copied into the event journal.

`SessionEventStream` retains a bounded recent window for fast reattachment and paginated reads. Replay capture and subscriber registration happen synchronously. Delivery occurs asynchronously in cursor order, with independent payload copies. Slow subscribers and expired cursors receive `reset-required`; they must fetch a current snapshot and durable history. The buffer does not silently remove part of a transcript and present it as complete.

Subscriptions belong to a trusted frame identity assigned by the main process. Unsubscribing one owner cannot affect another owner; navigation/destruction must remove all subscriptions for that frame. The preload must register its listener before invoking subscribe. Main-process sender verification, IPC wiring, durable history, command deduplication, and adapter integration remain required before the session API is exposed to the renderer.

Adapters must redact secrets before producing diagnostics or event content. The strict event schema rejects unknown fields but is not a secret detector. Native output and user text remain untrusted display content. These lifecycle and buffering tests are contract evidence, not actual model-call or engine acceptance evidence.
