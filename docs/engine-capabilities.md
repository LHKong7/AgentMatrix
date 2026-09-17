# Engine compatibility and capability descriptors

Agent **Resolved preview** and the **Sessions** page now check the selected configuration against the pinned OpenCode, Pi, or DeepSeek Harness adapter before offering a new session. Known incompatible settings remain editable and persistable drafts. The session button is disabled with English/Chinese reasons; no binding, parameter, or policy is silently removed.

## One validation path

`src/shared/engines/contracts.ts` owns the pinned adapter versions and provider-family mappings. `src/shared/engines/validation.ts` evaluates static configuration constraints without files, subprocesses, credentials, or network access. Both renderer diagnostics and all three native planners use it. The desktop factory repeats validation before native-source inspection or run capture, so bypassing renderer controls cannot launch an incompatible profile.

| Engine           | Examples diagnosed before startup                                                                                                                                                                                                      |
| ---------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| All three        | Wrong engine/version/mode, incompatible host platform, unsupported provider/authentication route, missing key reference, selected native plugins whose activation is not implemented, conflicting replacements, invalid command values |
| OpenCode         | Unsupported reasoning mapping, invalid native agent name, empty replacement prompt, forced legacy SSE                                                                                                                                  |
| Pi               | MCP without an explicitly selected and verified extension, universal per-tool approval, conflicting shared/native thinking, unknown thinking levels, sampling on unsupported API families                                              |
| DeepSeek Harness | Nonempty prefix arguments, SDK profile selection, sampling parameters, unsupported route-specific reasoning, reserved/custom headers on incompatible provider components, MCP OAuth, forced legacy SSE                                 |

Project trust remains separate from Pi tool approval. OpenCode's keyless Chat Completions route remains distinct from Pi/DSH authentication requirements. DSH's native DeepSeek provider remains separate from its gateway component; sharing a protocol mapping constant does not merge these routes or their runtimes.

Static checks are not complete startup validation. The native planners still validate captured Skill frontmatter/names and materialize inputs. Startup checks executable identity, cwd, captured and external files, credentials, native composition/readback, and session state. Successful static validation is labeled **startup checks still required**, not runtime verification. Saved-profile edits do not alter an existing conversation or its captured retry/resume inputs.

## Independent capability dimensions

The expandable details describe twelve configuration fields with separate mechanism, runtime verification, availability, and whether the setting is requested. An optional unsupported feature with no binding does not block startup. For example, Pi without MCP bindings remains eligible, while its MCP row still states that a compatible extension is unavailable.

The descriptors are scoped to installation ID, pinned mode, selected engine version, profile ID, model route, and a SHA-256 digest of the resolved configuration and host context. The input is copied before asynchronous hashing. Changes to executable, version, endpoint, model, credential reference, or captured asset input change the digest; an old descriptor cannot be reused as evidence for the changed configuration. This is an in-memory draft identity, not a run-manifest digest or a continuous check of installed binary bytes.

Evidence records now distinguish `contract` from `runtime`. The preview records when its adapter contract rules were evaluated and leaves runtime verification `untested`. Native-dependent availability remains unknown until checked; known incompatibilities and missing extensions are explicit. `isVerifiedCapability` requires runtime evidence, successful verification, availability, and the exact installation/version/mode/digest. Contract evidence alone cannot satisfy it, even if another caller changes the status to `passed`.

Descriptors contain no prompt bodies, endpoint paths, header/environment values, executable paths, or credential references. These values may contribute to the in-memory digest but are not returned as metadata. The UI generates details only when expanded, debounces changes, and discards obsolete replies. It does not call a CLI to display compatibility.

## Validation and limits

- `tests/engine-capabilities.test.ts` covers baseline mappings, API families/authentication, per-engine constraints, optional versus requested features, unchanged drafts, configuration identity, asynchronous mutation, sensitive-value omission, and rejection of contract-only verification.
- Factory tests assert known invalid configurations fail before run files are created, even with a nonexistent executable; credential resolution is never called.
- Existing native-planner tests continue to exercise actual mapping and rejection behavior through the shared validator. The full unit suite contains 404 passing tests; lint, type checking, and the production build pass.
- The extended Electron session fixture verifies blocked start controls, retained editable drafts, bilingual capability details, direct IPC rejection before capture, and the subsequent valid configuration/session lifecycle against local synthetic providers.

Recorded macOS arm64 runs use the pinned installed engines and local Chat Completions fixtures:

- [OpenCode 1.18.16](probes/2026-09-18-engine-capabilities-opencode.json)
- [Pi 0.85.1](probes/2026-09-18-engine-capabilities-pi.json)
- [DeepSeek Harness 0.1.5-rc.2](probes/2026-09-18-engine-capabilities-dsh.json)

The fixture now explicitly polls awaited IPC results for installation probes, submitted turns, session state, and conversation creation. The installed Playwright `waitForFunction` implementation treats a returned Promise as truthy before its resolved boolean can control polling; it is used only with synchronous predicates elsewhere. Earlier smoke results should be read alongside the new awaited checks.

This implements static compatibility diagnostics and the descriptor foundation of A8/A11/C3/D3. It does not complete A8 runtime availability or model-service acceptance. Recorded native checks remain in the separate [session configuration report](configuration-report.md); promoting those scoped observations into reusable capability descriptors is still open. Credential-value rotation, complete native provenance/import, selected plugin activation, external-provider acceptance, and cross-platform acceptance remain open. Windows is blocked by the current desktop runtime path; Linux remains unverified by these macOS fixtures.
