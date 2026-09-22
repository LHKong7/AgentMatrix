# Selected OpenCode plugin activation

AgentMatrix now loads explicitly selected, already installed OpenCode plugins when starting or restoring a conversation. The production adapter targets **OpenCode 1.18.16**. English and Simplified Chinese configuration reports record `opencode.plugins` only after the selected plugins initialize and finish their config hooks in the native instance acknowledged by that conversation.

## User workflow

1. Register and check the supported OpenCode installation.
2. Add a native plugin reference with its local path, ID, version, and source description. The optional [file inspection](native-plugin-inspection.md) helps resolve its entry and package metadata.
3. Optionally enter ordinary JSON options, then bind that reference to an Agent. Remove `--pure` from the installation arguments when using plugins.
4. Start a new session and inspect its configuration report. Resuming a conversation rechecks its captured sources and obtains fresh activation evidence.

Saving or inspecting a reference never executes its code. Starting or resuming the selected profile does execute it in the owned OpenCode process, including OpenCode's separate configuration readback process. An installed package's declared version must match the reference, and its declared `engines.opencode` range must include the checked CLI release. Missing engine ranges remain unknown compatibility, not an inferred match.

For V1 modules, the exported `id` must match the reference. Legacy modules have no equivalent required ID; their native ID field is a user label, and their binding identity is tied to the captured entry digest and reference. If no package version is declared, the saved version is also a label rather than a verified release. A user-entered repository URL does not authenticate the installed source.

## Preserved native behavior

The planner statically enumerates explicit ESM exports with the [Babel parser](https://babeljs.io/docs/babel-parser). It writes small proxy modules into captured inputs without importing the selected module into Electron. OpenCode imports the original installed entry from its physical location, preserving relative imports and normal dependency resolution.

The bridge preserves legacy initializer ordering, export aliases, separate initializer results, V1 default server selection, and unrelated V1 named exports. Multiple legacy exports are not flattened into one hook object. Frozen hook objects are supported, nested tool/auth objects retain their identity, and method calls retain their original receivers. Native initializer arguments are forwarded unchanged. The bilingual editor now supports [native JSON tuple options](opencode-plugin-options.md) for legacy and V1 plugins, preserving literal macro text and captured values across native resume.

CommonJS and `export *` entry shapes are rejected explicitly. An unexpected runtime namespace, invalid V1 ID/server shape, missing dependency, or failed import cannot produce valid activation evidence. Selecting two references that resolve to the same entry is rejected. [Pi extension activation](pi-plugin-activation.md) uses a separate native contract. [DeepSeek Harness selected modules](dsh-plugin-activation.md) have their own native row/configuration and lifecycle checks.

## Instance-specific verification

The [native contract fixture](opencode-plugin-contract.md) established that OpenCode can report an ACP session even after plugin failures, and that startup and resume can initialize multiple native instances. A PID or a successful config readback alone cannot identify the instance used by the conversation.

After readback, the adapter creates a fresh attachment nonce and private receipt directory in owned mutable state. Proxy initializers record completion, config-hook success, failure, and disposal for each distinct initializer. A final managed plugin appends an instance marker to the selected native agent's description while preserving its existing text. The adapter reads that marker from the **selected `mode` option in ACP `configOptions`**, then checks the corresponding receipt against the attachment nonce, owned PID, cwd, selected binding identities, and all initializer states. It does not assume a fixed number of native initialization cycles.

Only this successful check records `opencode.plugins`. Stale process or instance receipts, missing bindings, partial initialization, failed config hooks, and disposal are rejected. Each turn rechecks that instance's receipt before submitting a prompt. Resume starts a new native process with fresh evidence; historical observations do not authorize it. Normal attachment cleanup removes receipts after the owned process stops. The immutable run inputs and journaled observation remain available for review.

This is lifecycle evidence from selected executable code, not a sandbox or protection against malicious plugins. It does not prove every hook or external service works. Native config readback can execute initializers in another process; plugins must tolerate the native lifecycle. Shutdown ownership remains with the parent process group and does not depend on a plugin receiving `dispose`.

## Source and compatibility boundaries

Captured observations cover the selected entry, explicit relative module dependencies, package scopes or their absence, and resolved paths; see [dependency source checks](plugin-dependency-sources.md). Startup and resume re-resolve each selection and check those observations. Detected entry/dependency/package changes block reuse until sources are restored or a new capture is created. Old sessions without plugin bindings retain their existing adapter contract and do not require a plugin receipt.

Package dependency trees, computed imports, arbitrary runtime file reads, and remote resources remain outside the observed closure. Their changes may therefore escape the source comparison; a successful import checks availability at that moment only. Source coverage remains `partial`. Complete dependency provenance, CommonJS/export-star support, plugin secret-reference injection, arbitrary plugin compatibility, automatic installation, and upgrades remain open. Existing native configuration can introduce overrides or discovery conflicts; selected plugin activation does not establish complete effective-policy provenance.

## Verification

- Unit tests cover export planning without execution, metadata/range rejection, source changes, distinct frozen hooks, aliases, V1 receivers, stale evidence, failed initialization/configuration, missing bindings, and disposal.
- The [installed production-adapter result](probes/2026-09-18-opencode-plugin-activation.json) verifies new and resumed sessions, native system-hook effects at a local provider, and rejection of pure mode, import/init/config failures, missing dependencies, wrong V1 IDs, and an entry changed before resume.
- The [Electron result](probes/2026-09-18-opencode-plugin-desktop.json) covers a selected plugin through the saved-profile factory, native startup, local provider requests, bilingual reports, application restart, and native resume.

These results use synthetic credentials and local HTTP providers on macOS arm64. They do not constitute external-provider, Linux, Windows, or complete B3/B7 acceptance. Native OpenCode may manage its own SDK dependencies during startup; the fixture is not a guarantee of zero registry traffic.

```bash
AGENT_MATRIX_TEST_OPENCODE=/absolute/path/to/opencode \
AGENT_MATRIX_OPENCODE_ACTIVATION_REPORT=/absolute/path/to/result.json \
npx vitest run --config vitest.opencode.config.ts tests/opencode-plugin-activation.probe.ts
```
