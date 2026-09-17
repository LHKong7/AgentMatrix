# Session contract and lifecycle

The initial runtime shares application commands and state across OpenCode ACP, Pi RPC, and DeepSeek Harness ACP. Their native protocols, capability checks, and permission behavior remain separate. The shared schemas and state projection are implemented in `src/shared/sessions/`; the bounded recent-event stream and durable journal are in `src/main/sessions/`. The OpenCode runtime adapter emits shared turn payloads, but session coordination and Electron IPC are not connected yet.

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

Usage may include `scope: turn` or `scope: session`; absent scope in older records means unspecified and must not be assumed to be per-turn usage. ACP reports cumulative session totals. Tool updates may include `contentTruncated` so capped native content is not displayed as complete. Both fields are optional to preserve existing journal compatibility.

`SessionEventStream` retains a bounded recent window for fast reattachment and paginated reads. Replay capture and subscriber registration happen synchronously. Delivery occurs asynchronously in cursor order, with independent payload copies. Slow subscribers and expired cursors receive `reset-required`; they must fetch a current snapshot and durable history. The buffer does not silently remove part of a transcript and present it as complete.

Subscriptions belong to a trusted frame identity assigned by the main process. Unsubscribing one owner cannot affect another owner; navigation/destruction must remove all subscriptions for that frame. The preload must register its listener before invoking subscribe. Main-process sender verification, IPC wiring, command deduplication, and adapter integration remain required before the session API is exposed to the renderer.

## Durable history and restart recovery

`SessionJournal` stores a versioned initial snapshot and LF-delimited events in one file per session. Creation publishes a complete private file without replacing existing history. Appends validate the transition and expected cursor, write a complete record, and sync it before advancing the in-memory projection. The coordinator must publish an event to the live stream only after the journal accepts it. A failed append must not appear successful in the UI or authorize a new side effect.

The journal serializes reads and writes and captures append inputs before queuing. It rejects stale writers and detects changes to files already opened by this application process. This is a single-process store, not a cross-process locking protocol. Live external edits are unsupported. Journal files use mode `0600`; symlinks and multiply linked files are rejected on the tested macOS host.

On restart, unfinished process attachments receive a persisted `run.interrupted` event. Pending controls are invalidated, an unfinished turn is marked interrupted, and the original snapshot/native session identity is retained. This does not launch a CLI or establish native resumability. Already interrupted, failed, closed, and not-yet-started sessions are not repeatedly rewritten.

A torn final frame is copied byte-for-byte to a content-addressed `.partial` backup before truncation to the last complete LF boundary. The backup publication and directory are synced before repair returns. An existing conflicting backup prevents repair. Malformed complete records, invalid UTF-8, unknown formats, duplicate/gapped cursors, and invalid transitions fail without resetting history. The loader does not replace damaged text or skip an invalid completed record.

Durable reads paginate the full transcript independently of the recent-event buffer. Records are bounded to 1 MiB and a journal defaults to 256 MiB, with reserved space for terminal events and restart recovery. Hitting the limit rejects additional content and preserves existing history. Transcript retention/export UI and native process recovery remain later runtime work; automatic deletion is not implemented.

Adapters must redact secrets before producing diagnostics or event content. The strict event schema rejects unknown fields but is not a secret detector. Native output and user text remain untrusted display content. Lifecycle, buffering, and actual temporary-file restart tests are contract/storage evidence, not actual model-call or engine acceptance evidence. Filesystem recovery was tested on macOS; other platforms still require their own verification.
