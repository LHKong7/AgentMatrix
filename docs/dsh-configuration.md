# DeepSeek Harness configuration adapter

AgentMatrix translates captured shared configuration into an application-owned profile for **DSH 0.1.5-rc.2 over ACP**. The installed CLI passes local provider, Prompt, directory Skill, MCP, and execution-policy fixtures on macOS arm64. This implements the configuration foundation for D1. The [runtime and desktop integration](dsh-runtime.md) now also passes local fixtures. External-provider acceptance and complete effective-configuration reporting remain open.

Selected native sources can now be copied into shared resources through the [DSH configuration importer](dsh-native-configuration-import.md). Import does not execute the CLI and does not imply complete native precedence.

## Composition and ownership

The adapter reads the installed `dsh-base` and `dsh-acp-app` bundles without importing their code into Electron. It preserves native JavaScript YAML tags as data during inspection. It pins the CLI and DSH component release, records component versions, and observes package manifests, bundle files, and compiled files under the selected components' `lib` directories. Component entry points become absolute file URLs. This prevents a profile-local package with the same name from silently replacing the selected entry point. Observations are rechecked when captured inputs are created and before reuse.

The generated profile captures the composed rows in one insert list, with an empty native bundle list and startup-only patch loading. Overrides restate the whole target row's configuration. Each run has a private `DSH_HOME` and separately retained native state. Application-owned profile files are seeded once and checked before reuse; changed, missing, or symlinked controls are rejected without overwriting them. Unexpected home-level patches, `.env`, or global instruction files are rejected. DSH may rewrite its generated root `cordis.yml`; that file is not the authoritative profile patch.

Native `--dump-config` must match the complete captured tree before launch. This command composes tagged YAML without evaluating it or activating plugins. Matching output proves composition, not that a provider, Skill, or MCP server ran. The separate native turn fixture supplies that evidence.

Settings and credential documents point to empty captured inputs, with native file watching disabled. Credentials are resolved immediately before launch through controlled environment references. Header and MCP values use application-generated native expressions to read those references; user text never becomes executable source. Telemetry and module reload are disabled. Arbitrary executable prefix arguments and external profile templates are rejected. Explicitly selected installed modules now use [native plugin rows and lifecycle checks](dsh-plugin-activation.md); general bundle patch import remains unsupported. No package manager runs and no user's native profile is modified.

The source record is **partial**. It is not a complete transitive dependency lock or an OS execution boundary. Project `.env` and baseline instruction files are observed, while nested project instructions can still be discovered dynamically after file operations. Native transcripts and other writable engine state remain separate from immutable application inputs.

## Model connections

| Shared protocol         | DSH component / route                                       | Authentication             | Evidence                                                           |
| ----------------------- | ----------------------------------------------------------- | -------------------------- | ------------------------------------------------------------------ |
| OpenAI Chat Completions | `dsh-llm-pi-ai`, private `agentmatrix-<connectionId>` route | Bearer reference           | Actual local provider, header, tool, and MCP calls                 |
| OpenAI Responses        | `dsh-llm-pi-ai`, `openai-responses` API                     | Bearer reference           | Mapping tests only                                                 |
| Anthropic Messages      | `dsh-llm-pi-ai`, `anthropic-messages` API                   | `x-api-key` reference      | Actual local Messages, header, tool, cancellation and resume calls |
| Gemini                  | `dsh-llm-pi-ai`, `google-generative-ai` API                 | `x-goog-api-key` reference | Mapping tests only                                                 |
| DeepSeek native         | `dsh-llm-deepseek`, `deepseek-official` route               | Bearer reference           | Actual local Chat Completions calls from this installed artifact   |

The separate [Anthropic Messages fixture](anthropic-provider-acceptance.md) verifies the shared root-or-`/v1` endpoint convention and this installed Pi-AI route. Existing captures retain their original native endpoint mappings.

Only the selected provider component is enabled. A supplied endpoint and model ID are required. Native DeepSeek stays distinct from the generic gateway route; the protocol observations from the [lifecycle probe](dsh-acp.md) still apply. Native DeepSeek permits `off`, `low`, `high`, and `max` reasoning settings in the mapping; provider-call evidence currently covers `off` only. Generic gateway reasoning beyond `off` and sampling settings are rejected because this adapter has no verified mapping for them.

Ordinary and secret headers are supported on the generic route. `User-Agent` is rejected because the native attribution layer replaces it. The native DeepSeek component has no accepted custom-header mapping in this revision. Engine login, cloud authentication, and keyless connections are not accepted. Native fallback context/output capacities remain unverified defaults; model pricing remains unknown.

