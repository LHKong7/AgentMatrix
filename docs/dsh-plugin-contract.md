# Installed DSH plugin contract

The opt-in fixture verifies the installed **DeepSeek Harness 0.1.5-rc.2** plugin lifecycle on macOS arm64. It uses the existing managed composition generator, native configuration dump, process supervisor, and ACP client, then adds fixture-owned native rows before capture. This establishes the contract for the separately implemented [production selected-plugin activation](dsh-plugin-activation.md).

The [recorded result](probes/2026-09-18-dsh-plugin-contract.json) includes versions and entry/manifest digests for the CLI, app boot, ACP component, Cordis 4.0.2, Loader 1.0.3, and Include 1.0.7. A CLI version alone does not pin its dependency installation. These observations do not capture the entire dependency graph.

## Native module and configuration behavior

| Case                                     | Observed behavior                                                                                                     |
| ---------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| CommonJS object with `apply`             | Native Loader imports it and passes configuration through its schema                                                  |
| ESM default function                     | The default wins over an unrelated named `apply` export                                                               |
| ESM default class                        | Native Cordis constructs the class with context and validated configuration                                           |
| ESM named asynchronous generator `apply` | Initialization is awaited and yielded cleanup runs on disposal                                                        |
| Relative helper import                   | Resolved from the installed entry's directory, including Unicode and spaces                                           |
| One module in two rows                   | Separate runtime fibers receive their respective configuration; sharing a module is not a duplicate binding by itself |
| Native `Config`                          | Standard-schema validation transforms accepted values and rejects invalid ones before application                     |
| Required `inject` service                | An unavailable service leaves the entry pending and causes native boot to fail                                        |

The successful fixture registers prompt sections and a custom tool. Both reach the synthetic provider, and the tool's returned value reaches the next model request. Session-created and session-disposed notifications carry the ACP session ID. Native resume starts another process, initializes fresh plugin fibers, and restores the same conversation. Cleanup covers both registered effects and an asynchronous generator's yielded disposer.

An integration must preserve native module selection, constructors, generators, configuration schemas, service injection, and effect ownership. A wrapper that always calls an exported function would change this contract. The native row ID identifies a configured instance; it is separate from the module's diagnostic name and package identity.

## Startup race and evidence

`--dump-config` composes the fixture rows without importing or applying them. A matching dump therefore proves configuration composition only.

More significantly, the ACP transport can initialize before native boot settles. In the recorded run, all seven failure cases returned initialization successfully and then exited with code 1: import failure, missing module dependency, invalid plugin shape, invalid configuration, synchronous apply failure, asynchronous apply failure, and a missing required service. The relative timing of those responses is not a stable API guarantee.

A deterministic fixture holds an asynchronous plugin behind a file gate. Both ACP initialization and `session/new` succeed while that plugin is still waiting. No model request is needed to reproduce this race. Readiness must therefore require evidence beyond an ACP session response.

The launcher exposes `appReady.onReady`. A fixture observer receives this notification after all enabled Loader entries reach active state; none of the seven failed trees emits it. The fixture also verifies a separate mechanism: a component with `loader: { await: true }` can inspect settled entry states and publish a service that ACP explicitly requires. With that dependency, ACP initialization remains pending until the selected delayed plugin finishes. The production adapter uses `appReady` plus separate current-process/session checks; the Loader/service gate remains an alternative demonstrated by this fixture.

`appReady` concerns initial boot, not continuous plugin health. Production integration must still bind its observations to the owned process, selected entry/fiber identities, and native session; invalidate observations on disposal or replacement; and obtain fresh evidence on resume. Parent-owned process cleanup remains necessary even when plugin cleanup hooks fail or never run.

## Implementation boundaries

This fixture adds explicit local module rows with configuration. The separate [activation implementation](dsh-plugin-activation.md) provides entry/package resolution, bounded options editing, source observations, reports, and startup/turn/resume gating. General bundle patch import, complete dependency provenance, nested composition, native overrides, arbitrary extension behavior, external providers, and platforms other than macOS remain outside this result. No delivery gate is passed by this contract probe.

Upstream references: [Loader](https://github.com/deepseek-ai/deepseek-harness/blob/master/vendor/loader/src/index.ts), [app boot](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/boot/app-boot/src/index.ts), and the [project repository](https://github.com/deepseek-ai/deepseek-harness). These development-branch links may change; the fixture record identifies the installed artifacts actually tested.

## Reproduce

```sh
AGENT_MATRIX_TEST_DSH=/absolute/path/to/dsh \
AGENT_MATRIX_DSH_PLUGIN_REPORT=/absolute/path/to/plugin-contract.json \
npx vitest run --config vitest.dsh.config.ts tests/dsh-plugin-installed.probe.ts
```

The fixture creates temporary profiles, installed fixture modules, and a private home. It uses a local HTTP provider with synthetic credentials, runs no package manager, and makes no external model calls. It removes its state after confirmed process cleanup. Ordinary unit tests do not execute the installed CLI.
