# Credential revisions and session attachments

Session configuration reports now compare the encrypted credential revision resolved for the last successful native attachment with its current stored revision. The English and Chinese table groups repeated uses of one reference into a single numbered row and identifies model authentication, model headers, MCP authentication, MCP headers, and MCP environment uses. It does not display secret values, credential IDs, environment names, or value fingerprints.

## Lifecycle

Run manifests retain credential references, not values. A successful start or native resume records which stored revision was resolved immediately before launch. Replacing a vault entry does not change an already running process's injected inputs. A new session or successful resume resolves the current value of each captured reference, while retaining the original Prompt, Skill, model, endpoint, and other captured configuration.

| Report state          | Meaning                                                                                                       |
| --------------------- | ------------------------------------------------------------------------------------------------------------- |
| Matching revision     | The current entry matches the last successful attachment's stored version.                                    |
| Changed revision      | The stored entry was replaced; a future attachment resolves its then-current value.                           |
| Missing credential    | The captured reference has been deleted; a new attachment cannot resolve it.                                  |
| Unverified            | The session or legacy vault entry lacks comparable version evidence.                                          |
| Environment reference | Explicit environment values are resolved at attachment time, but their values and rotations are not compared. |
| Unavailable           | Metadata or the secure storage backend is unavailable; comparison remains unknown.                            |

Open the report again or use Reload for a fresh metadata comparison. The displayed check time describes that read, not continuous monitoring. Closed or interrupted sessions retain historical attachment evidence. A failed resume preserves the prior successful observation; only a durable new `run.ready` event replaces it. Missing credentials block attachment rather than silently selecting a different key.

An attachment revision identifies the input resolved by AgentMatrix. It does not prove that a model service accepted the credential, that a native plugin used it, or that arbitrary native code continued using it. Configuration-binding changes remain in the report's separate pending-new-session comparison. Changing a connection's reference and replacing the value behind an existing reference have different effects on resume.

## Storage and evidence

Every successful credential write receives a random version UUID alongside its existing revision and update time. This identifier is independent of the plaintext. Saving the same value again also creates a new stored revision; the report makes no claim about plaintext equality. Deleting and recreating the same credential ID receives a fresh UUID even if its numeric revision starts at one again. Backend ciphertext rewrapping preserves the stored version identity.

The vault returns plaintext and version metadata in the same serialized operation. A replacement queued during decryption cannot associate the old plaintext with the new revision. The launch tracker deduplicates references, accepts only captured references, and requires complete resolution. More than 256 distinct references fail before launch. Plaintext remains in the in-memory launch/redaction path; new desktop captures also retain encrypted [masking history](credential-redaction-history.md) so old keys echoed after native resume remain redacted. Those copies never supply authentication and are removed with their capture.

Successful runtime connection returns bounded metadata using stable per-manifest integer slots. The coordinator journals it with the native Ready acknowledgment, bound to the process run ID, native session ID, and original snapshot digest. A failed Ready write disposes the runtime without publishing success. No immutable manifest is rewritten. Journals contain version UUIDs, revision numbers and timestamps, but no credential reference names or values in the observation. The configuration-report response strips UUIDs as well. Exported journal events retain the same metadata-only observation.

Vault metadata reads neither decrypt entries nor resolve environment variables. Legacy entries acquire a UUID only during explicit secret resolution, preserving their existing revision and update time. Merely opening a report leaves old vault bytes untouched. Existing journals without observations remain readable. An environment reference records its source and resolution time without a value hash; each attachment uses the desktop process's available environment, so changing a separate shell does not update an already running desktop app.

## Verification

Unit coverage includes serialized replacement races, deletion and same-ID recreation, legacy migration, ciphertext rewrapping, environment privacy, deduplicated launch uses, report projection, bounded observations, journal restart/resume, and failed durable Ready writes. Factory tests check report reads without secret resolution or workspace writes.

The opt-in desktop fixture uses real installed OpenCode, Pi, and DSH executables, OS-backed credential encryption, isolated home/project/data directories, and a synthetic local Chat Completions provider. It checks the bearer key and a secret header against actual native requests through these phases:

1. Start one conversation per engine with revision one.
2. Replace the shared credential and verify active processes still send the first key while reports show revision two pending for attachment.
3. Open English and Chinese reports after renderer reload; verify a separate environment reference remains uncomparable.
4. Start new conversations using revision two.
5. Restart Electron and resume the original native conversations with revision two, preserving native session IDs and recording fresh process observations.
6. Delete the credential, verify already attached processes retain their injected key, then restart and verify new resume attempts fail without replacing historical evidence.
7. Compare original manifest bytes and scan application-owned configuration/journal files for synthetic plaintext secrets.

```bash
AGENT_MATRIX_TEST_OPENCODE=/absolute/path/to/opencode \
AGENT_MATRIX_TEST_PI=/absolute/path/to/pi \
AGENT_MATRIX_TEST_DSH=/absolute/path/to/dsh \
npm run test:credential-rotation
```

Set `AGENT_MATRIX_ROTATION_SCREENSHOT` to an absolute filename prefix for `.en.png` and `.zh.png` captures. Native mutable state is outside the application-owned storage scan. The fixture uses DSH's generic Pi-AI route; it does not establish credential rotation on its separate native DeepSeek route, remote MCP/OAuth, arbitrary plugins, external providers, or other platforms. Full B6/X3 and delivery-gate acceptance remain separate.

The [2026-09-19 macOS arm64 run](probes/2026-09-19-credential-rotation-desktop.json) passed all phases with 15 primary model requests using OpenCode 1.18.16, Pi 0.85.1, and DSH 0.1.5-rc.2. Both report languages were inspected in real Electron screenshots. The full 637-test unit suite, ESLint, TypeScript, and production build also passed.

The later [retired-key regression](credential-redaction-history.md) extends this fixture with native credential echoes, restored-history masking, JSONL exports and encrypted-history cleanup. The original record above predates that regression and does not establish its outcome.
