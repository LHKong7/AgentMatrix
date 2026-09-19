# DSH native MCP initialization evidence

DeepSeek Harness sessions now record whether their selected native MCP components completed startup. This extends A4/A8/D2/X2 with per-service evidence in the English/Chinese configuration report. It does not pass those work items or a delivery gate.

## Evidence and its limits

The contract is pinned to DSH **0.1.5-rc.2** and its captured `@deepseek-ai/dsh-mcp-client` implementation. In the installed package's `lib/index.js`, asynchronous `apply` awaits `connection.ready`, including initial connection and tool synchronization. With the adapter's existing `failOnStartupError: true`, failure rejects native activation. Reconnect remains disabled.

The same implementation keeps registered tools after a lost connection when reconnect is disabled. Its live client is private implementation state, not a public status service. A running Cordis component or a registered tool therefore cannot establish current connectivity. The report uses **`startup-complete`**, never `connected`, for this evidence. The native HTTP fixture additionally proves that advertised tools can fail after a service starts rejecting requests while the initialization receipt remains unchanged.

| Engine   | Recorded evidence                                                                            | MCP connectivity capability                                                            |
| -------- | -------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| OpenCode | Native `/mcp` statuses at attachment                                                         | Pass only when every selected service is connected; historical availability is unknown |
| DSH      | Selected native components completed startup; their configuration and session identity match | Untested / unknown, even with completed initialization                                 |
| Pi       | No core MCP receipt; a verified extension is still required                                  | Unverified                                                                             |

Initialization does not establish successful tool execution, exact transport negotiation, current network availability, ongoing authentication, or continuing access to a particular tool. An empty tool list can still complete initialization.

## Capture and runtime checks

New captures with selected MCP services include an application-owned native observer and an immutable observation plan. Capture and attachment verify the supported DSH/Cordis/Loader/app-boot framework. Component and framework files participate in existing external-source integrity checks. The profile keeps the selected native MCP rows and their original transport settings.

Before creating or resuming an ACP conversation, the adapter waits for native `appReady`. A fresh challenge receipt must identify the child PID, expected working directory, selected Loader row IDs, exact module names and raw configuration, and distinct running fibers. Later checks also bind the actual native conversation and its working directory. Replaced, disabled, disposed or failed components invalidate the observation. A lifecycle failure remains invalid even if the same fiber later reports running.

Expected raw configuration is carried as inert JSON. Native Loader expressions are represented as expression objects inside that string; they are never evaluated by Electron or interpolated into secret values by the observer's Loader configuration. No resolved secret is needed for configuration comparison. The ordinary MCP rows still use DSH's existing native credential evaluation.

The observer reuses the native plugin receipt protocol with separate environment variables, nonces and temporary directories. Requests are bounded to four KiB and receipts to 128 KiB; checks are cancellable and have a thirty-second deadline. Each challenge is consumed once. Cleanup removes attachment receipts after process closure or failed startup. These receipts establish behavior of the managed native process, not a security boundary against executable plugins within that process.

Checks run before Ready and around turns. They continue to validate component identity/lifecycle, not network liveness. Only successful attachment publishes an initialization timestamp. New native processes on resume repeat initialization and produce a fresh receipt; reading a report does neither.

Missing or invalid required evidence fails with the fixed `dsh-mcp` configuration diagnostic without retaining native errors, URLs, headers or module paths. A native connection failure may reject ACP startup before the observer can answer and remains a general runtime failure. Per-server authentication diagnosis is not inferred from that failure.

## Persistence and compatibility

The existing `run.ready` event carries `mcpConnections` with source `dsh-mcp-startup`, a timestamp and ordered `startup-complete` enums. The schema forbids OpenCode connection statuses under this source and forbids DSH initialization status under `opencode-acp`. No new capability dimension is added.

Report construction requires the DSH engine, both `dsh.composition` and `dsh.mcp-startup` checks, the captured server count, and a timestamp no later than the enclosing attachment observation. Labels and requested transports come from immutable captured inputs. Failed attachment or failed Ready persistence cannot publish new successful evidence. Restart and unsuccessful resume preserve the previous receipt as historical; successful resume replaces it.

Legacy captures without the MCP observer retain their previous behavior and show unknown runtime evidence. They are not silently rewritten. Pi's unknown status and OpenCode's separate native-status semantics remain intact.

## Validation

Unit coverage exercises native row/configuration/fiber/session/PID/directory mismatches, boot cancellation, latched lifecycle failure, framework and plan identity, receipt schema boundaries, persistence and capability aggregation. Installed fixtures exercise both DSH provider routes, Streamable HTTP authorization modes, native tools and errors, failed startup, failed calls after initialization, fresh resume receipts, and a native MCP configuration override rejected before any provider call. The existing stdio, plugin and Skill fixtures remain part of the DSH regression suite.

The Electron lifecycle fixture selects a local MCP service for DSH and checks English/Chinese initialization rows, unverified connectivity, read-only reporting, historical receipts after restart, failed resume and fresh successful resume. Provider and MCP services in these fixtures are local synthetic peers. External services, OAuth, Pi extensions, continuous DSH status, other platforms and full native provenance remain open.

Validated on **2026-09-19, macOS arm64**: **831 unit tests across 55 files**, all **13 DSH installed-release cases across seven files** (the OpenCode-only case is skipped), ESLint, TypeScript and production build passed. The DSH Electron lifecycle passed and both language screenshots were inspected. Records: [Pi-AI route](probes/2026-09-19-dsh-mcp-startup.pi-ai.json), [native DeepSeek route](probes/2026-09-19-dsh-mcp-startup.deepseek-native.json), and [DSH desktop](probes/2026-09-19-dsh-mcp-startup-desktop.json). Both provider routes reject altered native MCP configuration before a model request, retain initialization evidence after failed service access, and obtain fresh receipts on native resume. The desktop fixture covers the generic Pi-AI route. The full OpenCode and Pi Electron lifecycles also passed; [regression records](probes/2026-09-19-dsh-mcp-report-regression.json) preserve their separate connection-status and unknown-evidence behavior. Changed-file formatting and whitespace checks passed.

```sh
AGENT_MATRIX_TEST_DSH=/absolute/path/to/dsh \
AGENT_MATRIX_HTTP_MCP_REPORT=/absolute/path/to/native-result \
npx vitest run --config vitest.dsh.config.ts --maxWorkers=1

AGENT_MATRIX_SESSION_ENGINE=dsh \
AGENT_MATRIX_TEST_DSH=/absolute/path/to/dsh \
AGENT_MATRIX_MCP_SCREENSHOT=/absolute/path/to/mcp-report \
AGENT_MATRIX_SESSION_REPORT=/absolute/path/to/desktop-result.json \
npm run test:sessions
```
