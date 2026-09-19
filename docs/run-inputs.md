# Run input snapshots

`RunInputStore` captures a resolved configuration for a future CLI launch. It is used by the production desktop session factory for OpenCode, Pi, and DSH. A successful capture proves that the planned files were published and can be verified, not that an engine accepted or applied them.

## Captured inputs and mutable state

```text
userData/runs/<snapshotId>/
  manifest.json         # Versioned launch plan and content digest
  redactions.enc        # OS-encrypted masking history for new desktop captures
  inputs/               # Copied prompts, complete Skill files, generated native configuration
  state/                # Writable native sessions, cache, and other adapter-selected directories
```

The first process attachment may use its run ID as the snapshot ID. A resumed attachment receives a new run ID but references the previous snapshot ID and digest; it must not regenerate that snapshot from the current library. Generating new inputs creates a distinct run and is not native resume.

`create` resolves the workspace before its first asynchronous operation. Direct/bundle selection, pinned/latest revisions, requested policy, model connection, and model parameters are therefore independent of subsequent editor changes. Directory Skills are verified and copied with their relative paths, binary bytes, and executable flags. Existing snapshots remain readable after their library assets, import captures, or original source directories disappear.

The manifest records the workspace revision, resolved asset versions and provenance, engine installation/version, canonical executable path and SHA-256, canonical cwd, adapter contract version, and the launch plan. Its digest covers canonical JSON with sorted object keys, excluding the digest itself. Input-file hashes, sizes, and executable flags are covered by that digest. The mutable `state` tree is outside the digest.

The adapter returns validated generated files, prompt-file and Skill-directory mappings, launch arguments, environment references, and native-source observations. Every selected asset must have exactly one mapping. Environment entries distinguish ordinary literals, captured input files/directories, mutable state directories, and secret references. Input references must point to materialized content. Credentials are resolved later in memory by the runtime; this store never reads provider environment values or decrypts the vault.

Secret environment entries can specify `json-string` encoding for engines that interpolate before parsing JSON; omission preserves raw encoding. `prepareRunLaunch` performs that encoding after resolving the reference in memory, retaining both forms for diagnostic redaction. This optional manifest-v1 field does not add secret values to the persisted document.

New desktop captures also require [encrypted masking history](credential-redaction-history.md), identified by the optional `redactionHistoryVersion` marker. It retains known keys across attachments without putting plaintext into captured inputs or reusing retired values for authentication. The mutable encrypted file is removed with its capture; legacy digests and their narrower masking scope remain unchanged.

Adapters must keep credentials out of literal fields, arguments, and generated file contents. This component cannot identify a secret pasted into ordinary prompt text or a native configuration string. It also does not attest provider compatibility, prompt semantics, Skill discovery, plugin execution, or effective permissions.

## Publication and verification

Creation uses private staging directories, exclusive writes, flushed files, and a same-directory rename after all inputs and the manifest are ready. The store serializes creation operations and rejects an existing destination, including an empty or corrupt one. Normal failures remove only their own staging directory. Existing snapshots are never repaired or overwritten.

Paths reject traversal, symlinks, special files, reserved filenames, case/Unicode-normalization ambiguity, and file/directory collisions. Limits are 4,096 files, 20 MB per file, 256 MiB of input bytes, 64 path components, 16,384 filesystem entries, and a 16 MiB manifest. Executable and observed-source hashing uses 128 KiB chunks with a 512 MiB per-file limit. Reads detect content changes during hashing. Windows and Linux behavior still require platform acceptance.

`read` validates the manifest and verifies the complete listed input file set, hashes, sizes, and executable flags. Corrupt snapshots remain available for diagnosis. `verifyForReuse` also checks the platform, current executable path/content, canonical cwd, observed external sources, and declared mutable-state directory paths. Missing or redirected state directories cannot be silently recreated for resume.

Snapshots are logically immutable copies, not OS write-protected files or a sandbox. Checks do not prevent a separate process from changing files after verification. The store assumes the desktop application's single writer and does not provide cross-process transactions or protection against malicious same-user filesystem races. File flushes and rename do not claim full power-loss durability.

## External sources and resume boundaries

An adapter can observe an existing native file by its selected/canonical path, hash, and size, or record its absence. Observations are rechecked before publication and reuse; newly appearing files count as changes. Native file contents are not copied into manifests because they can contain credentials. Coverage is explicitly `partial` or `complete`, as determined by the adapter's discovery evidence.

Observing one executable does not freeze its interpreter, imported packages, downloaded plugins, remote configuration, or project files. Adapters must identify relevant dependencies and precedence sources, or retain partial coverage. Symlinks selected for an external source are resolved and recorded; symlinks inside captured inputs are rejected.

Passing reuse verification is only one prerequisite for resume. The session coordinator must additionally validate the adapter contract, probe the installed engine version, resolve current credential references, check native persistence and protocol capability, and obtain the engine's resume acknowledgment. Unknown source coverage and unsupported effective-config readback must remain visible as limitations. A failed check must not silently create a replacement conversation.

OpenCode now also captures optional [native Markdown directory inventories](native-resource-sources.md). Re-enumeration before publication and reuse detects newly discovered Agent, Mode, and Command files, as well as removed, changed, or redirected sources. These observations contain metadata only. Legacy manifests keep their original digest and coverage without inventing missing inventories; Pi and DSH keep their separate source contracts.

Selected plugins in all three adapters now add optional [dependency source observations](plugin-dependency-sources.md): explicit relative modules, package scopes and absence, plus per-plugin unresolved categories. These metadata references contribute to the manifest digest and existing external-source checks. Module bodies remain on disk rather than being copied into captured inputs. Legacy manifests without the optional field retain their original digest and narrower coverage. Native activation receipts remain a separate check.

## Retention

Published snapshots and native state are retained together until explicit [deletion of a closed conversation](session-retention.md), or explicit [unused-data cleanup](unused-run-data.md) when no conversation references the capture. The coordinator checks every retained session reference and completes process cleanup before releasing an unreferenced capture through `RunInputStore.remove`. Pending deletion receipts allow safe retry after partial cleanup or application restart. No age-based garbage collection is enabled. Normal failed staging directories are removed. The unused-data review can explicitly remove recognized abandoned stages and integrity-verified unassociated captures after fresh reference checks. Pending receipts support retry, and completed receipts prevent old creation requests from regenerating deleted inputs. Unknown, corrupt, or linked entries remain preserved for separate inspection.

Tests cover revision freezing, state isolation, complete Skill copies independent of source retention, credential references, tampered/missing/extra inputs, symlinks, publication conflicts, unsafe paths, byte limits, incomplete adapter plans, source changes during preparation, and reuse checks. These filesystem tests use a synthetic executable file and make no provider calls.
