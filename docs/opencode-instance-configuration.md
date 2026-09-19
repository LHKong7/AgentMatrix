# OpenCode ACP instance configuration checks

New OpenCode 1.18.16 captures verify the requested configuration against the HTTP server owned by the actual ACP child. Verification runs before Ready, on native resume, and before and after each turn. This detects overrides that only occur in the ACP process, which a successful separate `debug config` process cannot establish.

## Capture and observation contract

The planner records `observers/opencode-config.json` with version 1, including when no Skills are selected. It is an inert, integrity-checked marker, not a plugin. The existing preflight still checks the installed release and independently loaded native configuration. The new check additionally compares the current server's directory-scoped `GET /config` result with the captured `opencode.json`. Known copied Prompt references and prepared child environment references are expanded in main-process memory for comparison; arbitrary native file references are never opened by the observer.

The comparator preserves the existing contract: native defaults and extra instruction sources may be present, while requested provider/endpoint/authentication/model settings, sampling, Agent Prompt and permissions, instruction order, Skill paths, MCP definitions and plugin wiring must match. Equivalent native permission normalization is accepted. This is comparison of requested fields, not equality of every native configuration field. All mismatched field groups are reported without copying native keys or values.

Configuration and optional [Skill source checks](opencode-skill-sources.md) share one owned loopback listener and one fresh authentication secret. The observer reads the acknowledged session, the current configuration, any selected Skill listing, then the session again. Both session responses must match the ACP-returned native ID and captured working directory. All requests include that directory and use the same ten-second observation deadline. Reads disallow redirects, enforce strict UTF-8/JSON and a 4 MiB response bound, and abort when the attachment closes. The application does not connect to an existing server.

OpenCode's pinned [ACP command](https://github.com/anomalyco/opencode/blob/v1.18.16/packages/opencode/src/cli/cmd/acp.ts) creates the server consumed by ACP. Its [configuration endpoint](https://github.com/anomalyco/opencode/blob/v1.18.16/packages/opencode/src/server/routes/instance/httpapi/groups/config.ts) applies authentication and instance routing; the [handler](https://github.com/anomalyco/opencode/blob/v1.18.16/packages/opencode/src/server/routes/instance/httpapi/handlers/config.ts) reads the directory's configuration service. This establishes the scope of the observation without adding an executable observer plugin.

## Lifecycle and compatibility

Successful new attachments record `opencode.instance-config` alongside existing preflight and session-selection checks. English/Chinese configuration and capability reports prefer this precise scope for configuration-backed fields. The receipt remains attached to its original run ID, snapshot digest, native session ID and timestamp. Historical receipts remain visible after restart; only a successful new attachment produces fresh evidence. Report reads do not call the HTTP server or resolve credentials.

Captures without the marker retain their prior behavior: `opencode.config` continues to mean separate-process preflight. Skill-only captures keep their original authenticated source check. Resume does not rewrite immutable inputs or manufacture stronger evidence for older captures.

A mismatch has the fixed `opencode-instance-config` category and relevant shared field groups. Missing, malformed, oversized, unauthenticated or expired responses are unavailable observations. Failure before Ready prevents startup acknowledgment; failure before a turn prevents that prompt from being submitted. A post-turn failure reports the mismatch but cannot undo model calls or tool actions already performed. Cancellation while waiting for the pre-turn check also prevents submission.

Raw configurations can contain provider keys, headers and Prompt bodies. They stay in main-process memory and are never placed in report responses, journal events or diagnostic text. The ephemeral listener password, encoded credentials and full authorization header join the existing redaction set before spawning. They are absent from immutable captures and command arguments and are regenerated for native resume.

## Verification and limits

Unit cases cover decoded secret comparison, literal nested Prompt macros, multiple-field mismatch classification, response bounds and malformed data, session/directory changes, capture-plan validation, cancellation, cleanup, legacy evidence, startup failure, pre-turn rejection and post-turn failure. Existing Skill-only tests exercise the extracted shared HTTP transport. Reports preserve historical ownership and engine-specific evidence.

The installed fixture uses a native plugin that changes configuration only when the actual ACP server's ephemeral password is present. Separate preflight therefore succeeds. It verifies startup and resume rejection without additional provider calls, an active-session override blocked before prompt submission, restoration of the active configuration, native resume, authenticated readback, credential omission from captured files, and listener shutdown. No Skills are selected, proving that configuration observation does not depend on Skill bindings.

The bilingual desktop fixture also induces an ACP-only Prompt override, checks field diagnostics and redaction, and records the current-instance check through report reads, application restart and native resume. Existing preflight failures retain their distinct label. Native and desktop fixtures use isolated local synthetic providers; they do not establish external endpoint/model acceptance or other-platform support.

Validated on **2026-09-19, macOS arm64**: **781 unit tests across 53 files**, all **five installed OpenCode fixtures**, ESLint, TypeScript and production build passed. The full OpenCode Electron lifecycle fixture passed, and English/Chinese instance-failure screenshots were inspected. Recorded evidence: [native configuration checks](probes/2026-09-19-opencode-instance-config-native.json) and [desktop lifecycle and reports](probes/2026-09-19-opencode-instance-config-desktop.json).

```sh
AGENT_MATRIX_TEST_OPENCODE=/absolute/path/to/opencode \
AGENT_MATRIX_OPENCODE_CONFIG_REPORT=/absolute/path/to/result.json \
npx vitest run --config vitest.opencode.config.ts --maxWorkers=1

AGENT_MATRIX_SESSION_ENGINE=opencode \
AGENT_MATRIX_TEST_OPENCODE=/absolute/path/to/opencode \
npm run test:sessions
```

The server result identifies effective configuration values at each check; it does not identify the winning external file, every intermediate override, the Agent service's internal cache, all session-specific option changes, loaded instruction bodies, or the final model-visible Prompt after hooks. Source mutation between checks remains possible. Model acceptance, Skill invocation, MCP connectivity and permission enforcement need their own evidence. Complete native precedence and B6/A12 acceptance remain open.
