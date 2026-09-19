# OpenCode conflict source evidence

When OpenCode rejects captured configuration because native values differ, the Configuration report now identifies captured JSON/JSONC files containing matching declarations. This makes a failed start actionable without exposing the conflicting Prompt, endpoint, key, header or other native value. English and Simplified Chinese reports preserve the evidence after restart.

## Meaning of a match

OpenCode 1.18.16 merges several configuration layers. Its [configuration handler](https://raw.githubusercontent.com/anomalyco/opencode/v1.18.16/packages/opencode/src/server/routes/instance/httpapi/handlers/config.ts) returns the effective configuration, while the [HTTP response contract](https://raw.githubusercontent.com/anomalyco/opencode/v1.18.16/packages/opencode/src/server/routes/instance/httpapi/groups/config.ts) does not expose a complete field-origin trace. A matching declaration therefore identifies a possible source, not a proven winning source.

Both the separate `debug config` preflight and the owned ACP server check compare requested values with native readback. On a mismatch, the adapter examines captured external candidates named `config.json`, `opencode.json` or `opencode.jsonc`. A declaration must occur at the same structural position as a rejected value and match that value. Native Agent permission normalization is accepted under its existing comparator contract. Unrelated Agent/provider names do not count as matches. All matching sources are retained, including ambiguous duplicates; list order does not assert native precedence.

Only source indices and fixed field groups enter the failure receipt. The report resolves indices against that session's immutable manifest and displays captured paths already available in its source inventory. It does not display raw JSON pointers, native values or intermediate comparison data. Invalid indices cannot become displayed provenance. A first-start failure still has no successful native observation, and earlier successful checks remain historical after a failed resume.

## Read boundaries

The matcher reads regular files through the existing bounded file inspector. Resolved path, byte count and digest must match the captured observation. A changed, deleted or retargeted source cannot supply a match. Each file is limited to 1 MiB and each analysis to an 8 MiB candidate-byte budget. It stops initiating reads after two seconds or preflight cancellation; this is not a hard operating-system filesystem timeout.

Parsing is inert and uses the existing JSONC limits: duplicate keys, invalid UTF-8, excessive depth or size and malformed content are rejected. No subprocess, network request, import, secret resolution, environment interpolation or referenced-file read is performed to attribute a value. Declarations containing `{env:...}` or `{file:...}` remain unassigned. Missing, oversized, changed, unsupported or unreadable candidates do not replace the original native mismatch with a secondary attribution failure.

An empty result means that no match was identified within these bounds. It does not prove that no native source was responsible. Markdown Agents/Modes, managed preference payloads, remote settings, legacy transformations and runtime plugin hooks require separate attribution. Additional native fields that do not violate a captured requirement are outside this failure-only analysis. Complete native merge precedence and successful-field provenance remain open.

## Persistence and compatibility

The optional diagnostic `sourceMatches` array contains unique captured source indices and unique affected field groups. It is allowed only on `opencode-config` or `opencode-instance-config` mismatch diagnostics, and every attributed group must also appear in the diagnostic's rejected fields. Other engines cannot acquire this evidence through their own diagnostic categories. Legacy records without the field remain readable and receive no retroactive matches.

The journal stores the receipt with the failed run/session identity. Report reads use recorded metadata only; they neither reread source files nor launch the CLI. Deleting a source after failure does not erase the historical match. Starting another attachment clears the latest visible failure as before; old events remain in history and exports. Immutable captures and native files are not rewritten by attribution.

## Verification

Unit coverage includes multiple matching sources, unrelated names and unchanged values, several simultaneous fields, native permission normalization, secrets omitted from receipts, inert macros, malformed/duplicate/oversized/invalid-UTF-8 sources, source changes and retargeting, cancellation, schema forgery, legacy records, journal restart and historical report reads after source deletion. The ACP instance check verifies the new metadata through its authenticated session-bound observation path.

The OpenCode Electron fixture adds a real project JSONC Prompt override alongside the existing Markdown and ACP-only plugin overrides. It checks the matching JSONC path, unknown attribution for unsupported/dynamic sources, failure before any model request, unchanged native files and manifests, both UI languages, secret/body omission, and the same recorded match after source deletion and app restart. Its ordinary tools, permission replies, cancellation, native restoration, history, shared asset updates and cleanup scenarios also run.

```sh
AGENT_MATRIX_SESSION_ENGINE=opencode \
AGENT_MATRIX_TEST_OPENCODE=/absolute/path/to/opencode \
AGENT_MATRIX_SESSION_REPORT=/absolute/path/to/result.json \
AGENT_MATRIX_DIAGNOSTIC_SCREENSHOT=/absolute/path/to/report \
npm run test:sessions
```

Screenshots use `.json`, `.markdown` and `.instance` suffixes for the three conflict scenarios, followed by `.en.png` or `.zh.png`. The fixture uses a local synthetic Chat Completions service; it does not verify an external model provider. This increment advances B3/B6/A12 source-conflict diagnostics without completing native precedence, external-provider or release gates.

Validated on **2026-09-19, macOS arm64**: **887 unit tests across 59 files**, ESLint, TypeScript and production build passed. The [installed OpenCode Electron result](probes/2026-09-19-opencode-override-sources-desktop.json) passes the new source scenarios and its complete lifecycle regression. English/Chinese report screenshots were inspected.
