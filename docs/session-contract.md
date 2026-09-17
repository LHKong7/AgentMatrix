# Session contract and lifecycle

The initial runtime shares application commands and state across OpenCode ACP, Pi RPC, and DeepSeek Harness ACP. Their native protocols, capability checks, and permission behavior remain separate. The shared schemas and state projection are implemented in `src/shared/sessions/`; the coordinator, bounded recent-event stream, and durable journal are in `src/main/sessions/`. The coordinator is tested with the production OpenCode and Pi runtimes. The desktop factory, sender-checked Electron IPC, and bilingual session controls now use this path; DSH desktop runtime integration remains open.

## Identity and commands

- A **session** identifies a desktop conversation and its captured configuration, installation, version, cwd, and native runtime mode.
- A **run** identifies one process attachment. Native resume requires a new run ID while preserving the captured configuration and native session identity.
- A **turn** identifies one submitted message. At most one turn is active per session.
- An **interaction request** identifies one pending permission or extension dialog within a turn. Native request IDs are mapped inside adapters; the renderer receives an application request ID.
- A **command ID** identifies a UI operation. The coordinator stores a receipt before its side effect and deduplicates retries within that session, including after restart.

Commands cover create, start, send, respond, cancel, resume, and close. Create accepts a saved agent ID and optional cwd, not an executable or arbitrary process arguments. Responses include the session, run, turn, and request IDs. Choices must match options actually offered by the request; expired, settled, cancelled, or foreign requests reject later responses. Permission choices and Pi-style input/select/confirm dialogs have distinct schemas and typed runtime responses. Pi editor dialogs use multiline input with an optional initial value; the UI retains that value unless the user edits it.

The state validator checks addresses and lifecycle. The runtime must additionally check the selected engine's verified capabilities, configuration, credentials, and native-session compatibility. Exposing a permission request type does not establish that Pi can enforce approval for all tools.

## Lifecycle and cancellation

New sessions begin in `created`, transition through `starting`, and become `ready` only after the adapter supplies a native session ID. A submitted turn becomes `running`; pending interactions produce `waiting`. Settling the last interaction returns to `running`.

Cancellation immediately invalidates pending interaction controls and enters `cancelling`. The turn remains active until the adapter confirms a terminal result. Late streamed chunks can still be recorded; they do not make the session ready or authorize another tool. Native completion and stop reason determine the final result. Unknown usage and cost remain `null`.

The coordinator gives native cancellation five seconds by default. If no terminal result arrives, it stops the owned attachment and records interruption with a timeout after cleanup succeeds. It does not invent a successful native cancellation. Closing during startup waits for the in-flight connection to settle and disposes a late runtime without publishing `ready`. A failed cleanup cannot produce `closed` or permit a replacement attachment; an explicit close retry can retry cleanup. The adapter factory must honor abort and own cleanup for failed connections.

Process loss clears pending interactions, ends an active turn as interrupted/failed, and preserves the last native session identity. Resume is a separate operation: a new attachment must restore that identity and pass native compatibility checks. A new native conversation cannot masquerade as resume. Closing invalidates interactions; only confirmed shutdown produces the terminal `closed` state.

## Events and renderer reconnection

Events carry a monotonically increasing session cursor and the relevant run/turn IDs. The projection ignores overlapping replay deliveries, rejects cursor gaps, and rejects new events from stale attachments or turns. Message deltas, tool updates, native notices, interactions, turn results, and process transitions use bounded, validated payloads. Interaction responses are not copied into the event journal.

Usage may include `scope: turn` or `scope: session`; absent scope in older records means unspecified and must not be assumed to be per-turn usage. OpenCode ACP reports cumulative session totals; the Pi adapter sums final assistant-message usage within the turn and leaves missing or zero-filled provider usage unknown. Tool updates may include `contentTruncated` so capped native content is not displayed as complete. Both fields are optional to preserve existing journal compatibility.

`SessionEventStream` retains a bounded recent window for fast reattachment and paginated reads. Replay capture and subscriber registration happen synchronously. Delivery occurs asynchronously in cursor order, with independent payload copies. Slow subscribers and expired cursors receive `reset-required`; they must fetch a current snapshot and durable history. The buffer does not silently remove part of a transcript and present it as complete.

