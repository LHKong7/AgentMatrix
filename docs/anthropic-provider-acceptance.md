# Anthropic Messages across the three engines

Updated: **2026-09-19**. OpenCode 1.18.16, Pi 0.85.1 and DeepSeek Harness 0.1.5-rc.2 now pass the production desktop session factory against a local Anthropic Messages fixture on macOS arm64. The fixture reproduced a shared-endpoint bug before the fix: a `/proxy/v1` connection worked in OpenCode but produced a duplicated `/v1/v1/messages` path in Pi and failed in DSH. Passing the same literal base URL to different SDKs did not give the connection a consistent meaning.

## Shared endpoint contract

For `anthropic-messages`, enter either the provider root or its `/v1` API base, including any proxy path prefix. Both `https://gateway.example/proxy` and `https://gateway.example/proxy/v1/` now produce this mapping:

| Engine                        | Generated native base              | Native request target                       |
| ----------------------------- | ---------------------------------- | ------------------------------------------- |
| OpenCode                      | `https://gateway.example/proxy/v1` | `https://gateway.example/proxy/v1/messages` |
| Pi                            | `https://gateway.example/proxy`    | `https://gateway.example/proxy/v1/messages` |
| DSH, Pi-AI provider component | `https://gateway.example/proxy`    | `https://gateway.example/proxy/v1/messages` |

The shared helper preserves the proxy prefix and encoded path components, normalizes trailing slashes, and accounts for the different native suffixes. HTTP and HTTPS are accepted. A full `/messages` URL, URL credentials, query parameters or fragments receive a safe connection diagnostic before launch. The editor explains the convention in English and Simplified Chinese. Other protocols retain their existing endpoint mappings.

This convention applies when creating new captures, including captures from previously saved connections. Old immutable captures keep their original native files, request semantics and digests; they are not repaired automatically. Pi records its generated base in new `pi-mappings.json` files so native readback can distinguish it from the literal base used by older captures. A new conversation is necessary to apply the fix. Review older custom connections that deliberately relied on nonstandard targets: an OpenCode base `/proxy` previously targeted `/proxy/messages`, whereas new captures target `/proxy/v1/messages`. No workspace-wide URL migration is performed.

## Native import preserves request meaning

Native import translates SDK-specific bases into the shared convention instead of merely copying the string. A Pi/DSH native base `/proxy` becomes shared `/proxy/v1`, then maps back to `/proxy` at launch. If the native base already ends in `/v1`, the imported shared value ends in `/v1/v1`; this deliberately preserves the original doubled request path rather than silently correcting the imported source.

An OpenCode native base ending in `/v1` is representable directly. Other native bases cannot preserve their exact `/messages` target under this shared convention, so the imported connection has an unresolved endpoint and an `invalid-value` diagnostic. Exact source bytes remain in the existing encrypted import archive. Import does not contact a provider, and successful conversion does not verify the endpoint. Unit tests cover actual Pi, DSH and OpenCode import planners and subsequent endpoint mapping.

## Installed-engine verification

The opt-in fixture runs six cases: each of the three installed engines with a root base and with a versioned base. It starts a temporary loopback HTTP service, captures ordinary application run inputs, and uses the real installation probe, session factory, native transport and runtime. Each case checks:

- The exact `/proxy/v1/messages` path, selected model, `x-api-key`, Anthropic version, literal header and separately referenced secret header. An ambient `ANTHROPIC_API_KEY` canary must not replace the selected key.
- Replacement and appended Prompt markers in actual requests.
- SSE text and split JSON tool arguments, a real native file read, and its result in the next Messages request.
- Cancellation during an unfinished response, process disposal, and restoration of the same native conversation with retained file context.
- HTTP 400 provider rejection and HTTP 401 authentication failure producing failed turns.
- Known synthetic secrets masked in normalized runtime output, Unicode text preserved, and unchanged manifest bytes.

The synthetic stream follows Anthropic's documented [streaming event sequence and incremental tool input](https://platform.claude.com/docs/en/build-with-claude/streaming). The fixture supplies a `tool_use` block and checks the engine's subsequent `tool_result` according to the [tool-use contract](https://platform.claude.com/docs/en/agents-and-tools/tool-use/define-tools). This verifies the installed clients against a controlled protocol service; it does not exercise Anthropic's external API.

```sh
AGENT_MATRIX_TEST_OPENCODE=/absolute/path/to/opencode \
AGENT_MATRIX_TEST_PI=/absolute/path/to/pi \
AGENT_MATRIX_TEST_DSH=/absolute/path/to/dsh \
AGENT_MATRIX_PROVIDER_REPORT=/absolute/path/to/result \
npm run probe:providers
```

The report prefix produces one JSON file per engine and endpoint style. Missing executable variables skip the corresponding cases; ordinary unit tests never launch these CLIs. The [recorded six-case result](probes/2026-09-19-anthropic-provider-acceptance.json) contains 36 primary model requests; OpenCode also makes auxiliary requests. All calls use synthetic credentials and a synthetic model, with no external provider calls.

The full unit suite passed 875 tests across 58 files, including old/new Pi readback and import compatibility. ESLint, TypeScript and production builds passed. The real Electron configuration smoke verifies both localized hints while retaining its existing configuration, migration and credential checks; both language screenshots were visually inspected.

## Acceptance boundaries

DSH evidence covers its Pi-AI provider component, not the separate native DeepSeek component. The fixture proves selected authentication, text/tool turns, cancellation and native restoration for the listed releases. It does not establish real model capacity, external gateway compatibility, reasoning, images, OAuth, caching, all error/retry variants, other operating systems or another engine release. This runtime fixture does not by itself audit native plaintext transcripts, every stderr path, journal persistence or exports; the separate [credential-history fixture](credential-redaction-history.md) has its own scope.

V2 still requires the intended external endpoint, protocol, model and a local credential reference. B7/C4/D4, full X2 and X3 remain open. The new evidence expands local protocol coverage without claiming those delivery gates are complete.
