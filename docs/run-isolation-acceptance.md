# Concurrent run isolation acceptance

This fixture verifies two captured revisions of the same Agent profile through OpenCode 1.18.16, Pi 0.85.1 and both DeepSeek Harness 0.1.5-rc.2 provider routes. It uses the production desktop factory, adapters, immutable input store and normalized runtime events with a local synthetic Chat Completions service. It does not launch Electron or test renderer IPC; the [desktop lifecycle](three-engine-acceptance.md) and [credential-rotation fixture](credential-redaction-history.md) cover those boundaries separately.

## Scenario and assertions

Each route captures revision A and then revision B of one profile. They share library identities but select different model IDs, endpoint paths, credential references, Prompt/Skill versions and working directories. Both attachments start before either initial turn finishes. The provider holds their first requests until both arrive, proving overlap rather than sequential execution.

| Boundary                   | Evidence                                                                                                                                                                                                                                                                                                                                      |
| -------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Connection and credentials | Every provider request must match the snapshot's endpoint path, model, Bearer key and supported custom header. Sibling keys are rejected. Native DSH uses its separate `deepseek-official` route without custom headers.                                                                                                                      |
| Prompt and Skill version   | Provider input must contain the selected Prompt marker and exclude the other revision. OpenCode/DSH invoke the native Skill tool; Pi reads its mapped captured Skill entry. Each current turn's tool result must contain the matching version.                                                                                                |
| Tool environment           | A native bash tool invokes a controlled Node script. Its output verifies the expected run-specific state/temp paths and absence of unselected ambient credentials. Selected secret variables follow the native policy described below.                                                                                                        |
| Working directory          | Both projects have the same relative filenames with different markers. Native tools read and write those names from the captured working directory. Each completed turn verifies the corresponding file on disk.                                                                                                                              |
| Event and context routing  | Provider bodies exclude sibling Prompt/Skill/workspace markers, snapshot IDs and credentials. Normalized output also excludes sibling environment/reply markers and masks recognized current values.                                                                                                                                          |
| Close and restoration      | Closing A must not interrupt B. The fixture removes the saved Prompt/Skill library entries and changes the saved model, then restores both exact native session IDs. Provider context must retain each session's own initial response, with its captured configuration still applied.                                                         |
| Storage and retention      | Captured manifest bytes/digests remain unchanged. Input files, manifests and encrypted masking histories are scanned for all synthetic keys. Decrypted histories contain the selected provider key and exclude the sibling provider key. After A closes and its capture is removed, B completes another native turn and retains its manifest. |

The scenario performs six turns per route: two initial turns, B continuing after A closes, two restored turns, and B continuing after A's capture is removed. Native tool results are correlated by the current turn's call IDs; an older transcript marker is insufficient.

## Native tool environment policies

OpenCode and Pi's inspected bash tools inherit their own selected `AGENT_MATRIX_SECRET_*` values in this fixture. Those values must not belong to the sibling attachment and must be masked in application events. This does not claim that selected provider keys are hidden from a tool the user authorizes.

The pinned `@deepseek-ai/dsh-subprocess` 0.1.5-rc.2 implementation uses a case-insensitive `KEY|PASSWORD|SECRET|TOKEN` filter in `scrubbedParentEnv`; the terminal backend documents that shared scrub. Both DSH routes therefore require an empty `AGENT_MATRIX_SECRET_*` map in the inspected tool environment, while their provider HTTP requests still require the correct selected key. The fixture's first attempt assumed identical inheritance and failed on DSH's empty credential map; the corrected assertion follows inspected native code and verifies absence explicitly.

The installed code inspected for this distinction is `@deepseek-ai/dsh-subprocess/lib/index.js`; `@deepseek-ai/dsh-terminal-bash/README.md` describes the subprocess credential scrub. These are pinned local package observations, not a promise about future versions or every extension-defined tool.

## Verification

On September 19, 2026, all four installed-engine cases passed sequentially on macOS arm64: 24 native turns and 72 primary requests. Lint and TypeScript checks passed. The [verification record](probes/2026-09-19-run-isolation-acceptance.json) identifies the source revision, fixture hashes and individual route reports. Runtime code is unchanged; the earlier 976-test unit result was not rerun for this fixture-only change.

## Reproduction and scope

```sh
AGENT_MATRIX_TEST_OPENCODE=/absolute/path/to/opencode \
AGENT_MATRIX_TEST_PI=/absolute/path/to/pi \
AGENT_MATRIX_TEST_DSH=/absolute/path/to/dsh \
AGENT_MATRIX_ISOLATION_REPORT=/absolute/path/to/isolation \
npm run probe:isolation
```

`vitest.isolation.config.ts` runs one test worker. Each case intentionally contains two simultaneous attachments; the four engine/route cases run sequentially. Missing executable variables skip their cases, so skipped output is not acceptance evidence. The report prefix produces one JSON record per route. Ordinary unit tests do not launch these CLIs.

This verifies configuration, event and resource routing under ordinary authorized use. The two captures select different project directories; it does not create worktrees, prevent a tool from deliberately opening another user-owned path or isolate project files when two sessions choose the same directory. Runtime state and masking histories are scoped by capture. Native transcripts can contain raw model/tool content, and the fixture does not rewrite them.

The input store uses a test AES-GCM implementation of `SecretCipher`, exercising the marked encrypted-history path. Actual OS credential storage is covered by the separate Electron fixture. MCP/plugin-specific behavior, arbitrary injected credentials, remaining X3 logging/input paths, external providers, other platforms and packaged applications require their own evidence. No delivery gate is promoted by this record.
