# Session history browsing and export

**Session history** opens a read-only view of the application's durable event journal. It works for OpenCode, Pi, and DeepSeek Harness conversations, including closed conversations. Browser preview has no desktop journal or export access.

## Browse a conversation

The live conversation still retains at most 1,000 recent events / approximately 4 MiB in renderer memory. The history view reads bounded pages from the entire saved journal instead. **Beginning**, **Earlier**, **Later**, and **End of selection** navigate that view; the displayed cursor range identifies the included records. **Include latest events** explicitly updates the selected endpoint. New native events do not shift the current page or silently change the export boundary.

Pages can begin or end inside a message or turn. Within a page, text fragments are combined by attachment, turn, message ID, and channel. Assistant and reasoning text stay separate. Tool updates show the latest state on that page; export retains each original update. Lifecycle events and historical interaction requests are shown without response controls. Current responses and cancellation remain in the live conversation. Reading history never starts or resumes a native CLI or resubmits a message.

The main process accepts a session ID, inclusive `throughCursor` and `fromCursor`, a forward/backward direction, and an optional limit. Pages contain up to 200 events (100 by default), bounded to 1 MiB of serialized event data. The existing journal record limit ensures a single event also fits. Events are returned in ascending cursor order in either direction. Invalid ranges are rejected; malformed or externally changed storage is handled through the existing fail-closed session path. Sender checks match the live session API. Command receipts are omitted from historical IPC output.

## Export the selected history

History remains available after closing a conversation. Explicit [conversation deletion](session-retention.md) removes stored history and, when unreferenced, its captured inputs and native state. Exported copies are preserved.

**Export history (JSONL)** opens the native Save dialog. The export includes all events from cursor 1 through the view's selected endpoint, regardless of which page is visible. Cancelling the dialog creates no file. Export uses a single sequential journal pass, with bounded buffers and batched writes; it does not assemble an entire conversation in the renderer or repeatedly scan one page at a time. The pass is serialized with journal appends to keep the selected prefix consistent.

The UTF-8 JSON Lines format contains:

1. A `session-history` record with format `agentmatrix-session-history`, version `1`, export time, the inclusive endpoint, and basic session identity: local session/profile/installation IDs, engine version, mode, cwd, and creation time.
2. One `event` record per cursor, preserving timestamp, attachment/turn identity, and normalized event data. Text remains in its original fragments. Tool truncation flags, native stop reasons, optional usage, failures, and interaction settlement events remain explicit.

The export preserves the journal's existing redaction and omits command receipts, configuration snapshots, resolved credentials, and native engine transcript files. Interaction response bodies were never journaled and cannot be exported. The application's redaction guarantee covers known injected credentials; this is an export of stored conversation content, not a new content-classification or redaction pass.

Only the main-process Save dialog selects the destination; the renderer cannot supply a filesystem path. Output is staged beside the chosen file with owner-only POSIX permissions, flushed, and atomically renamed after successful reading. Failed exports clean up staged output and preserve the previous destination. Existing directories, symlinks, hard-linked files, changed destinations, and paths inside AgentMatrix's application data directory are rejected. The exporter does not modify session history or native state.

JSONL export is an archival format, not a native-engine import or cross-engine session migration format. Reopening the history view after renderer reload reads the same durable records; it does not replay them into an agent.

## Verification

Unit tests cover forward/backward cursor coverage, newly appended events outside a selected boundary, empty histories, invalid ranges without interrupting a healthy session, UTF-8 byte limits, message/channel identity, sender checks, exact exported prefixes, omitted receipts, preserved stored redaction, failed reads, concurrent destination edits, app-data protection, and symlink/file boundaries.

The desktop session fixture additionally exercises real native history while OpenCode/DSH permissions are waiting, or after Pi completes its turn. A separate closed journal extends a native fixture conversation with 1,005 explicitly synthetic message fragments to exceed the live renderer limit. The test navigates every page without gaps, checks both languages, cancels and completes the native Save flow, compares every exported event with the source journal, and reloads without submitting new model calls. The OS Save dialog is substituted; IPC, journal parsing, filesystem export, and UI behavior run unchanged. Set `AGENT_MATRIX_HISTORY_SCREENSHOT` when running the existing [desktop fixture](desktop-sessions.md) to capture English and Chinese history views.

The macOS arm64 runs passed for [OpenCode 1.18.16](probes/2026-09-18-session-history-opencode.json), [Pi 0.85.1](probes/2026-09-18-session-history-pi.json), and [DSH 0.1.5-rc.2](probes/2026-09-18-session-history-dsh.json). They use local synthetic model APIs and do not call external providers.

These checks do not establish external-provider acceptance, cross-platform support, unlimited journal retention, or native transcript completeness. Journal capacity remains bounded, and native adapters retain their documented output and truncation limits.
