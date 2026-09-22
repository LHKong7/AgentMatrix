# OpenCode plugin lifecycle contract

This is installed-release evidence for the selected-plugin work in A6/B3, using **OpenCode 1.18.16 on macOS arm64**. The fixture adds native plugin declarations directly to generated inputs. The subsequent [production activation implementation and its separate evidence](opencode-plugin-activation.md) cover normal AgentMatrix ESM plugin bindings.

The [recorded result](probes/2026-09-18-opencode-plugin-contract.json) comes from `tests/opencode-plugin-installed.probe.ts`. The test uses the production OpenCode runtime, a temporary project/home/config, local fixture modules, and a local synthetic Chat Completions endpoint. It exercises startup, a streamed response, native resume in a new process, and pure mode. Native startup may maintain OpenCode's own SDK dependencies; the result does not claim zero registry traffic or external-provider acceptance.

## Observed behavior

| Case                                                                         | Installed-release result                                                                                     | Adapter implication                                                                                    |
| ---------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------ |
| Legacy module with two initializers and an alias                             | Both initializers run in order; the alias does not run the same initializer twice within one instance        | Preserve export identity, order, and separate hook objects                                             |
| Package server export with a relative TypeScript dependency                  | The server export wins over `main`; the dependency loads; unrelated named exports on a V1 module are ignored | Do not flatten V1 and legacy module shapes into one generic initializer                                |
| Native tuple options                                                         | Both V1 and legacy initializers receive their configured options                                             | Preserve native options without treating them as plugin identity                                       |
| System hooks                                                                 | Ordered markers reach the local model request                                                                | Actual hook output provides stronger evidence than config readback                                     |
| Package declares `engines.opencode >=999.0.0`                                | The local package still initializes and changes the system prompt under 1.18.16                              | A local declaration requires an AgentMatrix range check                                                |
| Import, initialization, config-hook failure, and missing relative dependency | The native session can still become ready; other plugins still run                                           | A successful ACP acknowledgment cannot establish that each selected plugin initialized                 |
| `debug config`                                                               | Executes initializers in its own process                                                                     | A readback-process receipt must not count as session activation                                        |
| ACP startup and resume                                                       | Each fixture plugin initializes twice in the same ACP process; the first model turn uses the second cycle    | PID alone is insufficient: track the active instance lifetime and invalidate disposed/failed instances |
| Pure mode                                                                    | Config readback retains the declarations while external hooks do not run                                     | Diagnose pure mode before promising plugin activation                                                  |
| Owned-process termination                                                    | No additional plugin dispose callbacks were observed after termination in this fixture                       | Parent-owned process cleanup must not rely on a plugin dispose callback                                |

The pinned [loader](https://github.com/anomalyco/opencode/blob/v1.18.16/packages/opencode/src/plugin/loader.ts) distinguishes local and package-manager sources and drops failed loads. The [plugin lifecycle](https://github.com/anomalyco/opencode/blob/v1.18.16/packages/opencode/src/plugin/index.ts) handles V1 versus legacy exports, config hooks, and per-instance disposal. The test checks these behaviors at the installed CLI boundary rather than inferring successful activation from these sources alone.

## Requirements established by this probe

Activation evidence must identify the requested binding, captured source/version, current attachment, and current native instance. It must survive neither an instance disposal nor a later failed initialization, and must be regenerated when resuming a native conversation. All required initializers and config hooks must finish successfully before the adapter reports the binding as verified. The current fixture's two cycles are an observation, not a count that the production verifier should hardcode. Neither cycle emitted a dispose receipt before readiness, so absence of disposal cannot identify the active one.

The fixture also writes a distinct instance marker into the generated native agent's in-memory description during its config hook. Real new-session and resume replies expose the current marker and exclude stale process/instance markers. The first turn's hook receipts correspond to that current cycle. This establishes an available route for associating a future bridge's receipts with the native session acknowledgment. An adapter implementation still needs nonce validation, binding/source checks, and a way to preserve existing descriptions; this fixture does not install such a bridge.

A bridge must preserve alias deduplication, multiple legacy initializers, V1 behavior, options, hook order, and separate tool/auth hook objects. Combining arbitrary hook objects into one would change native semantics. Any unsupported export or dependency form needs an explicit diagnostic. The bridge must not import selected code into Electron while preparing or inspecting a draft.

The subsequent activation implementation adds nonce/binding checks, description preservation, source revalidation, and instance-specific lifecycle receipts. The later [OpenCode options implementation](opencode-plugin-options.md) adds native tuple editing and capture/resume checks. Pi and DSH have separate activation contracts. CommonJS/export-star coverage and complete dependency provenance remain open. The generic native probe above intentionally remains independent of that production verifier.

## Reproduce

```bash
AGENT_MATRIX_TEST_OPENCODE=/absolute/path/to/opencode \
AGENT_MATRIX_OPENCODE_PLUGIN_REPORT=/absolute/path/to/result.json \
npx vitest run --config vitest.opencode.config.ts tests/opencode-plugin-installed.probe.ts
```

`npm run probe:opencode` includes this contract test alongside the existing configuration/runtime probe. Both are opt-in and require the pinned installed CLI. Ordinary unit tests do not launch it.
