# DeepSeek Harness runtime and desktop sessions

AgentMatrix now runs **DSH 0.1.5-rc.2 over ACP** from saved profiles. The production desktop factory, runtime, coordinator, and journal pass two installed-CLI fixtures on macOS arm64: the generic `dsh-llm-pi-ai` route and the separate `dsh-llm-deepseek` route. A real Electron fixture also passes the generic route in English and Chinese. DSH remains labeled experimental.

## Launch and native readback

The explicit installation check records the CLI release and enables ACP only for the pinned version. Creating a session captures the [managed composition](dsh-configuration.md), shared assets, source observations, and secret references. Each session owns its DSH home and mutable native history. The runtime verifies the executable release and exact native composition dump before starting the ACP process.

The ACP component identifies itself as `deepseek-harness-acp` version **0.0.1**. This is checked separately from the CLI release. Session creation or restoration must acknowledge a valid native UUID and report the selected model route. In this pinned artifact the opaque model selector encodes a JSON tuple containing the complete provider/model pair. The adapter validates that tuple and passes the native selector back unchanged. It checks native DeepSeek reasoning when advertised. Source/input integrity, private-home controls, and the selected model are checked before Ready and before each turn. Unexpected model-option updates close the attachment.

ACP exposes no effective permission-policy readback in this release. The application verifies the captured policy components and their immutable controls; native ask/deny enforcement is supported by the separate configuration fixture and the runtime approval fixture. The model selector does not prove an OS sandbox, arbitrary plugin safety, or complete effective configuration. Component startup can execute code independently of model-tool dispatch. Native MCP/Skill component inspection and invocation evidence remain in the configuration adapter record.

## Turns, permissions, and failure

- ACP emits committed assistant/reasoning messages and tool lifecycle updates. Provider token deltas are not forwarded while an incomplete response is still streaming. The desktop hint makes this behavior explicit.
- Tool calls and native permission requests use the shared journal and correlated interaction contract. A reply is durable before it reaches DSH; missing, expired, or cancelled controls never grant permission.
- Cancelling during input checks prevents later prompt submission. Once submitted, cancellation waits for the native terminal response; the coordinator escalates an unresponsive cancellation to owned-process cleanup.
- Provider rejection is a failed runtime operation. The coordinator records failure and closes the attachment. It is not converted into a successful turn or an idle Ready state.
- DSH's `usage_update` describes context occupancy. It is not interpreted as billed input/output tokens or cost. This adapter leaves billing usage unknown; it does not currently render a separate context-occupancy meter.
- Application output and journals redact known injected credentials, including credentials split across provider chunks. Native engine history remains outside this redaction guarantee.

## Persistence and recovery

The application journal supplies visible history after renderer reload or process restart. DSH resume restores the exact native ID in the same captured home and working directory; it does not replay historical messages over ACP. AgentMatrix neither resubmits journaled messages nor creates a replacement conversation when restoration fails. Native restoration retains the prior file-tool result, verified in both routes.

Editing shared Prompt assets affects newly captured sessions. Existing sessions and resumed conversations retain their original inputs. App quit waits for process cleanup and marks sessions interrupted. The explicit Close action ends the application conversation after cleanup; durable native state is retained with its run inputs.

DSH cards, terminal interaction, elicitation, forks, native transcript replay, SDK parity, and arbitrary native plugins are outside this adapter's accepted runtime surface. The UI exposes the supported ACP profile and diagnoses incompatible templates/settings at launch. The [installed plugin contract](dsh-plugin-contract.md) now provides evidence for future selected-plugin support, including a startup race: an ACP session can exist before all native components finish loading. Native boot completion and ongoing plugin lifecycle checks remain required.

## Verification

```sh
AGENT_MATRIX_TEST_DSH=/absolute/path/to/dsh \
AGENT_MATRIX_DSH_RUNTIME_REPORT=/absolute/path/to/runtime-report \
npx vitest run --config vitest.dsh.config.ts tests/dsh-runtime-installed.probe.ts

AGENT_MATRIX_SESSION_ENGINE=dsh \
AGENT_MATRIX_TEST_DSH=/absolute/path/to/dsh \
AGENT_MATRIX_SESSION_REPORT=/absolute/path/to/desktop-report.json \
npm run test:sessions
```

The optional runtime report prefix produces `.pi-ai.json` and `.deepseek-native.json`. The [generic runtime record](probes/2026-09-18-dsh-runtime-pi-ai.json) and [native DeepSeek runtime record](probes/2026-09-18-dsh-runtime-deepseek-native.json) cover desktop-factory capture and connection, version/model checks, committed messages/tools, permission replies, both cancellation paths, command deduplication, split-key redaction, restart/resume with tool context, no transcript duplication, provider rejection, and unknown billing usage. Deterministic tests cover version/route drift, malformed native IDs, failed restoration, changed controls/sources, cancellation during preflight, terminal-response ordering, timeouts, and owner shutdown.

The [Electron record](probes/2026-09-18-dsh-desktop-sessions.json) covers installation probing, profile launch, native tools and approvals, literal rendering of HTML-like output, renderer reload without another request, cancellation, shared-Prompt edits with old/new inputs, app quit/restart, native resume, Close, bilingual controls, and journal redaction. All fixtures use synthetic credentials and isolated local HTTP providers. No external model service is called.

This implements the local D2/D3 runtime and desktop path. It does not pass D4: intended external endpoint/model/auth acceptance, complete effective-configuration reporting, the combined cross-engine asset-update scenario, selected native plugins, remote MCP, and platform coverage beyond macOS remain open.
