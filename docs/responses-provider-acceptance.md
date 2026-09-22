# OpenAI Responses across the three engines

Updated: **2026-09-19**. The production desktop session factory passes a local Responses protocol fixture with OpenCode 1.18.16, Pi 0.85.1 and DeepSeek Harness 0.1.5-rc.2 on macOS arm64. This adds native protocol evidence for the existing `openai-responses` configuration; it does not change the application's provider mappings or UI.

## Endpoint and engine scope

| Engine           | Native provider route               | Verified request      |
| ---------------- | ----------------------------------- | --------------------- |
| OpenCode 1.18.16 | `@ai-sdk/openai`, Responses         | `/proxy/v1/responses` |
| Pi 0.85.1        | `openai-responses`                  | `/proxy/v1/responses` |
| DSH 0.1.5-rc.2   | Pi-AI component, `openai-responses` | `/proxy/v1/responses` |

Each connection uses a versioned API base ending in `/proxy/v1/`, a selected Bearer credential, a literal header and a separately referenced secret header. The installed SDKs preserve the proxy prefix and append `/responses`. This evidence covers that base convention; it does not establish automatic `/v1` insertion for an unversioned root. DSH's separate native DeepSeek provider is outside this fixture.

The synthetic service implements the documented Responses [streaming lifecycle](https://developers.openai.com/api/docs/guides/streaming-responses), including text deltas and completion events. Its [function-call stream](https://developers.openai.com/api/docs/guides/function-calling) splits argument JSON across events and accepts the native client's subsequent `function_call_output` with the corresponding `call_id`.

## Verified behavior

The opt-in test uses the real installation probe, immutable run capture, desktop factory, native transport and runtime. It checks each pinned executable's reported version before continuing. All credentials and model names are synthetic; model requests target a temporary loopback service.

- Exact request path, selected model, Bearer key and both custom headers. An ambient `OPENAI_API_KEY` canary must not replace the selected credential.
- Replacement and appended Prompt markers in actual request input.
- Fragmented text, Unicode preservation and masking of known secrets split across text events.
- A real native file read requested through fragmented function arguments, a completed normalized tool event, and the file result in a subsequent provider request with the matching call ID.
- Cancellation during an unfinished stream, disposal of the original attachment, and restoration of the same native conversation with retained file context.
- HTTP 400 provider errors, HTTP 401 authentication failures and HTTP 404 from a fixture representing a Chat Completions-only gateway all produce failed turns. No request switches to `/chat/completions`.
- Known synthetic credentials absent from normalized runtime output, and identical immutable manifest bytes after all turns.

The [recorded three-case result](probes/2026-09-19-responses-provider-acceptance.json) contains 21 primary model requests. OpenCode also makes an auxiliary request. The combined provider suite includes the existing six [Anthropic Messages cases](anthropic-provider-acceptance.md), runs with one worker and passes all nine cases. TypeScript and ESLint checks pass. This change adds tests and documentation; no Electron UI behavior changes.

## Reproduction

```sh
AGENT_MATRIX_TEST_OPENCODE=/absolute/path/to/opencode \
AGENT_MATRIX_TEST_PI=/absolute/path/to/pi \
AGENT_MATRIX_TEST_DSH=/absolute/path/to/dsh \
AGENT_MATRIX_PROVIDER_REPORT=/absolute/path/to/result \
npm run probe:providers
```

Responses reports use `<prefix>.responses.<engine>.json`; Anthropic reports retain `<prefix>.<engine>.<endpoint-style>.json`. To run only Responses, append `-- tests/responses-provider-installed.probe.ts`. Missing executable variables skip the corresponding cases. Ordinary unit tests do not start these CLIs. Run native suites sequentially and wait for their processes to finish before starting another suite or rebuilding.

## Acceptance boundaries

The gateway rejection check exercises an explicit HTTP 404 response. It does not prove detection of every malformed HTTP 200 stream, a gateway that returns Chat Completions events on a Responses URL, or a stream that ends without its expected terminal event. Those cases, reasoning, images, OAuth, provider-managed conversation storage, all retry policies and other operating systems remain outside this evidence.

The fixture does not contact OpenAI or another external provider, measure model quality, audit native plaintext transcripts or establish full journal/export redaction. It therefore expands V2/X2 local protocol coverage without completing B7/C4/D4 or full X2/X3. Acceptance against the intended external endpoint, protocol, model and local credential reference remains pending.
