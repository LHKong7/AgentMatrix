# Native resource directory observations

OpenCode 1.18.16 discovers Markdown resources outside generated JSON configuration. A newly added Agent can override a captured Prompt even when every previously observed JSON and rule file is unchanged. New OpenCode snapshots therefore retain directory inventories as well as individual source digests.

## Discovery contract

The inspector covers these candidates in the configured global OpenCode directory, the home `.opencode` directory, and each `.opencode` directory from the canonical working directory through its nearest Git root:

| Directory names       | Matching files           | Resource kind                  |
| --------------------- | ------------------------ | ------------------------------ |
| `agent`, `agents`     | Recursive `*.md`         | Native Agent definitions       |
| `mode`, `modes`       | Direct-child `*.md` only | Legacy native Mode definitions |
| `command`, `commands` | Recursive `*.md`         | Native Command templates       |

This follows the pinned [directory selection](https://github.com/anomalyco/opencode/blob/v1.18.16/packages/opencode/src/config/paths.ts), [Agent and Mode discovery](https://github.com/anomalyco/opencode/blob/v1.18.16/packages/opencode/src/config/agent.ts), and [Command discovery](https://github.com/anomalyco/opencode/blob/v1.18.16/packages/opencode/src/config/command.ts). Hidden Markdown files and symlink targets are included; non-Markdown files and nested Mode files are excluded. Sorting makes observations deterministic; it does not assert native merge order. Managed settings directories are not added as automatic Markdown roots. The application does not forward an ambient custom `OPENCODE_CONFIG_DIR`.

Each observation records the candidate directory, resource kind, existence, resolved directory target, and matching files. Existing files carry their selected path, resolved target, SHA-256, and byte count. Missing directories and dangling Markdown links are recorded. Markdown bodies, frontmatter values, interpolation results, and credentials are never copied into the manifest or report by this observer. It does not parse, expand, execute, or import these files.

Directory reads are bounded to 16,384 entries and 64 recursion levels per candidate. Cycles, special Markdown files, non-directory roots, and unstable reads fail capture. Resource files are limited to 20 MB each, 1,000 files and 256 MiB across the OpenCode inventory. These conservative limits can reject a source tree the CLI itself would accept. Symlinks in observed external trees are supported; immutable generated inputs retain their separate stricter rules.

## Capture and reuse

The adapter scans before planning. `RunInputStore` re-enumerates before publication and on every `verifyForReuse`, which is part of launch and native resume. File addition, deletion, rename, content change, resolved-target change, or creation of a formerly absent directory rejects reuse. An ignored non-Markdown edit does not change the inventory. A rejected attachment preserves the original manifest and native session identity; it must not replace the conversation or rewrite native files. Restoring the captured sources permits another resume attempt. To adopt intentional native changes, capture a new session.

This is an optional manifest-v1 field with no parsing default. Earlier snapshots remain readable with their original digest and original observation coverage; they are not retroactively assigned inventories. Reports show that the inventory was not captured. Pi and DSH retain their current separate source-observation contracts.

The bilingual **Native resource directories** section of the Configuration report displays historical directory/file metadata, including resolved link targets. Reading it does not rescan sources, launch a CLI, or resolve credentials. A file's presence does not prove native parsing, loading, command invocation, or the winning field value. Successful readback is reported separately. After a failed resume, the previous successful attachment's evidence remains historical.

## Remaining boundaries

Coverage remains partial. The separate [instruction reference observer](opencode-instruction-sources.md) now captures literal local instruction selectors and their matching files. Remote sources, general includes/macros, dynamic nested rules, Skill discovery, plugin dependency trees, dynamic hooks, and complete per-field override provenance remain outside these inventories. The existing native readback still detects conflicts in fields it can compare. Observation checks are not a filesystem sandbox or a continuous watcher; another process can change files after a check, and active native processes may load later changes.

## Validation

Unit tests cover recursive/flat discovery, hidden files, absent roots, file additions/deletions/renames/edits, file and directory symlinks, target changes, dangling links, cycles, special files, limits, capture races, immutable historical reports, and legacy manifests.

The installed OpenCode fixture checks native discovery of a project Agent, global Command, and home Mode, plus exclusion of a nested Mode. It also checks a Markdown Prompt override and rejection of a newly discovered file before credential resolution. The desktop fixture checks the inventory in English and Chinese, app restart, rejection of resume after adding a native Agent, preservation of historical evidence and snapshot bytes, and successful resume of the same native session after removing that file.

Run the installed fixture with `AGENT_MATRIX_TEST_OPENCODE` set to the pinned executable:

```bash
npx vitest run --config vitest.opencode.config.ts tests/opencode-installed.probe.ts
```

Run `npm run test:sessions` with `AGENT_MATRIX_SESSION_ENGINE=opencode` and the same executable variable. `AGENT_MATRIX_RESOURCE_SCREENSHOT` optionally names the prefix for `.en.png` and `.zh.png` captures. These fixtures use isolated local providers and synthetic credentials; they do not establish external provider or other-platform acceptance.

Validation on **2026-09-19, macOS arm64**: ESLint, TypeScript, production build, and all **677 unit tests across 48 files** passed. Unit tests used `npm run test -- --maxWorkers=4`; the first unrestricted run overlapped native probing and timed out in two existing filesystem-heavy tests, which passed when rerun with bounded concurrency. Formatting and whitespace checks passed for the changed implementation and new artifacts.

Recorded evidence: [OpenCode 1.18.16 native discovery and override probe](probes/2026-09-19-native-resource-opencode.json), [OpenCode desktop lifecycle and inventory](probes/2026-09-19-native-resource-desktop-opencode.json), [Pi 0.85.1 desktop regression](probes/2026-09-19-native-resource-desktop-pi.json), and [DSH 0.1.5-rc.2 desktop regression](probes/2026-09-19-native-resource-desktop-dsh.json). Pi and DSH explicitly report that no directory inventory was captured; this change does not promote their source coverage or runtime capabilities.
