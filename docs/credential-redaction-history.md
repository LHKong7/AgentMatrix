# Credential masking across native resumes

A native conversation can retain an earlier model response containing a key. After credential rotation and application restart, the model can repeat that old text. Previously, the output redactor knew only the new attachment's resolved keys, so an old key could enter the application journal. The local installed OpenCode fixture reproduced this failure before the fix.

New desktop captures retain encrypted, capture-specific masking history. Startup and native resume load both earlier and current values before launching subprocesses. Authentication still resolves the current captured credential references; retained values are never fallback credentials. Deleting a vault credential continues to block a later attachment even when its encrypted masking copy exists. This addresses a concrete X3 boundary without completing the full audit or any delivery gate.

## Storage and launch contract

The optional manifest-v1 `redactionHistoryVersion: 1` marker requires a `redactions.enc` file beside `manifest.json`. An empty history is encrypted in the private staging directory before atomic capture publication. Its encrypted payload binds the format, capture ID, capture digest and known values. The production desktop store uses the same OS-backed `SecretCipher` as the vault; an unavailable backend blocks new capture creation without publishing partial inputs.

`prepareRunLaunch` resolves current references, builds the current environment, and merges raw/native-encoded values into the history. It returns merged values solely as redaction inputs. OpenCode additionally retains ephemeral observer authentication forms before starting ACP; its preflight already uses the earlier history. Stderr, journaled user messages, normalized assistant/reasoning/tool output and supported interaction text use the known-value redactors.

Writes use exclusive mode-0600 files, file flushing, same-directory rename and directory flushing. Updates share the run store's creation/removal queue, so concurrent attachments preserve all retained keys. Missing, malformed, undecryptable, linked or wrong-capture files prevent launch and are never reset to empty. Failed encryption preserves the prior file; retries can repeat the merge. Each update re-encrypts the payload, honoring backend rewrapping.

Limits match the redaction budget: 256 distinct raw/native forms, 65,536 characters per value and 1,048,576 total characters. Ciphertext is bounded at 16 MiB; regular-file reads detect changes. Rotations and ephemeral observer credentials can reach the limit, requiring a new conversation. Old values are never evicted silently.

The encrypted file is mutable application data outside the immutable input digest. No plaintext key enters manifests, generated inputs, reports, observations or exports. Reports expose whether the capture requires history, without decrypting it or attesting the file's current health. Failed attachments may retain values resolved before failure without claiming they authenticated a successful request.

## Retention and compatibility

Replacement/deletion of a credential does not remove masking copies. The English/Chinese credential panel explains retention, and reports distinguish marked captures from older inputs. Copies remain while any retained conversation references their capture. Confirmed closed-conversation deletion or unassociated-run cleanup removes them with the capture; shared references preserve them.

Legacy manifests keep their shape and digest and acquire no retroactive history. Their report states that earlier keys can be unrecognized after rotation. Authentication requirements still apply. This change does not rewrite previously leaked records or claim them clean. A new conversation from the saved profile receives the new boundary.

Native transcripts, caches and tool-written files can still contain raw echoed keys; the fixture confirms earlier plaintext in native model context. AgentMatrix does not rewrite native transcripts because that could corrupt restoration. The engine can resend native history to its configured service. Encryption is not a sandbox against native code running as the user. Known-value masking cannot discover unrelated credentials read independently by tools/plugins or every transformation of a key; JSON and URL encodings follow the existing redactor contract. These limitations remain part of the wider audit.

## Verification

Unit tests cover restart, encoded retired keys, current-only environment injection, concurrent merges, capture isolation/deletion, missing/corrupt/linked/special files, wrong identity, encryption failure/retry, backend unavailability, history bounds, legacy digests and observer-persistence failure before ACP spawn.

The Electron fixture uses OpenCode 1.18.16, Pi 0.85.1 and both DSH 0.1.5-rc.2 routes: Pi-AI with `openai-chat-completions` and native DeepSeek with `deepseek-official`. All routes use a local synthetic Chat Completions service and real OS encryption. The native DSH connection shares the vault authentication reference but has no custom headers; the server and reports verify that header references from the other connection do not cross that boundary.

It echoes a synthetic key, rotates the shared credential, restarts Electron and confirms that native model context contains the old echo. A new response repeats both old and current keys. Application history and exported JSONL mask both; provider requests use only the expected attachment credential. Reports preserve revision evidence in both languages for all four routes. Every regular application file, including encrypted history, is scanned for synthetic values; exactly `runs/<capture>/state` is excluded as native mutable state. Removing all eight fixture conversations removes their masking histories without additional primary model requests.

```sh
AGENT_MATRIX_TEST_OPENCODE=/absolute/path/to/opencode \
AGENT_MATRIX_TEST_PI=/absolute/path/to/pi \
AGENT_MATRIX_TEST_DSH=/absolute/path/to/dsh \
AGENT_MATRIX_ROTATION_REPORT=/absolute/path/to/result.json \
AGENT_MATRIX_ROTATION_SCREENSHOT=/absolute/path/to/report \
npm run test:credential-rotation
```

External providers, broader plugin/MCP behavior, other platforms and full X3 acceptance need separate evidence. The [data-boundary audit notes](credential-data-boundaries.md) map inspected application surfaces to their current assertions and document the separate encoded-native-identity rejection fix.

The earlier [2026-09-19 macOS arm64 result](probes/2026-09-19-credential-redaction-history-desktop.json) passes all three engines on the Pi-AI DSH route with 15 primary model requests. Its original 861-test unit result remains historical evidence.

The [four-route follow-up](probes/2026-09-19-four-route-credential-rotation.json) passes 20 primary requests, scans 112 application regular files and explicitly excludes eight native state directories. The retained native DSH report screenshots were visually inspected in English and Chinese. The full unit suite passes 928 tests across 61 files with two workers; ESLint, TypeScript, production build and changed-file formatting checks pass. [Validation metadata](probes/2026-09-19-credential-boundary-validation.json) records the commands, scope and source revision.
