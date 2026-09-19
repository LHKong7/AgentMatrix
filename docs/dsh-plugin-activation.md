# Selected DeepSeek Harness plugin activation

AgentMatrix loads explicitly selected, already installed DSH modules through their native Cordis rows. The adapter targets **DeepSeek Harness 0.1.5-rc.2 over ACP**. The library has English and Simplified Chinese JSON configuration controls, and session reports record `dsh.plugins` only after native boot and current-session checks succeed.

## User workflow

1. Register and check the supported DSH installation.
2. Add a native plugin reference with an absolute local path, version, source description, and unique native component ID.
3. Enter ordinary configuration in **DSH plugin configuration (JSON)**. Native `Config` validation runs in DSH when the session starts; saving the draft does not execute the module or its schema.
4. Bind the reference to an Agent and start a new session. Review the configuration report for native activation evidence. Resume checks the original captured selection and obtains new lifecycle evidence.

The native ID becomes the Cordis row ID. It must start with a letter or digit, contain only letters, digits, hyphens or underscores, and use at most 100 characters. Duplicate and application-managed IDs are rejected. The same module can have multiple bindings with different IDs and configuration; each must have a distinct active native fiber. A declared package version must match the saved reference. Without a declared version, the saved value is a label, not a verified release. The source description does not authenticate a publisher.

Options are optional for backward compatibility and default to an empty object. The root must be a plain JSON object. Validation bounds serialized UTF-8 content to 64 KiB, nesting to 12 levels, total values to 4096, each string to 16,384 characters, and keys to 200 characters. Cycles, accessors, nonfinite numbers, and `__jsExpr`, `__proto__`, `constructor`, or `prototype` keys are rejected. Literal text is not converted into executable expressions. Captured options are copied so later workspace edits cannot change existing inputs.

These options are persisted ordinary configuration. Keep provider keys in the shared connection's credential references. Plugin-specific secret-reference injection is not implemented; do not put keys into the JSON field. Selecting another engine with DSH options produces a compatibility diagnostic; **Clear plugin options** removes them. OpenCode has a separate [native tuple mapping](opencode-plugin-options.md); Pi has no generic JSON option mapping.

## Entry resolution and native behavior

Supported selections are compiled `.js`, `.mjs`, or `.cjs` files and installed package directories. Directory resolution uses an explicit root `exports` target, then `main`, then `index.js`. Conditional exports follow declared key order for the native import conditions. Root export arrays, mixed subpath/condition maps, TypeScript sources, and guessed extensionless entries are rejected. Entries must stay within the selected directory after symlink resolution; linked package directories are supported.

A directory containing `cordis.patch.yml` is a bundle, not an implicit module selection. Its component files can be selected individually. General bundle patch import, nested composition, automatic installation, and upgrades remain unimplemented.

Inspection reads files without evaluating code. The native row imports the original physical file URL, preserving relative imports and native module resolution. There is no initializer wrapper: native object/function/class/generator selection, `Config`, `inject`, tools, effects, and disposal retain their Cordis behavior. The [installed contract fixture](dsh-plugin-contract.md) verifies those module shapes separately.

Selected bindings also require the following inspected framework releases:

| Component                            | Version      |
| ------------------------------------ | ------------ |
| `@deepseek-ai/dsh`                   | `0.1.5-rc.2` |
| `@deepseek-ai/dsh-app-boot`          | `0.1.5-rc.2` |
| `@deepseek-ai/dsh-acp`               | `0.1.5-rc.2` |
| `@deepseek-ai/cordis`                | `4.0.2`      |
| `@deepseek-ai/cordis-plugin-loader`  | `1.0.3`      |
| `@deepseek-ai/cordis-plugin-include` | `1.0.7`      |

Declared peer dependency ranges for these components are compared with the pinned versions. Missing declarations remain unknown compatibility. Selected entry bytes, explicit relative module dependencies, package scope metadata or absence, resolved paths, and framework entry/manifest digests contribute to capture and reuse checks; see [dependency source checks](plugin-dependency-sources.md). Package dependency trees, computed imports, and arbitrary runtime resources remain outside the observed closure; source coverage is **partial**.

## Readiness and current-session evidence

ACP initialization and even session creation can succeed before plugins finish loading. The runtime therefore waits for a managed observer's `appReady.onReady` evidence before creating or restoring a session. It then verifies the actual native session and working directory before publishing Ready. A composed `--dump-config` result alone never establishes activation.

Each owned process receives a fresh attachment nonce and private receipt directory. Each verification uses a fresh challenge and checks the nonce, challenge, PID, captured plan identity, working directory, selected row IDs, and distinct active fiber IDs. The native observer also checks the original fiber objects, source URLs, raw row configuration, and current session. Disposal, replacement, or observed row drift invalidates that attachment even if the same fiber later becomes active again.

Checks run at startup, before and after model turns, and after native resume in a new process. Receipt requests use bounded files and a disposable stat watcher; no network listener is added. Normal cleanup removes receipts after the owned process stops. Historical journal observations remain associated with their original attachment and do not authorize a resumed process. Existing sessions without plugin bindings do not require this observer.

This is lifecycle evidence from trusted executable modules. It does not establish an OS sandbox, protection from malicious plugin code, arbitrary hook correctness, or acceptance by an external provider. The managed execution policy controls native model-tool dispatch; plugin initialization can execute code outside those tool decisions. A complete replacement system prompt can also supersede plugin-added prompt sections under native DSH semantics.

## Verification

- Unit coverage checks entry resolution without execution, package/framework versions, paths and source drift, repeated module instances, bounded options, immutable captures, native boot/session/PID checks, disposed/reactivated fibers, changed row configuration, and replacement fibers.
- The production adapter passes both the [generic pi-ai route](probes/2026-09-18-dsh-plugin-activation-pi-ai.json) and the [native DeepSeek route](probes/2026-09-18-dsh-plugin-activation-deepseek-native.json). The fixtures verify delayed initialization, per-instance options, native system sections, a custom tool round trip, fresh session checks, native resume, and rejection of import/shape/configuration/application/service failures, disposal before a turn, and source changes before resume.
- The [Electron result](probes/2026-09-18-dsh-plugin-desktop.json) covers bilingual options editing and persistence, native activation in local provider calls, bilingual reports, shared-Prompt revisions, restart, and fresh evidence on resume. It uses an appended shared prompt so both shared instructions and the plugin's native system section remain visible.

These fixtures use synthetic credentials and local HTTP providers on macOS arm64. External endpoint/model/auth acceptance, complete dependency provenance, bundle patch import, remote MCP, and other platforms remain open. The combined local [shared-asset update scenario](shared-asset-acceptance.md) has separate desktop evidence. This increment does not pass D4.

```sh
AGENT_MATRIX_TEST_DSH=/absolute/path/to/dsh \
AGENT_MATRIX_DSH_ACTIVATION_REPORT=/absolute/path/to/activation \
npx vitest run --config vitest.dsh.config.ts tests/dsh-plugin-activation.probe.ts

AGENT_MATRIX_SESSION_ENGINE=dsh \
AGENT_MATRIX_TEST_DSH=/absolute/path/to/dsh \
AGENT_MATRIX_SESSION_REPORT=/absolute/path/to/desktop.json \
npm run test:sessions
```

The activation report prefix produces separate `.pi-ai.json` and `.deepseek-native.json` files. Ordinary unit tests do not execute the installed CLI.
