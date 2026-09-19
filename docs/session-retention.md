# Session retention and deletion

Sessions keep their immutable captured inputs and writable native state until the user explicitly deletes a closed conversation. Closing stops the owned attachment and preserves history for inspection/export. It does not delete files. Interrupted or failed conversations must be closed before deletion; a failed or unfinished process cleanup cannot pass that check.

## Desktop workflow

1. Export history first if a copy is needed. The JSONL export is a record of application history, not an importable native-session backup.
2. Close the conversation and wait for **Closed**.
3. Choose **Delete conversation** and confirm. Cancelling changes nothing.

English and Simplified Chinese controls explain the affected data. Deletion removes the journal and its exact torn-frame backups. It also removes `userData/runs/<snapshotId>/`, including frozen inputs and mutable native state, when no retained conversation references that snapshot. An existing reference preserves the entire capture, regardless of whether the referencing conversation is closed or still usable.

Shared Prompt/Skill definitions and captured library revisions, credentials, native import archives, project files, external native configuration, and exported history copies are retained. No age-based expiry or automatic bulk purge is enabled. Native data written outside the adapter-owned run directory is outside this deletion scope.

## Coordination and recovery

The renderer sends only a session ID and the exact durable cursor it reviewed. The trusted main process validates both, requires `closed`, and refuses deletion while that session still has a runtime attachment. Session creation, capture publication, and removal share a catalog queue. Journal scans and mutations share the journal queue. This prevents creation from publishing a new reference between the reference scan and cleanup. The desktop factory verifies or materializes its capture before publishing a new session.

An unreadable retained journal blocks cleanup; it is never treated as evidence that a snapshot has no references. Run removal accepts a validated opaque ID, rejects symlinked run roots, and does not traverse symlinks within native state. Filesystem operations assume the application's existing single-writer model; this is not a defense against concurrent arbitrary modification by another process with the same user's permissions.

Before removing content, the journal atomically publishes and flushes `.deleting-<sessionId>.json`. Its bounded record contains only a version, session ID, snapshot ID, and expected cursor. A pending receipt hides the conversation and rejects access and command replay. Cleanup then removes the unreferenced capture and transcript files and renames the receipt to `.deleted-<sessionId>.json`, flushing the directory. Completed receipts remain indefinitely so a retry of an old deterministic create command cannot recreate the deleted conversation. They contain no messages, native conversation IDs, credentials, cwd, or configuration values.

A failed cleanup remains pending, including after partial run-directory removal. The desktop exposes **Retry cleanup** for already confirmed deletions and retries them at startup after opening the window. Each attempt rescans retained references; missing owned paths are safe to retry. Failures before the durable receipt preserve the conversation. Corrupt receipts or retained journals produce a storage error instead of guessing which content may be removed. A crash after transcript unlink but before receipt completion is recoverable from the pending receipt alone.

Deletion is filesystem removal, not secure erasure. Backups, exported copies, external engine storage, and operating-system snapshots are unaffected. A separate [unused-run-data workflow](unused-run-data.md) now reviews unassociated captures and abandoned staging directories. It requires explicit confirmation, fresh reference checks, and valid ownership/integrity evidence. Those entries are retained until selected for cleanup; incomplete confirmed removals can be retried after restart.

## Verification

Unit tests cover closed-state and cursor checks, incomplete/failed process cleanup, shared captures, concurrent creation, corrupt journals, strict IPC ownership, receipt validation, symlink boundaries, exact torn-frame backup removal, idempotent retries, crash recovery, and rejected create replay.

The extended desktop fixture uses installed CLIs with a local synthetic provider. It deletes a synthetic history journal sharing a real native capture, checks that the original is preserved, deletes another closed native conversation and its run directory, and verifies both confirmation languages and cancellation. A deliberately symlinked run root forces a pending cleanup without traversing the project. After restoring the original directory and restarting, the application finishes the previously confirmed deletion. Project files, shared workspace data, and the exported history remain unchanged; deletion makes no model calls.

The macOS arm64 fixture passed for [OpenCode 1.18.16](probes/2026-09-19-session-retention-opencode.json), [Pi 0.85.1](probes/2026-09-19-session-retention-pi.json), and [DeepSeek Harness 0.1.5-rc.2](probes/2026-09-19-session-retention-dsh.json). Pi and DSH also exercise the explicit cleanup retry button. The suite contains 696 passing tests across 49 files; lint, TypeScript, and the production build pass. These checks do not establish external-provider acceptance, secure erasure, complete native data-location coverage, or Windows/Linux acceptance.