Subscriptions belong to a trusted frame identity assigned by the main process. Unsubscribing one owner cannot affect another owner; navigation/destruction must remove all subscriptions for that frame. The preload must register its listener before invoking subscribe. These checks are implemented by the main-process IPC bridge and preload. Navigation rotates frame ownership; a subscription that finishes registering after navigation is removed before returning. The renderer subscribes before reading a snapshot and paginated history, ignores duplicate cursors, and fetches history again on a gap. Its visible transcript is capped at 1,000 events / approximately 4 MiB with an explicit truncation notice; full history remains in the journal.

A failed durable write or detected external history edit stops the attachment, cancels pending permissions, and sends `unavailable` with a static storage failure to subscribers. This invalidates controls without inventing a persisted transition. The affected coordinator context rejects further operations; restart re-reads the preserved journal and performs normal interruption recovery. An invalid history cursor is a query error and does not stop the runtime.

## Command receipts and coordination

Each accepted state-changing command stores `{ id, digest }` in the same durable record as its first transition. Creation stores its receipt in the initial snapshot and derives a stable session ID from the creation command ID. The digest covers a canonical encoding of the validated command; response contents are not copied into the journal. Old records without receipts remain readable. Reusing a command ID with different input is rejected. Retrying an accepted command returns the current snapshot without repeating its effect, even if the original process was subsequently interrupted.

This prevents automatic replay of accepted work; it is not an exactly-once guarantee for an external provider. A crash after persisting intent and before submitting it can leave an interrupted turn that never reached the engine. Recovery does not resubmit it. A new turn or explicit native resume is a separate user operation.

The coordinator serializes decisions per session while native connection and turn work run outside the decision queue. One waiting permission does not prevent cancel/close or work in another session. Interaction resolution is flushed before the typed response is returned to the adapter. Expired, aborted, cancelled, or old-run callbacks cannot authorize a later request. Known launch secrets are redacted from journaled user messages using the runtime's in-memory filter; the original message is submitted to the native engine. Arbitrary user text and engine-owned native persistence are not automatically classified as secret.

`shutdown()` rejects new commands, aborts and disposes owned attachments, and records resumable interruptions. Electron invokes it on quit, including closure of the final window on macOS. Shutdown also aborts installation probes and stops every owned process, including failed-start/readback handles. Unconfirmed cleanup prevents quit, shows a localized error, and permits a later cleanup retry. Native resume receives the original snapshot/native ID and a new run ID. An adapter returning a different native ID fails and is disposed.

## Durable history and restart recovery

`SessionJournal` stores a versioned initial snapshot and LF-delimited events in one file per session. Creation publishes a complete private file without replacing existing history. Appends validate the transition and expected cursor, write a complete record, and sync it before advancing the in-memory projection. The coordinator publishes an event to the live stream only after the journal accepts it. Receipt lookup is rebuilt from these records on restart; duplicate persisted receipts are corruption, not additional accepted commands. A failed append must not appear successful in the UI or authorize a new side effect.

The journal serializes reads and writes and captures append inputs before queuing. It rejects stale writers and detects changes to files already opened by this application process. This is a single-process store, not a cross-process locking protocol. Live external edits are unsupported. Journal files use mode `0600`; symlinks and multiply linked files are rejected on the tested macOS host.

On restart, unfinished process attachments receive a persisted `run.interrupted` event. Pending controls are invalidated, an unfinished turn is marked interrupted, and the original snapshot/native session identity is retained. This does not launch a CLI or establish native resumability. Already interrupted, failed, closed, and not-yet-started sessions are not repeatedly rewritten.

A torn final frame is copied byte-for-byte to a content-addressed `.partial` backup before truncation to the last complete LF boundary. The backup publication and directory are synced before repair returns. An existing conflicting backup prevents repair. Malformed complete records, invalid UTF-8, unknown formats, duplicate/gapped cursors, and invalid transitions fail without resetting history. The loader does not replace damaged text or skip an invalid completed record.

Durable reads paginate the full transcript independently of the recent-event buffer. Records are bounded to 1 MiB and a journal defaults to 256 MiB, with reserved space for terminal events and restart recovery. Hitting the limit rejects additional content and preserves existing history. Native resume and recent history are exposed in the desktop UI. Full transcript export, retention controls, and browsing beyond the visible history cap remain later work; automatic deletion is not implemented.

Adapters must redact secrets before producing diagnostics or event content. The strict event schema rejects unknown fields but is not a secret detector. Native output and user text remain untrusted display content. Lifecycle, buffering, and actual temporary-file restart tests are contract/storage evidence, not actual model-call or engine acceptance evidence. Filesystem recovery was tested on macOS; other platforms still require their own verification.
