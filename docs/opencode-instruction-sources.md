# OpenCode instruction reference observations

An unchanged native JSON configuration can reference rule files whose contents or glob matches have changed. New OpenCode captures now record those local matches and reject drift before starting or restoring a conversation. The same selected files are checked around active turns. This implements another part of B3/B6/A12/X2; it does not establish complete native provenance or pass a delivery gate.

## Discovery scope

The inspector reads the already observed OpenCode JSON/JSONC configuration candidates as data, extracting literal `instructions` entries without executing the CLI. Each entry retains its declaring file and array index. Candidate configuration precedence is not inferred: the inventory conservatively includes entries from all inspected candidates, including files a particular native merge may not use.

The path rules follow OpenCode 1.18.16's [instruction loader](https://raw.githubusercontent.com/anomalyco/opencode/v1.18.16/packages/opencode/src/session/instruction.ts) and [filesystem traversal](https://raw.githubusercontent.com/anomalyco/opencode/v1.18.16/packages/core/src/fs-util.ts):

- Relative selectors are evaluated at the working directory and each ancestor through the nearest Git root, including hidden matches.
- `~/` expands against the configured native home. Absolute selectors use their directory as the glob root and their basename as the pattern, with the native default for hidden matches.
- Matching uses the native [glob wrapper's discovery options](https://raw.githubusercontent.com/anomalyco/opencode/v1.18.16/packages/core/src/util/glob.ts), including disabled recursive symlink following. Literal symlink traversal and matched files retain resolved targets.
- Results are sorted and deduplicated per selector for stable comparison. This ordering does not claim native instruction precedence.

`glob` 13.0.5 is pinned to the version declared by [OpenCode's core package](https://raw.githubusercontent.com/anomalyco/opencode/v1.18.16/packages/core/package.json). A directly pinned `minimatch` 10.2.6 precheck rejects brace expansions beyond the observation limit instead of allowing a silently truncated set.

Remote references record an unobserved reason without retaining their URLs. Dynamic file/environment macros are never evaluated by this inspector. Invalid, oversized or otherwise unsupported configuration/selector data records unknown coverage. This includes conservative rejection of macro-like strings even when their original JSON escaping might make them literal in the native parser. Other unknown fields are not converted, executed or copied into observations.

## Integrity and bounds

The optional manifest-v1 `externalSources.instructionSources` field records a versioned list of selectors, search roots, matched paths, resolved file targets, hashes and sizes. It contains no rule bodies, resolved keys, raw remote URLs or macro values. Missing matches remain represented by their selectors so a later match invalidates reuse. Earlier snapshots retain their original shape and digest; they do not gain retroactive source coverage.

Enumeration is repeated after hashing, with fresh glob caches. File reads reject special files, unstable reads and changed link targets. Native configuration bytes are compared with their original source observations before extracting selectors. Capture publication and reuse recheck the source inventory alongside the existing native file checks. Adding, removing, renaming or editing matched files, or changing their resolved targets, rejects reuse. Unmatched edits do not.

Bounds are conservative: 200 selectors, 1,000 matched files in total, 20 MB per rule file, 256 MiB total rule bytes, four MiB per parsed configuration, 1,024 characters per selector, 1,000 brace expansions, 16,384 traversed entries per search, and 64 traversal levels. A search has a five-second timer; a capture/verification pass shares a thirty-second budget checked between operations. These are bounded observation rules, not a filesystem sandbox or a hard deadline for uninterruptible OS I/O. Limit or scan failure rejects capture/reuse instead of publishing a partial successful inventory.

The configuration report displays historical metadata in English and Chinese. Opening it does not read source files, resolve credentials, fetch URLs or start an engine. Empty match sets, unobserved entries and legacy captures have separate labels. Source bodies and final prompt content remain outside the report.

Active OpenCode turns recheck captured local instruction selectors before submission and after completion, reporting the existing `sources / changed / prompts` diagnostic on failure. A post-turn failure cannot undo a prompt already processed by the native engine. This is not continuous monitoring: concurrent edits can occur between checks, and later tool reads can discover nested rules beyond this inventory. Declaration files retain the existing startup/resume source checks; runtime plugin additions and dynamic remote configuration remain outside this static inventory.

OpenCode may add `$schema` to a native configuration that lacks it. The existing integrity check rejects that native write rather than rewriting or silently accepting the captured source. The installed acceptance fixture includes `$schema` so it tests instruction drift independently of this behavior. [Pinned native loader](https://raw.githubusercontent.com/anomalyco/opencode/v1.18.16/packages/opencode/src/config/config.ts).

## Verification

Unit tests cover relative/absolute/home matching, hidden files, multiple ancestors, brace limits, missing matches, add/edit/delete/rename, linked targets, global JSONC, remote/macro privacy, unsupported configurations, nonblocking FIFO rejection, oversized files, publication races, legacy shape and historical reports after source deletion.

The installed OpenCode fixture uses a real temporary Git project and a local synthetic Chat Completions service. It confirms that discovered rule markers enter native model requests, then edits files without changing JSON and verifies rejection before startup/resume credential resolution or an active turn's provider request. New glob matches and previously empty literal matches also block new and restored attachments. Restoring the files allows the same native conversation to resume with unchanged manifest bytes.

The bilingual Electron lifecycle fixture displays both a populated selector and an empty selector, preserves their history across restart, rejects resume after rule-content drift without a new model request, and resumes after restoration. Pi and DSH retain their own source contracts and show that this inventory was not captured. These checks use local fixtures; external-provider acceptance remains separate.

On 2026-09-19, macOS arm64 verification passed the full 845-test suite across 56 files, followed by all 56 run-store tests after adding the publication-race case. ESLint, TypeScript, the production build and changed-file formatting passed. Recorded evidence includes the [installed OpenCode 1.18.16 probe](probes/2026-09-19-opencode-instruction-native.json), [OpenCode desktop lifecycle](probes/2026-09-19-opencode-instruction-desktop.json), and [Pi 0.85.1 / DSH 0.1.5-rc.2 desktop regressions](probes/2026-09-19-instruction-report-regression.json). Both English and Chinese report screenshots were visually inspected.

```sh
AGENT_MATRIX_TEST_OPENCODE=/absolute/path/to/opencode \
AGENT_MATRIX_INSTRUCTION_REPORT=/absolute/path/to/native-result.json \
npx vitest run --config vitest.opencode.config.ts tests/opencode-instruction-sources-installed.probe.ts --maxWorkers=1

AGENT_MATRIX_SESSION_ENGINE=opencode \
AGENT_MATRIX_TEST_OPENCODE=/absolute/path/to/opencode \
AGENT_MATRIX_INSTRUCTION_SCREENSHOT=/absolute/path/to/instruction-report \
AGENT_MATRIX_SESSION_REPORT=/absolute/path/to/desktop-result.json \
npm run test:sessions
```

Remote instruction content, general macro/include dependency graphs, dynamically discovered nested rules, complete native precedence, arbitrary plugin mutations, external providers and other platforms remain open. This inventory is source evidence, not proof of the complete applied system prompt.
