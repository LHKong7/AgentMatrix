# OpenCode ACP Skill source verification

New OpenCode 1.18.16 captures with selected Skills verify their native entry paths through the HTTP server owned by the actual ACP child. Checks run before Ready, on native resume, and before and after each turn. A same-name Skill selected from another location fails with a `skills` configuration diagnostic. This closes the gap between the earlier separate-process preflight and the current ACP server's directory-scoped Skill selection.

## Captured plan and native observation

The adapter stores `observers/opencode-skills.json` with the selected native names and Agent identity. Attachment verifies that plan against `opencode-mappings.json` and the captured file inventory. The marker contains no credentials or executable observer. Captures without the marker retain the existing `debug skill` preflight and its narrower evidence; immutable inputs are not migrated during resume. Empty Skill selections add no observer.

The pinned ACP command starts its native HTTP server before initializing the ACP connection and uses that server internally. AgentMatrix selects an available loopback port, passes explicit `--hostname 127.0.0.1 --port <port>` arguments, and supplies a fresh random HTTP password through the child environment. The listener reservation is released before launching the child; a competing bind causes native startup to fail because an explicit nonzero port does not use native fallback. AgentMatrix does not attach to an existing server.

Once ACP returns the native session ID and its model/Agent checks pass, the observer makes three authenticated requests against that owned listener: read the session, read `/skill`, then read the session again. Every request specifies the captured working directory. Both session responses must match the acknowledged session ID and directory. The Skill response comes from the native directory-scoped Skill service used by that server. Each selected name must appear exactly once at its captured entry path; unrelated native Skills are allowed. Exact captured paths and canonical paths derived from trusted captured entries are accepted. Electron never opens a path supplied by the native listing.

This requires no additional observer plugin or plugin dependency installation, and works with native pure mode. User-selected native plugins retain their existing activation checks and trust boundary. The separate native configuration readback still runs before ACP; new captures no longer need the separate Skill preflight process.

## Bounds, credentials, and lifecycle

The ephemeral password is separate from the model-provider credential and is regenerated on each attachment. It is never placed in captured files, command arguments, journals, reports, or exports. Raw password, encoded Basic credentials, and the complete authorization header enter the in-memory redaction set. Combined redaction limits are checked before spawning the child. HTTP requests are loopback-only, disallow redirects, share a ten-second observation deadline, and abort with attachment disposal or process cancellation.

Each response is streamed with a 4 MiB limit and strict UTF-8/JSON decoding. Listings allow at most 10,000 entries and mappings at most 1,000 selected bindings. Native Skill bodies can occur in `/skill` responses; they remain transient main-process memory and are discarded after extracting names and paths. No raw response or native error enters diagnostic text. Closing the owned ACP child closes its listener; cleanup cancels pending observations.

A pre-turn mismatch prevents prompt submission and therefore prevents a new provider call for that turn. Cancellation received during preflight also prevents submission. A failed post-turn check cannot undo model calls or tool actions already performed. Missing, malformed, oversized, unauthenticated, or expired observations fail as unavailable; selected-source differences fail as mismatch.

The observer confirms the directory-scoped selection returned by the owned ACP server at each check. It does not obtain a native cache-generation token or prove that a cache cannot change between checks. Trusted plugins can change behavior during a turn. Native duplicate-name discovery is not necessarily deterministic. Successful source matching does not prove Skill invocation, loaded body equality, model-visible Prompt content, sandbox enforcement, or complete collision/source attribution.

## Reports and compatibility

Successful new attachments record `opencode.instance-skills`; reports show `opencode-acp` with English and Chinese text. The earlier `opencode.skill-sources` receipt continues to mean only a separate-process preflight and remains labeled `opencode-probe`. Neither `opencode.config` nor another engine's checks establish OpenCode source evidence. Historical receipts remain tied to their recorded attachment; a successful native resume creates fresh evidence. Report reads only inspect captured inputs and journal metadata.

Failures carry the fixed `opencode-instance-skills` category, a `mismatch` or `unavailable` reason, and the `skills` field group. Native paths, bodies, authentication headers, and error messages are excluded. The separate captured-entry display uses the already verified adapter mapping.

## Verification and pinned sources

Unit tests cover foreign, relative, aliased, duplicate and missing selected entries; unrelated Skills; session/directory changes; malformed and oversized output; abort and cleanup; plan consistency; redaction capacity; cancellation before prompt submission; legacy evidence; and historical/engine separation.

The installed-release fixture uses a local synthetic provider and a native plugin that substitutes Skills only in the ACP child. New sessions and native resumes reject the substitution without another provider call, while unchanged captured inputs remain reusable after removing the override. It also checks rejection of unauthenticated requests, authorized source paths, absence of ephemeral authentication from captured files, and listener shutdown. Evidence is recorded in the [native result](probes/2026-09-19-opencode-instance-skills-native.json). The [bilingual Electron result](probes/2026-09-19-opencode-instance-skills-desktop.json) covers the report, restart and fresh native resume alongside the existing session lifecycle checks.

Validation on **2026-09-19** passed **732 unit tests across 52 files** with two workers, all **four installed OpenCode fixtures**, ESLint, TypeScript, and the production build. The default-concurrency unit run first timed out in the existing Skill-directory file-count stress test and affected its following test; the complete reduced-concurrency rerun passed without changing those tests or their limits. Both Electron report screenshots were inspected.

```sh
AGENT_MATRIX_TEST_OPENCODE=/absolute/path/to/opencode \
AGENT_MATRIX_OPENCODE_SKILL_REPORT=/absolute/path/to/source-report.json \
npx vitest run --config vitest.opencode.config.ts --maxWorkers=1
```

The contract follows the pinned [ACP command](https://github.com/anomalyco/opencode/blob/v1.18.16/packages/opencode/src/cli/cmd/acp.ts), [server lifecycle](https://github.com/anomalyco/opencode/blob/v1.18.16/packages/opencode/src/server/server.ts), [HTTP authentication](https://github.com/anomalyco/opencode/blob/v1.18.16/packages/opencode/src/server/auth.ts), [instance endpoints](https://github.com/anomalyco/opencode/blob/v1.18.16/packages/opencode/src/server/routes/instance/httpapi/groups/instance.ts), [Skill handler](https://github.com/anomalyco/opencode/blob/v1.18.16/packages/opencode/src/server/routes/instance/httpapi/handlers/instance.ts), and [Skill loader](https://github.com/anomalyco/opencode/blob/v1.18.16/packages/opencode/src/skill/index.ts). Validation is limited to macOS arm64 and isolated local providers; external-provider, other-platform, and complete native precedence acceptance remain open.
