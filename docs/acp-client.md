# ACP client infrastructure

The main-process client in `src/main/engines/acp/` uses the pinned official `@agentclientprotocol/sdk@1.4.0` for typed ACP requests, responses, and incoming method dispatch. AgentMatrix supports ACP v1 only in this module. The initialization response must select version 1; other versions close the connection. Client filesystem, terminal, terminal-authentication, and elicitation capabilities are omitted because their services are not implemented.

These choices follow the official [ACP v1 transport](https://agentclientprotocol.com/protocol/v1/transports) and [initialization](https://agentclientprotocol.com/protocol/v1/initialization) contracts. Advertised agent capabilities enable a method to be attempted; they do not establish successful runtime behavior. OpenCode and DeepSeek Harness use independent behavioral evidence; sharing ACP does not establish matching provider, prompt, permission, or persistence semantics.

## Transport and ordering

`boundedAcpStream` adapts byte streams to the SDK's v1 message stream. It accepts LF-delimited JSON-RPC records with strict UTF-8 decoding, including characters split across byte chunks. Input and output frames are limited to 1 MiB. It rejects invalid JSON, batch arrays, invalid envelopes, oversized frames, and an unterminated final message. The parser yields one message per pull; it does not silently skip invalid stdout or expose raw frame bytes in errors.

`AcpClient` correlates concurrent requests through the SDK and bounds outstanding requests. Every request has a deadline; a deadline closes the attachment and rejects pending work, rather than leaving an ambiguous request running on the same connection. Prompt deadlines are explicit caller inputs. No retry or resubmission is automatic. Error objects retain a stable category and, where available, a numeric RPC error code; native messages and error data are not copied into application errors.

Session updates enter a bounded FIFO callback queue. The caller can persist each update before acknowledging the callback. A prompt result waits for preceding updates to finish, so a turn-completion event can be appended after its streamed content. A callback failure, queue-count overflow, or byte-budget overflow closes the connection. Callbacks receive a cancellation signal; the coordinator must honor it and supervise any work it starts.

## Permissions and cancellation

Permission handling is scoped to an active prompt and native session ID. The transport accepts only an offered option ID, rejects ambiguous/oversized option sets, and bounds outstanding requests. Unknown sessions, requests arriving outside a turn or after cancellation, expired requests, invalid answers, and callback failures receive a cancelled outcome. The handler receives an abort signal for expiry, cancellation, or disconnect; a response that arrives after invalidation cannot authorize the tool.

Sending `session/cancel` invalidates pending permissions and sends the native notification. It does not mark the turn finished. Late output remains accepted until the engine's prompt response supplies the stop reason. The session coordinator still owns run/turn/request identities, persisted approval decisions, requested-policy mapping, and escalation when cancellation does not finish. ACP permissions do not by themselves provide a filesystem or network sandbox.

Load, resume, list, and close operations require the corresponding advertised capability. Config-option changes pass opaque selections through typed requests; the adapter must use the native option state rather than inventing a value. Native resume remains distinct from application event replay. The client receives byte streams; its [attachment wrapper](process-lifecycle.md) owns the CLI process group. OpenCode connects these mechanics to saved profiles, provider injection, durable sessions, and the desktop UI. DSH still needs its own configuration/runtime adapter and desktop wiring.

## Verification

Unit tests cover framing, split UTF-8, output bounds, invalid records, unsupported versions/services, out-of-order responses, update ordering, request/update/permission bounds, deadlines, redacted failures, permission invalidation, late output, and disconnects.

An opt-in installed-CLI check exercises this exact application client with isolated temporary configuration, no provider keys, no prompts, and no model calls:

```bash
AGENT_MATRIX_TEST_OPENCODE=/absolute/path/to/opencode \
AGENT_MATRIX_TEST_DSH=/absolute/path/to/dsh \
AGENT_MATRIX_ACP_REPORT=/tmp/agentmatrix-application-acp.json \
npm run probe:acp
```

Omitted executable variables skip that engine. The normal unit test command never launches an installed CLI. The explicit probe preserves system `HOME`, uses engine-specific/XDG temporary storage, disables OpenCode providers/plugins/updates, declines permissions, and closes the owned process group after initialization. It now exercises the production supervisor; separate real-subprocess fixtures cover resistant descendants. No engine tool execution or active-turn acceptance is implied.

On the development macOS arm64 host, application-client initialization passed for OpenCode 1.18.16 and the installed DeepSeek Harness 0.1.5-rc.2. DSH reports ACP component version 0.0.1; that is not its CLI package version. The [captured responses](probes/2026-09-18-application-acp.json) retain the distinction and record `modelCalls: false`. Subsequent [OpenCode](opencode-configuration.md) and [DSH](dsh-acp.md) fixtures verify their distinct local provider turns, tools, permissions, cancellation, and native restoration. External endpoint/model/key acceptance remains open.
