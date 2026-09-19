# HTTP MCP acceptance

The shared MCP configuration now has installed-release Streamable HTTP evidence for **OpenCode 1.18.16** and **DeepSeek Harness 0.1.5-rc.2**, using both DSH provider routes. These checks exercise the production capture planners and ACP runtime adapters against local synthetic model and MCP services. They extend A4/X2 acceptance without passing a delivery gate. The subsequent [OpenCode runtime observation](opencode-mcp-status.md) adds per-service attachment receipts and bilingual reporting.

## Verified contract

| Behavior                                                                       | OpenCode                                                             | DSH through Pi-AI | DSH through native DeepSeek |
| ------------------------------------------------------------------------------ | -------------------------------------------------------------------- | ----------------- | --------------------------- |
| Bearer reference plus secret header                                            | Pass                                                                 | Pass              | Pass                        |
| Secret header without Bearer authentication                                    | Pass                                                                 | Pass              | Pass                        |
| No authentication                                                              | Pass                                                                 | Pass              | Pass                        |
| Ordinary header containing literal shell/template syntax                       | Preserved                                                            | Preserved         | Preserved                   |
| JSON and SSE responses on Streamable HTTP                                      | Pass                                                                 | Pass              | Pass                        |
| Initialization, session ID and negotiated protocol header                      | Pass                                                                 | Pass              | Pass                        |
| Tool discovery, model-requested execution and result in the next model request | Pass                                                                 | Pass              | Pass                        |
| Tool `isError` result and JSON-RPC error                                       | Failed tool update; next model request receives the error            | Same              | Same                        |
| HTTP 401 with OAuth disabled                                                   | Native MCP status `failed`; conversation can run without those tools | Startup rejected  | Startup rejected            |
| Initial `tools/list` error                                                     | Native MCP status `failed`; conversation can run without those tools | Startup rejected  | Startup rejected            |
| Native conversation restoration after MCP recovery                             | Pass                                                                 | Pass              | Pass                        |

Each route uses three separately named MCP services, verifies their intended authorization/header values, executes eleven tool calls across successful, error and restored turns, and preserves the captured input digest. Rejected cases must actually reach the MCP service, must not execute a tool, and must make no provider request during connection. The OpenCode case then submits a separate prompt and checks that unavailable MCP tools are absent from the model's tool list. Failure recovery restores the original native conversation and successfully calls the tools again.

The fixture negotiates MCP **2025-06-18**. It verifies `Mcp-Session-Id`, `MCP-Protocol-Version`, POST content/accept headers, initialized notifications, and both allowed response encodings. GET and DELETE return 405. SSE response encoding here belongs to Streamable HTTP; it is not evidence for the deprecated HTTP+SSE transport. These expectations follow the [MCP transport specification](https://modelcontextprotocol.io/specification/2025-06-18/basic/transports).

OpenCode's [pinned native client](https://github.com/anomalyco/opencode/blob/v1.18.16/packages/opencode/src/mcp/index.ts) tries Streamable HTTP and may fall back to SSE. Its native remote configuration does not force either transport. AgentMatrix continues to reject an explicit `legacy-sse` requirement. The passing local fixture proves Streamable HTTP was used for these endpoints; it does not establish transport enforcement for arbitrary servers.

DSH maps each selected definition to the pinned `dsh-mcp-client` component, sets `failOnStartupError: true`, and disables automatic reconnect. Native source inspection and both installed routes confirm the startup failure behavior above. Recovery is verified by starting a new process through native conversation resume; reconnection inside a still-running process is not claimed.

## Credentials and evidence scope

MCP credentials and provider authorization are distinct synthetic values. The fixture checks that provider request headers exclude MCP credentials and MCP request headers exclude the provider credential. Captured manifests and generated input files contain references, never these values. Deliberately secret-bearing tool errors must be redacted from normalized runtime output.

That authorization separation concerns request headers. Native engines can forward MCP tool content, including an error message, to their model service. This fixture does not establish outbound model-payload filtering. It also does not exercise the credential vault UI or create new encrypted storage behavior.

The OpenCode probe reads `/mcp` through the existing authenticated, owned ACP listener to establish native status. The original probe read was fixture-only. The subsequent [runtime observer](opencode-mcp-status.md) now persists selected-server status at attachment; older reports and DSH connectivity remain unknown without their own receipt. A Ready conversation is not evidence that all selected MCP servers connected. DSH startup rejection is presently a general runtime failure, not a dedicated per-server authentication diagnostic.

Pi core continues to reject MCP bindings, including HTTP definitions. No extension is selected implicitly. DSH rejects OAuth and legacy SSE before launch. OpenCode can map engine-owned OAuth scopes, but browser login, registration, token persistence/refresh and authenticated OAuth tool calls remain unverified. External servers, TLS/proxies, timeout enforcement, mid-turn disconnections, legacy SSE negotiation, DSH per-server runtime receipts and other platforms remain separate acceptance work.

## Reproduction and records

The fixture is included in both engine probe configurations and runs only cases with an explicit executable. Use both variables to run all three routes serially:

```sh
AGENT_MATRIX_TEST_OPENCODE=/absolute/path/to/opencode \
AGENT_MATRIX_TEST_DSH=/absolute/path/to/dsh \
AGENT_MATRIX_HTTP_MCP_REPORT=/absolute/path/to/result-prefix \
npx vitest run --config vitest.opencode.config.ts tests/mcp-http-installed.probe.ts --maxWorkers=1
```

The prefix produces `.opencode.json`, `.dsh-pi-ai.json` and `.dsh-deepseek-native.json` reports. Tests use temporary project/home/state directories and loopback services, synthetic credentials, disabled OpenCode model fetching/default plugins, no external model/MCP calls, and confirmed native process disposal before removing files.

Recorded on **2026-09-19, macOS arm64**: [OpenCode](probes/2026-09-19-http-mcp.opencode.json), [DSH Pi-AI](probes/2026-09-19-http-mcp.dsh-pi-ai.json), and [DSH native DeepSeek](probes/2026-09-19-http-mcp.dsh-deepseek-native.json). The source fixtures are [the native acceptance probe](../tests/mcp-http-installed.probe.ts) and [the bounded HTTP MCP peer](../tests/helpers/http-mcp-fixture.ts).

All three installed-engine cases pass, including **33 MCP tool calls**. The regular suite passes **781 tests across 53 files**, with added rejection assertions for DSH OAuth and Pi HTTP bindings. TypeScript, ESLint, formatting and whitespace checks pass. Production runtime/UI code is unchanged in this increment; no new Electron lifecycle result is claimed.
