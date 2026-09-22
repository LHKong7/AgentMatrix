# Model-visible Skill loading and selection

The installed-engine fixture checks OpenCode 1.18.16, Pi 0.85.1 and both DeepSeek Harness 0.1.5-rc.2 provider routes through the production desktop factory. Each route uses a captured directory Skill, a local synthetic Chat Completions provider and separate native conversations. It complements [native source matching](skill-source-verification.md) with evidence from actual provider requests and tool results.

## Verified sequence

| Scenario                       | Required evidence                                                                                                                                                                                                                                                                                          |
| ------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| First selected turn            | The initial primary request contains the selected Skill description but neither its body nor its reference-file contents. OpenCode/DSH invoke their native `skill` tool; Pi invokes `read` on the mapped captured entry.                                                                                   |
| Skill entry read               | The next request contains the body in the result for that turn's exact tool-call ID. It still excludes the reference contents. A separate native `read` loads the captured reference file.                                                                                                                 |
| Reference read                 | The following request contains the reference marker in the current read result, then completes the turn. An old transcript marker alone cannot pass the check.                                                                                                                                             |
| Unselected library resources   | Enabled but unbound and disabled unbound library assets have distinct metadata/body markers. Their markers never appear in the primary requests, and the selected manifest contains exactly one Skill.                                                                                                     |
| Duplicate selected names       | Two distinct bound asset IDs with the same directory frontmatter name fail capture. Credential-resolution counts and primary request counts remain unchanged. This verifies adapter rejection of selected-name collisions; it does not infer native precedence between unrelated discoverable directories. |
| Disabled bound asset           | Disabling the selected library asset retains its binding but omits it from the new capture. The new native conversation has no selected Skill name, description, body or reference contents. Disabled assets are skipped by shared resolution; they do not make an otherwise valid profile unlaunchable.   |
| Removed binding                | Re-enabling the asset and removing its binding produces another capture and native conversation without that Skill.                                                                                                                                                                                        |
| Original conversation restored | After deleting the import source and all saved Skill entries, restoring the original native ID preserves its initial reply and captured Skill. It executes fresh entry/reference reads, and the original manifest bytes and digest remain valid.                                                           |

There are four native turns and eight primary requests per route: the selected turn, the disabled-asset turn, the unbound turn, and the restored turn. The original import directory is deleted before the first attachment. The model-facing requests therefore exercise the captured copy throughout.

## Meaning and limits

Here, deferred loading means that the selected Skill body and reference contents are absent from the first model request and appear after their corresponding tool reads. It does not mean the native engine or AgentMatrix has avoided reading these files internally. Discovery and source observers can read them before a turn. The fixture uses controlled provider replies to invoke actual native tools; it does not evaluate an external model's ability to choose a Skill.

The collision case covers two selected directory assets with identical frontmatter names. Existing source-substitution fixtures separately check foreign same-name selections in the actual native instance. Global/project/plugin discovery precedence, arbitrary frontmatter invocation flags and trusted extension behavior during a turn remain separate native contracts. The application does not suppress every unselected Skill that an engine can discover independently from preserved user/project configuration.

This fixture uses the main-process factory and runtime adapters without Electron IPC or OS credential encryption. It uses a `RunInputStore` without a cipher, keeping encrypted-history coverage in the separate [credential-rotation fixture](credential-redaction-history.md). It changes no runtime or UI behavior and does not promote an engine delivery gate.

## Verification

On September 19, 2026, all four cases passed on macOS arm64, completing 16 native turns and 32 primary requests. ESLint and TypeScript checks passed. Production code and UI are unchanged; the preceding 983-test unit result was not rerun for this fixture-only addition.

## Reproduction

```sh
AGENT_MATRIX_TEST_OPENCODE=/absolute/path/to/opencode \
AGENT_MATRIX_TEST_PI=/absolute/path/to/pi \
AGENT_MATRIX_TEST_DSH=/absolute/path/to/dsh \
AGENT_MATRIX_SKILL_LOADING_REPORT=/absolute/path/to/skill-loading \
npm run probe:skills
```

The four cases run sequentially with one worker. A missing executable variable skips the corresponding case; a skip is not passing evidence. The report prefix produces one JSON file per route. Do not overlap this suite with another native/Electron suite or rebuild while it is running.

The [dated verification record](probes/2026-09-19-skill-loading-acceptance.json) records the source revision, exact fixture hashes, native versions and individual route results. The preceding full unit and desktop results retain their original scope; this fixture-only change does not claim they were rerun.
