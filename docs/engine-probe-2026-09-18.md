# Initial installed-engine probes

Local date: **2026-09-18 (Asia/Seoul)**. Raw timestamps use UTC. Host: macOS arm64, Node 22.20.0. See the [captured responses](probes/2026-09-18-handshakes.json).

These checks made **no model calls**, received no provider keys, and do not establish full adapter compatibility. Engines used temporary working/configuration directories and a small environment allowlist. System `HOME` was preserved; engine-specific homes/XDG directories isolated generated state. Existing user configuration was not edited. Pi extensions/Skills/project resources were disabled for discovery; runtime resource loading still needs separate verification.

## Installations and results

| Engine           | Installed release and source                                                                                                                    | Observed result                                                                                                                                                                          | Still unverified                                                                                                                 |
| ---------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| OpenCode         | Existing `<user-home>/.opencode/bin/opencode`, **1.18.16**                                                                                      | ACP v1 initialization succeeded. The engine advertises load/resume/list/close/fork and HTTP/SSE MCP. Normal discovery cleanup terminated the process                                     | Actual turns, approvals, cancellation in flight, persistence, configuration precedence, MCP, Skills, and provider compatibility  |
| Pi               | Official npm `@earendil-works/pi-coding-agent@0.85.1`, installed under `/private/tmp/agentmatrix-engine-probes` with lifecycle scripts disabled | RPC `get_state`, `new_session`, and idle `abort` returned success. No provider/model was configured; its placeholder model is unknown                                                    | Streaming, tool execution, cancellation during a turn, saved-session restoration, trust/resource loading, and actual model calls |
| DeepSeek Harness | Official npm `@deepseek-ai/dsh@0.1.5-rc.2`, same isolated installation                                                                          | SDK initialized as `deepseek-harness-sdk-runtime` wire version **0.0.1**; ACP v1 also initialized. SDK rejected cancel and resume methods; ACP advertises close/list/resume and HTTP MCP | Runtime turns, permission flow, cancellation in flight, persistence, profile/patch precedence, MCP/Skills, and provider routes   |

The OpenCode ACP process starts a local service. A sandboxed launch failed with `ServeError`; a launch permitted to bind its local port succeeded. This is a host execution restriction, not evidence that OpenCode lacks ACP. Windows and Linux were not probed. Credential encryption and actual filesystem/network sandbox enforcement have not been verified.

## DSH transport decision

The shipped `@deepseek-ai/dsh-sdk-protocol` request map and `dsh-sdk-jsonrpc-server` request dispatcher expose only `initialize`, `session/prompt`, and `shutdown`. Actual requests to `session/cancel` and `session/resume` returned JSON-RPC error `-32603` with an unknown-method message. SDK package version and wire `serverInfo.version` are different identifiers and must both be recorded.

**Initial adapter decision: use `dsh --profile acp` for this release.** Its advertised session capabilities align better with the planned controls, but advertising is not successful behavioral testing. Reuse the ACP transport while keeping DSH configuration, event normalization, permission semantics, and persistence separate from OpenCode.

The reduced scope explicitly excludes DSH-specific cards, terminal interaction, elicitation, forks, and native transcript replay described as unavailable in the [pinned ACP reference](https://github.com/deepseek-ai/deepseek-harness/blob/0d1f50007f9bca3f52b06e1c3074fa14d5fb0720/packages/acp/acp/README.md). AgentMatrix may display its own retained event history; it must not claim that history came from native replay. SDK support is deferred until its contract can satisfy the required controls or a separate documented use case is implemented.

## Reproducing discovery

Install the exact probe versions outside the application dependency tree:

```bash
npm install --prefix /private/tmp/agentmatrix-engine-probes --ignore-scripts --no-audit --no-fund --save-exact @earendil-works/pi-coding-agent@0.85.1 @deepseek-ai/dsh@0.1.5-rc.2
node scripts/probe-engines.mjs \
  --pi=/private/tmp/agentmatrix-engine-probes/node_modules/.bin/pi \
  --dsh=/private/tmp/agentmatrix-engine-probes/node_modules/.bin/dsh \
  --output=/private/tmp/agentmatrix-engine-probe.json
```

The script resolves OpenCode from `PATH`, or accepts `--opencode=/absolute/path`. It does not install software or send prompts. It records missing executables and failures instead of calling them compatible. It cleans up its generated configuration directories; the explicitly installed probe packages remain available for subsequent integration checks. The checked-in report redacts the user's home prefix.

## Remaining evidence

- V1: version/entry-point discovery is partial; native source precedence, prompt mappings, and directories still need adapter-specific probes.
- V2: awaiting the selected service/model and local credential reference for actual streaming/tool calls. Synthetic or local protocol fixtures cannot pass this gate.
- V3: macOS process startup/cleanup observed; secure storage, descendant cleanup under active work, and execution boundaries remain open. Other platforms are untested.
- V4: SDK limitation and initial ACP selection established; DSH's full runtime acceptance remains open.
- V5: Pi empty-session RPC observed; prompt/event/cancellation/persistence behavior still needs verification.

Official entry points: [OpenCode ACP](https://opencode.ai/docs/acp/), [Pi repository](https://github.com/earendil-works/pi), and [DeepSeek Harness repository](https://github.com/deepseek-ai/deepseek-harness). Published package files were also inspected locally; repository descriptions alone were not used to mark runtime checks as passed.