## Prompts, Skills, and MCP

Shared appended instructions map to the native persona prefix or suffix, selected by **DSH instruction placement** in the English/Chinese editor. Native identity and guidance remain present. A shared replacement uses an application-owned component to register one native complete prompt section. It replaces core system guidance while retaining native runtime context and project instruction loading. More than one replacement is rejected. Shared additions precede or follow replacement text according to the same placement option.

Prompt contents become native variable values rather than templates. Literal `{{unknown}}`, `$HOME`, and similar user text remain literal because substituted values are not interpolated again. The managed component's JavaScript is fixed application code; captured user prompt text is configuration data. Tests verify both complete replacement and persona prefix/suffix behavior in provider requests, including unchanged original inputs after a shared Prompt edit.

Captured Skill directories retain `SKILL.md` and supporting files. Plain Markdown receives a generated native wrapper while the original asset bytes remain separately captured. Native names must be valid and unique. Only captured Skill roots are mounted; default user/project Skill discovery and watchers are disabled. The native fixture invokes the `skill` tool, then reads an actual captured reference file.

Each selected MCP definition becomes a separate pinned native MCP component with a stable application namespace. Stdio mappings include argv, cwd, ordinary environment, secret references, and a call timeout. Streamable HTTP maps headers and bearer references; [installed HTTP MCP fixtures](http-mcp-acceptance.md) now verify all three authentication modes, tool/error results and native restoration through both provider routes. Legacy SSE and OAuth fail explicitly. Initial connection failure blocks activation and automatic reconnect is disabled in this contract. The stdio fixture proves the exact cwd, literal argument, intended MCP credential, and absence of the provider credential from the MCP child environment.

## Execution policy

The application-owned component uses native tool dispatch hooks and guards:

| Shared choice        | Captured behavior                                                                                                                                               |
| -------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Ask for approval     | Native workspace-write boundary plus an approval decision for each model tool call that was not already denied. The fixture approves a normal read through ACP. |
| Deny tool execution  | A monotonic native guard denies tool bodies. The fixture deliberately asks the model to write a file and verifies it remains absent.                            |
| Allow tool execution | Native danger-full-access with no interactive escalation. The fixture invokes filesystem, Skill, and MCP tools.                                                 |

The native permission table exposes the one captured policy rather than incompatible shipped defaults. A `never` approval policy alone is not used as proof of denial. These controls govern model tool dispatch, not component startup or OS-wide confinement. The separate [installed plugin contract probe](dsh-plugin-contract.md) verifies native module shapes, configuration schemas, service injection, tools, disposal, and resume. It demonstrates that ACP initialization and session creation can precede plugin settlement. [Production selected-plugin activation](dsh-plugin-activation.md) therefore waits for native boot and checks current row/fiber/session identities before Ready, around turns, and on resume.

## Reproduce and remaining work

```sh
AGENT_MATRIX_TEST_DSH=/absolute/path/to/dsh \
AGENT_MATRIX_DSH_CONFIGURATION_REPORT=/absolute/path/to/configuration-report \
npx vitest run --config vitest.dsh.config.ts tests/dsh-configuration-installed.probe.ts
```

The optional report prefix produces separate `.pi-ai.json` and `.deepseek-native.json` files. The [generic-route record](probes/2026-09-18-dsh-configuration-pi-ai.json) and [native-route record](probes/2026-09-18-dsh-configuration-deepseek-native.json) identify the platform, release, and local evidence. Both use synthetic credentials and loopback fixtures; neither calls an external provider. The Electron configuration smoke separately checks English editing and persisted Chinese instruction-placement controls after restart. Unit tests cover invalid mappings, source-version mismatch, inert YAML expressions, prompt conflicts, duplicate Skills, and native control corruption.

D2/D3 now connect this adapter to the shared coordinator and desktop factory, check native model/session identity, retain committed-message semantics and unknown billing usage, and verify cancellation and resume through AgentMatrix's journal. ACP has no effective permission-policy selector to read back; policy evidence comes from captured composition/control checks and native behavioral fixtures. See [runtime evidence and limits](dsh-runtime.md). External provider acceptance, external MCP services/OAuth, broader plugin/bundle coverage, complete application reporting, and other platforms remain separate requirements. This configuration fixture does not pass D4.

New Skill-bearing compositions include an application-owned [Skill-source observer](dsh-skill-sources.md). It checks the selected entries in the current native Agent scope at runtime, separately from the composition dump. Capture still uses the pinned source inventory; no user plugin is required.
