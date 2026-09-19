# Skill directory capture

The desktop Skill editor supports importing a directory alongside the existing inline Markdown type. Import opens a native folder chooser, copies its regular files into private app storage, and returns a manifest. Saving the editor attaches that capture to the asset. Canceling the chooser leaves the draft unchanged. No script, tool, extension, or agent is executed by importing.

## Content and revisions

The root must contain a nonempty UTF-8 `SKILL.md`. Its bytes, including frontmatter, are preserved without YAML parsing or rewriting. Other files may contain arbitrary bytes. Hidden files are included; there are no implicit ignore rules. Empty directories are omitted. Captures preserve relative paths, per-file SHA-256 digests, byte lengths, and executable flags. The directory digest hashes a deterministic, path-sorted JSON file manifest, so timestamps and absolute source locations do not affect identity.

A new asset starts at revision 1. Importing changed content into an existing asset appends a revision and retains all previous revisions. Reimporting the currently selected content does not create a duplicate revision. Different assets may reference the same captured bytes. A saved latest/pinned binding keeps its existing selection semantics.

The asset's editable `sourcePath` is a convenience/provenance field, not a live filesystem binding or a complete per-version source history. Captured bytes and digests identify the actual content. Editing or deleting the original directory after import does not change a capture. Frontmatter validation, native Skill discovery, and conflicts between native Skill names remain engine adapter work; duplicate library display names do not merge assets.

## File boundaries

- Import only the selected directory's regular files and folders. Reject a selected symlink, nested symlinks, and special files. Leaf reads use no-follow/nonblocking flags where supported and check file identity before and after reading.
- Reject traversal components, nonportable names, and path collisions after Unicode normalization and case folding. Case-colliding directory names are rejected as well as file names.
- Limit an import to 1,000 files, 20,000,000 bytes per file, 100,000,000 bytes total, 32 directory levels, and 2,000 total entries including directories. Reads remain bounded if a source grows during copying.
- Re-scan paths and file identities before publication. Concurrent source changes fail the import and remove its staging directory. This detects ordinary editing races; it is not an OS filesystem sandbox against another process with the same user's permissions.
- Reject importing the capture store itself or a directory containing it.

The native chooser is the only path input to the renderer-facing API. Sender-checked IPC returns a source path and manifest, without exposing an arbitrary path-reading method. Browser preview cannot import directories.

## Storage and integrity

Captures live under `userData/assets/skills/<digest>/`, with `manifest.json` and a `files/` tree. The service serializes imports, writes private staged files, syncs their contents, and publishes a completed directory by rename. Equal captures reuse verified existing storage. Missing, modified, or conflicting captures are reported and preserved instead of repaired in place.

Workspace saves verify new directory revisions before publishing their references. Existing workspace records remain editable if their stored capture later goes missing; every future run materialization must call the integrity verifier again and copy its own run inputs. Captures are not writable native runtime directories. The importer alone does not prove that an engine will load a Skill.

Captures remain after discarding an imported draft or deleting its library asset. There is no automatic garbage collection yet, because future session snapshots must retain referenced content. Completed operations remove their own staging directories; crash leftovers and reference-aware retention remain lifecycle work. Directory publication protects against partial imports during ordinary process interruption; full power-loss durability and Windows/Linux behavior require separate platform acceptance.

## Verification

Filesystem tests exercise byte preservation, frontmatter, binary and hidden files, executable flags, deduplication, source deletion, symlink boundaries, path validation, size/count/depth limits, source changes, write failures, corrupt captures, and workspace revision publication. Real Electron smoke tests cover chooser cancellation, import preview, reimport, old-version preservation, and restart after deleting the original source. The test substitutes the OS chooser's response while exercising the production IPC and capture code.

The [combined shared-asset fixture](shared-asset-acceptance.md) verifies one imported directory Skill across OpenCode, Pi, and DSH in the desktop app. Reimport advances the shared library once; existing and new native sessions read their respective entry/reference versions, including after the source is edited or deleted and conversations are restored.
