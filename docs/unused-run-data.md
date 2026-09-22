# Unused run data and interrupted capture cleanup

The **Unused run data** action on the Sessions page lets the user review and explicitly remove published run snapshots without a retained conversation reference, and staging directories left by interrupted input creation. The workflow is available in English and Simplified Chinese. It completes the initial B2 retention policy alongside [closed-conversation deletion](session-retention.md); it does not pass the external-provider or platform delivery gates.

## Review and removal

The list contains at most 100 items per page. Verified captures show the captured Agent name, installation name, working directory, directory modification time, and an expandable data identifier. Staging entries show their kind, modification time, and identifier. These dates describe the directory, not the last model invocation. The view does not display Prompt/Skill bodies, native transcript content, credentials, request headers, or generated configuration.

Removing an item requires confirmation. Cancelling does not alter files or write an intent. Cleanup deletes only that selected directory under `userData/runs`, including any owned native state beneath it. Shared libraries and Skill captures, credentials, native import archives, retained conversations, project files, external configuration, and exported histories are preserved. Nothing is removed based on age, opening the list, application startup, or a failed creation attempt.

An unreferenced capture must pass the existing manifest and complete input-file integrity checks before it is offered for new removal. Missing or corrupt manifests, linked roots, unknown filenames, and non-directory entries remain preserved, with an explicit skipped-entry notice. Recognition of staging directories requires the exact `.stage-<UUID>` namespace used by the run store. The scan allows at most 100,000 top-level entries; larger stores return a limit error. Subsequent pages can be empty if the remaining candidates are skipped or references changed.

## Reference and filesystem boundaries

Session creation/publication, closed-conversation deletion, discovery, and unused-data removal share the coordinator's catalog queue. Run-store creation and cleanup also share their queue, so in-progress materialization cannot be offered as abandoned staging. Every discovery and removal takes a fresh journal reference scan under the journal queue. Retained conversations, pending conversation-deletion receipts, and in-memory runtime attachments protect their snapshot IDs. Unreadable retained journals or pending receipts block the operation instead of implying zero references.

The renderer supplies only a validated capture/stage identity and an opaque review token. It cannot select an arbitrary filesystem path. Each new deletion verifies the current directory fingerprint and capture integrity against the reviewed token. Changes invalidate the request. The run-store root and selected directory must be ordinary directories. Recursive deletion unlinks inner symlinks rather than traversing their targets. Pending cleanup additionally requires the original directory device/inode, preventing a retry from removing a replacement directory.

These guarantees use the existing application single-writer model and owned runtime registry. They do not provide a cross-process filesystem transaction or protect against arbitrary same-user races outside AgentMatrix. Filesystem removal is not secure erasure; external native storage, backups and OS snapshots remain outside its scope.

## Durable intent and retry

Before deletion, the run store writes and flushes a private receipt, publishes it exclusively as `.unused-deleting-<kind>-<id>.json`, and flushes the parent directory. The bounded receipt contains only its schema version, target kind/ID, review token and directory device/inode. Receipt staging uses the same reviewable UUID namespace. It does not contain cwd, Agent names, native conversation IDs, content or credential values.

After removal, the pending receipt is renamed to `.unused-deleted-<kind>-<id>.json` and the directory is flushed. Completed receipts remain so retries are idempotent and an old deterministic create request cannot regenerate an explicitly removed capture from a newer library revision. Creating a genuinely new conversation uses a new request ID and a different capture ID.

An incomplete deletion remains visible as **Retry removal**, including after application restart or partial directory removal. This retry uses the already confirmed intent and requires no second confirmation. It rechecks references and directory identity. A missing original directory can complete the receipt; a linked or replaced root stays pending. Unknown/corrupt receipts stop cleanup. If publication or flushing fails, the UI reports failure and a refresh determines whether the intent exists. Power-loss durability beyond the filesystem's flush/rename behavior is not claimed.

No background retry is added for unused data. This differs from already confirmed closed-conversation deletions, whose existing startup retry remains unchanged. Unassociated valid captures can instead remain indefinitely for a retry of the original creation request. Cleanup never reconstructs a missing conversation or silently regenerates its snapshot. Corrupt or unrecognized data needs separate inspection rather than automatic deletion.

## Validation

Unit tests exercise reference protection, capture verification, stale tokens, source-content changes, deletion replay, missing/partial/replaced-directory recovery, malformed receipts, root and nested symlinks, bounded pagination, creation/catalog serialization, active attachments with a missing journal path, shutdown, and IPC sender ownership. The tests force a real cleanup failure through a controlled filesystem mock before reconstructing the store and retrying.

The Electron fixture creates a capture through the production session API without starting its engine, restarts without that capture's journal to represent interrupted publication, and adds a partial stage. It verifies both confirmation languages and cancellation, removal of the stage, native project-link preservation, retained conversation exclusion, metadata-only review, and old-create replay rejection. It seeds a previously confirmed receipt at the crash boundary, substitutes the root with a project link, verifies safe rejection, restores the original directory, and completes cleanup through the retry control. Shared workspace/project data remain unchanged and cleanup sends no model requests.

Validation on **2026-09-19, macOS arm64** passed **748 unit tests across 52 files** with two workers, ESLint, TypeScript, the production build, and the complete OpenCode/Pi/DSH Electron session fixtures. The final English and Chinese review screenshots were inspected.

Run the fixture with the commands in [desktop sessions](desktop-sessions.md); `AGENT_MATRIX_UNUSED_RUN_SCREENSHOT` writes `.en.png` and `.zh.png` review images. Native fixtures use isolated local synthetic providers. Recorded results: [OpenCode](probes/2026-09-19-unused-run-data-opencode.json), [Pi](probes/2026-09-19-unused-run-data-pi.json), and [DSH](probes/2026-09-19-unused-run-data-dsh.json). Other operating systems and external providers remain unverified.
