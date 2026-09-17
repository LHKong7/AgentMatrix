# Pi configuration adapter

AgentMatrix now translates resolved agent profiles into captured inputs for **Pi 0.85.1 / RPC**. A native fixture passes on macOS arm64 using the installed CLI, the application configuration adapter, process supervisor, and RPC client. This completes a usable configuration foundation for C1; Pi session coordination and desktop execution remain pending. The configuration editor already exposes the additional options in English and Chinese.

## Connections and native readback

Each snapshot selects a private provider named `agentmatrix-<connectionId>` and the requested model ID. Native API mappings follow the pinned [custom-model contract](https://github.com/earendil-works/pi/blob/v0.85.1/packages/coding-agent/docs/models.md):

| Shared protocol         | Native API             | Accepted authentication    | Sampling parameters                                    |
| ----------------------- | ---------------------- | -------------------------- | ------------------------------------------------------ |
| OpenAI Chat Completions | `openai-completions`   | Bearer reference           | `temperature`, `top_p` through native `samplingParams` |
| OpenAI Responses        | `openai-responses`     | Bearer reference           | Same native sampling mapping                           |
| Anthropic Messages      | `anthropic-messages`   | `x-api-key` reference      | Explicit sampling currently rejected                   |
| Gemini                  | `google-generative-ai` | `x-goog-api-key` reference | Explicit sampling currently rejected                   |

Only the Chat Completions row has native provider-call evidence in this fixture. The other rows have mapping tests, not endpoint acceptance. OAuth, keyless routes, arbitrary authentication headers, and other APIs fail with a configuration diagnostic. No API translation is performed. Model context limits and cost metadata currently use Pi's native custom-model defaults; these defaults are not verified model capacity or billable pricing. The future runtime must leave unverified cost unknown.

Saved files contain environment references for credentials and secret headers. Main-process launch preparation resolves those references and passes their values in the child environment. Keys never enter generated files or command arguments. Pi's leading `!` command syntax and `$` interpolation are escaped in ordinary header values; the real fixture verifies literal values and synthetic secret headers on the wire.

Shared reasoning and Pi-specific thinking levels must agree if both are set. Invalid levels fail before launch. Native readback checks the selected provider, model ID, API, endpoint, effective thinking level, idle/compaction state, and exact discovered Skill command names. It rejects discrepancies rather than accepting a matching model label alone. This readback does not expose credential-bearing native model objects to the renderer.

## Inputs and writable native state

The normal run store captures prompts, complete Skill directories, native templates, mappings, executable identity, and observed source digests. Every run has independent `inputs/` and `state/` directories. `PI_CODING_AGENT_DIR` points to `state/pi`, while an explicit session directory retains native conversations separately.

The launcher initializes `models.json`, `settings.json`, empty authentication state, and an empty trust store from the captured templates. An initialization marker distinguishes first setup from reuse. Later starts check these files instead of overwriting them; changed or deleted controls, symlinks, and unexpected native instruction files fail. The fixture confirms that ordinary Pi execution leaves these controls compatible. Global user configuration and unrelated trust decisions are not rewritten or imported implicitly.

This is input verification, not an operating-system sandbox. A future connected runtime must check captured and native controls at appropriate lifecycle boundaries and validate the native session identity before offering resume. Directory and executable digests do not freeze the entire installed npm dependency graph.

## Prompt, context, trust, and execution choices

- A replacement binding becomes `--system-prompt <captured-file>`. Append and project-rule bindings become ordered append files scoped to the selected working directory. Pi still appends enabled context, Skill descriptions, and cwd to its core prompt; replacement does not mean exclusive control of the final system message.
- `projectTrust: deny` is the default and maps to `--no-approve`. `trust-once` uses `--approve` for that launch without saving a global trust decision. Trusted project `SYSTEM.md` can supply the core prompt when no replacement is bound. A trusted `APPEND_SYSTEM.md` remains before shared append files when explicit CLI append flags suppress native discovery.
- `contextFiles: inherit` preserves native ancestor context discovery; `ignore` uses `--no-context-files`. Pi checks ancestor AGENTS/CLAUDE candidates up to the filesystem root, independently of project trust. Known candidates and project settings/prompt files are observed and rechecked. Coverage stays partial, including worktree discovery and native project settings effects; a source edit invalidates reuse of that snapshot.
- `unrestricted` keeps native tools. `deny` uses `--no-tools`; the fixture verifies no tools are offered to the model. `ask` is rejected because Pi core cannot enforce universal per-tool approval. Project trust and extension dialogs do not implement this missing policy, and no choice claims filesystem/network confinement.

Discovered extensions, prompt templates, themes, and Skills are disabled. Explicitly selected shared Skills remain loadable with `--no-skills --skill <entry>`, which is verified on the pinned installation. `--offline` disables native background update behavior; it does not prevent the explicitly configured model request. MCP bindings and native plugin activation remain unsupported until a compatible extension has separate acceptance evidence.

## Skill mapping and evidence

Directory Skills retain frontmatter, reference files, scripts, and executable flags in the snapshot. Native names must be valid and unique. Plain Markdown receives a generated native wrapper while its original captured content remains unchanged. Each CLI path selects the actual `SKILL.md` entry, avoiding implicit discovery of nested or unrelated Skills. The native [Skill contract](https://github.com/earendil-works/pi/blob/v0.85.1/packages/coding-agent/docs/skills.md) supplies the loading format; successful command discovery alone is not treated as tool execution.

The [recorded fixture](probes/2026-09-18-pi-configuration.json) verifies replacement/append instructions, native project append preservation, ancestor context inclusion/exclusion, two shared Skill forms, actual reads of a directory Skill and its reference file, custom endpoint/key/headers, sampling, denied tools, disabled unselected resources, and unchanged unrelated trust state. Editing a shared prompt produces a new snapshot; rerunning the old one still sends its old instructions. This is a new conversation using old inputs, not a native resume test. Native restoration remains covered separately by the [RPC lifecycle fixture](pi-rpc.md).

```sh
AGENT_MATRIX_TEST_PI=/absolute/path/to/pi \
AGENT_MATRIX_PI_CONFIGURATION_REPORT=/absolute/path/to/configuration-report.json \
npm run probe:pi
```

The command now runs both Pi fixtures. Report output is optional. Each fixture uses synthetic credentials, temporary data, and a local provider. Normal unit tests do not launch an installed CLI. The Electron configuration smoke additionally verifies saved trust/context/thinking choices after restart in Chinese, following English editing. Shared runtime event/interaction normalization, desktop session launch, external-service acceptance, and other platforms are still open.
