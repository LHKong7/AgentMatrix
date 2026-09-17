# DeepSeek Harness ACP lifecycle evidence

The selected integration route is **DSH 0.1.5-rc.2 with the shipped ACP profile**, using AgentMatrix's ACP v1 client and process supervisor. The SDK limitation recorded in the [initial probe](engine-probe-2026-09-18.md) still motivates this choice: the installed SDK lacks cancellation and resume operations. The local ACP lifecycle now passes on macOS arm64. DSH configuration/runtime adapters and the desktop launch path remain unimplemented.

## Version and provider boundaries

The [recorded result](probes/2026-09-18-dsh-acp.json) distinguishes the CLI/package release `0.1.5-rc.2` from ACP `agentInfo.version: 0.0.1`. It records versions and entry-file digests for the selected base, ACP, provider, prompt, persistence, filesystem-tool, and approval components. These fingerprints identify the tested files; they are not a complete dependency lock or a claim that every plugin in the composition has been audited.

Both provider paths pass independently:

| Selected component | Fixture configuration                                                                                         | Observed wire behavior                                                                                                     |
| ------------------ | ------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `dsh-llm-pi-ai`    | Custom route `agentmatrix-gateway`, `api: openai-completions`, `baseURL`, `apiKeyEnv`, explicit model catalog | Streamed Chat Completions at the configured endpoint, the exact synthetic bearer key, tool calls and retained tool results |
| `dsh-llm-deepseek` | Native route `deepseek-official`, `baseURL`, `apiKeyEnv`, explicit model catalog, thinking disabled           | The installed component also sends Chat Completions, with its own request preparation and provider-specific fields         |

The two rows are distinct native adapters even though this fixture exercises the same wire family. Do not infer Anthropic Messages, Responses, image handling, OAuth, or an actual DeepSeek service from these results. The [repository reference](https://github.com/deepseek-ai/deepseek-harness/blob/0d1f50007f9bca3f52b06e1c3074fa14d5fb0720/packages/llm/llm-deepseek/README.md) describes a Messages default and a protocol selector that are absent from the inspected installed component. Repository documentation and an installed npm artifact are not interchangeable version contracts. This probe and the initial adapter contract use the actual installed bytes and requests.

## Configuration composition

The probe starts from the published `dsh-base` and `dsh-acp-app` bundles. It creates separate profile, home, and per-launch patch files inside an isolated `DSH_HOME`. A CLI `--dump-config` readback confirms the final overlay wins and replaces the whole target row's `config`: a field supplied only by an earlier layer disappears. Generated patches must therefore restate fields they intend to preserve instead of assuming a nested merge.

`system-prompt` receives separate `personaPrefix` and `personaSuffix` values; both appear in actual provider requests. A live overlay edit leaves the running process's prompt unchanged; a subsequent process and new session use the edited value. The shipped profile declares `patchReload: startup`, and the probe checks both that declaration and the observed restart behavior.

This does not implement complete System Prompt replacement or prove that mutable settings cannot change a provider later. The native settings and credentials seams are separate from startup patch composition. The application adapter must capture selected sources, isolate mutable native state, validate effective routing, and reject incompatible reuse. Full-prompt replacement, Skills, MCP, and saved-profile translation remain separate adapter work.

## Observed runtime behavior

The [ACP reference](https://github.com/deepseek-ai/deepseek-harness/blob/0d1f50007f9bca3f52b06e1c3074fa14d5fb0720/packages/acp/acp/README.md) defines an automation surface with committed semantic messages and limited presentation features. Native tests confirm the following on each provider route:

- The model selector returns opaque values. Reading the current value and selecting it through `session/set_config_option` succeeds; the selected route then reaches the intended fixture.
- A real `read` result returns to the model. Under the fixture's read-only policy, an ordinary write is denied and an explicit wider retry requests one-shot approval. Selecting the offered allow option creates only the fixture file.
- Cancelling an active provider stream returns `cancelled`. A deliberately incomplete provider text chunk produces no ACP assistant message during the observation window. The adapter must present committed-message updates without claiming token-by-token streaming.
- Cancelling while approval is pending invalidates the request, settles the prompt as cancelled, and leaves the target file absent. Only the offered one-shot allow/reject choices are advertised in this composition.
- `session/close` preserves durable history. The session is listed after close and process restart; `session/resume` restores it and the next provider request includes the earlier file result. Resume emits no old assistant/tool replay. Application history must come from AgentMatrix's own journal.
- A synthetic provider rejection fails the correlated prompt with an engine error rather than returning a successful stop reason.
- Prompt responses omit token usage. Native `usage_update` messages describe context occupancy; they are not per-turn billable input/output totals. Unknown usage and cost must remain unknown in the shared session model.

The underlying filesystem approval policy is not a universal per-tool prompt. Native approval `never` means no interactive escalation, not permission to execute every operation. A future adapter must map requested execution policy explicitly. DSH-specific cards, terminals, elicitation, forks, and native transcript replay remain excluded from the selected ACP contract.

## Reproduce

Use the exact separate installation from the [initial probe instructions](engine-probe-2026-09-18.md):

```sh
AGENT_MATRIX_TEST_DSH=/absolute/path/to/dsh \
AGENT_MATRIX_DSH_REPORT=/absolute/path/to/report.json \
npm run probe:dsh
```

The test creates temporary home/config/project directories, disables native telemetry, supplies synthetic credentials only to child environments, and binds a local HTTP provider fixture. It checks both routes, file effects, both cancellation paths, source precedence, restart behavior, native restoration, and process-group cleanup. It never calls an external model provider or edits the user's DSH configuration. Report output is optional. Fixture files are removed after confirmed process cleanup and retained if cleanup fails.

The shared ACP client now exposes capability-checked session listing and typed config-option changes. Deterministic tests cover these methods separately from native fixtures. Passing this probe supplies the local ACP feasibility evidence for V4; V2, D1–D4, external endpoint/model/key acceptance, shared Skill/MCP mapping, and the cross-engine desktop scenario remain open.
