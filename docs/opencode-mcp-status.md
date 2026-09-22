# OpenCode MCP connection observations

OpenCode sessions now record each selected MCP service's native status when a process attaches to a new or restored conversation. The configuration report shows these statuses in English and Chinese, independently of the existing configuration-mapping checks. This extends A4/A8/X2 with application-visible evidence; it does not establish continuous connectivity or complete OAuth support.

## Native scope and bounds

The adapter queries `/mcp` on the existing authenticated loopback listener owned by the ACP process. The [pinned OpenCode service](https://github.com/anomalyco/opencode/blob/v1.18.16/packages/opencode/src/mcp/index.ts) reports connection/tool-discovery status for native server names. The adapter selects only `agentmatrix-<captured-id>` entries, in immutable manifest order, and drops every native name, error string, URL and extra property.

This sample shares the [instance observation transport](opencode-instance-configuration.md): random per-process credentials, no redirects, a four-MiB response limit, strict UTF-8/JSON parsing, cancellation and cleanup. The acknowledged native session ID and project directory must match both before and after the read. The entire status window has a ten-second deadline; multiple configured server timeouts cannot extend this observation indefinitely. Required configuration/Skill checks run before and after the optional MCP sample.

| Native result                                                       | Recorded status                | Meaning                                                           |
| ------------------------------------------------------------------- | ------------------------------ | ----------------------------------------------------------------- |
| `connected`                                                         | `connected`                    | Native connection and initial tool synchronization succeeded      |
| `disabled`                                                          | `disabled`                     | The native service is disabled                                    |
| `failed`                                                            | `failed`                       | Connection or tool discovery failed; no error message is retained |
| `needs_auth`                                                        | `authentication-required`      | The engine reports authentication is required                     |
| `needs_client_registration`                                         | `registration-required`        | The engine reports client registration is required                |
| Missing or unrecognized selected entry                              | `unknown`                      | No supported native status was obtained                           |
| HTTP/JSON/encoding/size error, changed session identity, or timeout | All selected entries `unknown` | The observation window could not be validated                     |

An unavailable MCP observation does not block an otherwise usable OpenCode conversation. Cancellation, process exit and failed required configuration checks still abort attachment. Sampling may initialize native MCP clients; it does not submit a model prompt, call an MCP tool, or launch an AgentMatrix OAuth login flow. Native engine authentication behavior retains its existing scope.

The native service owns connection state. `connected` is its status at the recorded time, not proof of tool execution, a fresh network heartbeat, exact transport negotiation or continuing availability. The adapter does not resample it around every turn. Native configuration and selected Skill checks retain their existing turn-boundary behavior.

## Persistence and reports

The optional `mcpConnections` receipt contains a fixed source (`opencode-acp`), an observation timestamp and at most 200 status enums. Positional entries are bound to the immutable MCP list through the enclosing run ID, captured digest and native conversation identity. Reports reject mismatched list lengths, engine scope, missing instance-configuration evidence or a sample newer than its enclosing attachment receipt. Display names and requested transport come from captured inputs, not current library edits or native data.

The coordinator publishes the receipt with `run.ready`. A failed Ready write cannot create successful attachment evidence. Application restart and failed resume preserve the previous receipt as historical. Successful native resume obtains a new sample and replaces the previous attachment observation. Reads and UI refreshes use persisted evidence; they do not connect services, resolve secrets or make native HTTP calls.

In the capability table, all selected services must be `connected` to pass the scoped MCP check. Any explicit failed/disabled/auth-required/registration-required state produces a failed check. Otherwise the result remains untested. Availability is ready/blocked only for the matching current attachment and contract; historical evidence has unknown availability. A failed MCP capability does not mean the entire conversation is blocked.

Existing journals without a receipt remain readable and unverified. Captures with the existing instance-configuration marker can gain fresh evidence on their next successful start/resume. Captures without that marker retain their narrower legacy behavior. DSH and Pi do not manufacture OpenCode receipts: DSH now records separate [native initialization evidence](dsh-mcp-startup.md), which leaves current connectivity unverified; Pi still requires an explicitly verified MCP extension.

## Validation and remaining work

Unit coverage exercises authentication/session identity, selected-only mapping, raw-detail omission, malformed and oversized responses, missing entries, deadline/cancel/disposal, report identity and aggregation, historical ownership, restart, failed/successful resume, saved-label changes and failed Ready persistence. The installed HTTP MCP fixture checks that production attachments record connected, failed and recovered states while preserving actual tool calls and native restoration. Other OpenCode native fixtures exercise compatibility with the shared observation transport.

The bilingual Electron fixture configures one available service and one returning HTTP 401. It verifies per-service rows and failed aggregate evidence, confirms report reads make no MCP requests, retains historical failed status after the service recovers, and obtains connected statuses only after a successful native resume. Its existing configuration, streaming, permission, cancellation, persistence, history and source-failure scenarios remain in the run.

Validated on **2026-09-19, macOS arm64**: **815 unit tests across 54 files**, all **six installed OpenCode fixtures**, ESLint, TypeScript, formatting and production build passed. All three engines passed their full bilingual Electron lifecycle fixtures. English/Chinese MCP screenshots were inspected. Records: [native OpenCode status and tool calls](probes/2026-09-19-opencode-mcp-status-native.json), [OpenCode desktop status and recovery](probes/2026-09-19-opencode-mcp-status-desktop.json), and [Pi/DSH desktop regressions](probes/2026-09-19-mcp-report-regression.json).

The authentication and registration enum mappings have unit coverage. OAuth registration/login/token refresh, dedicated user recovery actions, DSH current-connection status, Pi extension acceptance, external services, continuous monitoring and other platforms remain open. Neither A4/A8/X2 nor a delivery gate is marked complete by this increment.

```sh
AGENT_MATRIX_TEST_OPENCODE=/absolute/path/to/opencode \
AGENT_MATRIX_HTTP_MCP_REPORT=/absolute/path/to/native-result \
npx vitest run --config vitest.opencode.config.ts --maxWorkers=1

AGENT_MATRIX_SESSION_ENGINE=opencode \
AGENT_MATRIX_TEST_OPENCODE=/absolute/path/to/opencode \
AGENT_MATRIX_MCP_SCREENSHOT=/absolute/path/to/mcp-report \
AGENT_MATRIX_SESSION_REPORT=/absolute/path/to/desktop-result.json \
npm run test:sessions
```
