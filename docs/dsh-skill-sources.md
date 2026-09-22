# DSH session-scoped Skill sources

New DeepSeek Harness 0.1.5-rc.2 captures with bound Skills include an application-owned source observer in the managed composition. The observer runs inside the actual ACP process, independently of any selected user plugins. Existing captures are immutable: those without the observer keep their prior launch behavior and show source verification as unknown.

## Native contract

After ACP creates or resumes a session, the observer resolves both `ctx.agents.get(sessionId)` and `ctx.sessions.get(sessionId)` and requires the exact shared session and captured working directory. It calls `ctx.skills.snapshot()` and `ctx.skills.get()` with that Agent as `scope` and its session working directory as `cwd`. This is the same lookup scope used by DSH's native Skill tool. Looking only at the global catalog would miss a nearer Agent-layer override.

The desktop compares each selected native name and absolute entry path with the verified `dsh-mappings.json` and captured file inventory. The expected provider is `filesystem` and source is `custom`, matching the generated filesystem component. Unrelated native Skills are allowed. Exact selected and canonical captured paths are accepted; arbitrary native paths are never resolved or opened by Electron. Plain Markdown bindings are checked against their generated `SKILL.md` wrapper.

Discovery must be complete, and the observer rejects a catalog revision change during the lookup. A fresh challenge ties each response to its nonce, PID, captured observer identity, native session, and working directory. Native readiness and active observer/root fibers are required. Verification runs before Ready, on native resume, and before and after every submitted turn. A mismatch before a turn prevents the provider request. A failed post-turn check reports failure; it cannot undo actions already performed during that turn.

The observer is bounded to 1,000 selected entries and a 10,000-entry catalog. Native lookups share a 10-second abort signal; the desktop has a 30-second observation deadline and a 4 MiB receipt read limit. Requests and receipts use a private per-attachment state directory and atomic publication. Consumed receipts are removed, and attachment cleanup removes the directory. Native Skill bodies and raw exceptions never enter receipts. Entry paths remain transient private metadata, never diagnostic text or journal fields.

This uses the pinned installed DSH registry, Agent, filesystem-provider, and Skill-tool implementations. The composition inventory verifies the directly inspected component sources. It is not complete transitive dependency provenance. Configured native providers and plugins remain trusted executable code: the check establishes their observed selection, not protection against code that fabricates metadata or changes behavior after a check. It does not establish Skill invocation, model-visible prompt content, or sandbox enforcement.

## Reports and failures

Successful attachments record `dsh.skill-sources` alongside the existing composition and session-model checks. The English/Chinese configuration report shows a DSH session-registry source match and a separate mapped native entry. Report reads use captured inputs and journal metadata only; they do not launch native code or decrypt credentials. Historical receipts remain historical, and a successful native resume records a fresh receipt. Older `dsh.composition` evidence is never upgraded into a source claim.

Failures use `dsh-skills`, a fixed `mismatch` or `unavailable` reason, and the `skills` field group. Source substitution is a mismatch. Missing, incomplete, malformed, stale, or expired evidence is unavailable. Native paths, bodies, and errors are excluded from durable failure diagnostics.

## Verification

Unit tests cover scoped lookup, repeated fresh observations, foreign/relative/lexically aliased paths, missing entries, provider/source changes, incomplete or changing catalogs, native exceptions, wrong process/session identity, inactive fibers, inconsistent captured mappings, cleanup, legacy captures, and runtime checks around turns.

Both installed provider-route fixtures preserve the global filesystem Skill while a native plugin registers a same-name entry in the current Agent scope. They verify the differing native selections, rejection before the next provider request, startup rejection, unchanged captured inputs, and successful native restoration after the override is removed. Results: [pi-ai route](probes/2026-09-19-dsh-skill-sources-pi-ai.json) and [native DeepSeek route](probes/2026-09-19-dsh-skill-sources-deepseek-native.json).

Validation for this change passed 712 unit tests across 50 files, all 11 opt-in DSH tests across six files, TypeScript, ESLint, and the production build. The native configuration fixture also checks directory-Skill sources before and after its Skill/reference/MCP turns.

The [Electron fixture](probes/2026-09-19-dsh-skill-sources-desktop.json) verifies both UI languages, mapped entry display, historical receipts after restart, fresh receipts after native resume, and the existing tools, permission, cancellation, history, and retention workflows. All records are macOS arm64 tests with isolated local protocol fixtures and synthetic credentials; external-provider and other-platform acceptance remain open.

```sh
AGENT_MATRIX_TEST_DSH=/absolute/path/to/dsh \
AGENT_MATRIX_DSH_SKILL_REPORT=/absolute/path/to/source-report \
npx vitest run --config vitest.dsh.config.ts tests/dsh-skill-sources-installed.probe.ts
```

The report prefix produces `.pi-ai.json` and `.deepseek-native.json`. Native contracts are checked against the installed `@deepseek-ai/dsh-skill`, `@deepseek-ai/dsh-skill-filesystem`, `@deepseek-ai/dsh-agent`, and `@deepseek-ai/dsh-tool-skill` release sources, rather than assuming the evolving [upstream project](https://github.com/deepseek-ai/deepseek-harness) has an identical contract.
