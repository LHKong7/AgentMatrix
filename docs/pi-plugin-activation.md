# Selected Pi extension activation

AgentMatrix loads explicitly selected, already installed extensions through **Pi 0.85.1 / RPC**. The native Pi loader executes their factories; Electron only inspects and captures source observations. The bilingual configuration report records `pi.plugins` after checking the selected extension instances against the current native session.

## Configure a binding

1. Save and check a Pi 0.85.1 installation.
2. Create a native plugin reference with an absolute local path, version, and source description. Pi has no mandatory exported plugin ID; the reference's native ID is a label.
3. Select the reference on an Agent and choose **unrestricted** execution. Extensions can register or enable tools, so the adapter cannot promise the shared no-tools or universal approval policy with these bindings.
4. Start a session and inspect its configuration report. Resume repeats source, lifecycle, and session checks in a new process.

The library editor provides optional [read-only Pi file inspection](native-plugin-inspection.md), including every resolved entry and each declared engine range. The capture/startup checks remain separate; saving or inspecting a reference does not execute it. Explicit `-e` / `--extension` selectors in installation prefix arguments are rejected; select extensions through library bindings so they are captured and checked.

## Supported installed sources

| Selection                                             | Resolution                                                                       |
| ----------------------------------------------------- | -------------------------------------------------------------------------------- |
| Explicit `.ts`, `.tsx`, `.js`, `.mjs`, or `.cjs` file | Import that file through Pi's native jiti loader                                 |
| Directory without a `pi` manifest                     | Use `index.ts`, then `index.js`                                                  |
| Package with `pi.extensions`                          | Load its ordered, explicit file entries; deduplicate entries within that package |

Declared entries must remain inside the selected directory after resolving symlinks. Linked installations are supported. Globs, exclusion patterns, directory entries, and packages declaring additional `pi.skills`, `pi.prompts`, or `pi.themes` are rejected explicitly. For a mixed-resource package, select its extension file and configure shared assets separately. Entries duplicated across different bindings are rejected.

An adjacent package version, when present, must match the saved reference. Declared Pi peer dependency ranges (`@earendil-works/pi-coding-agent` and the older `@mariozechner/pi-coding-agent` name) must match the pinned installation version. Missing declarations remain unknown; they do not establish compatibility. Metadata reads are bounded at 256 KiB and entry reads at 20 MB.

Generated proxy modules import the installed entries by resolved absolute path. Relative imports inside the original module and native virtual imports remain under Pi's loader. Factories are awaited; event ordering, handler results, command options, and native API members are forwarded. Resource results are passed unchanged, including native cwd-relative path semantics. Native `sourceInfo` identifies the captured proxy; the binding manifest records its original entry.

## Activation and turn completion

Each process attachment receives a fresh nonce and private receipt directory. Each successfully initialized factory registers a unique internal witness command. Native `get_commands` must expose that command with its matching nonce and instance token. The adapter then verifies its receipt: owned PID, captured binding identity, original entry, completed initialization, no recorded failure, and the current native session ID, session file, and cwd after all startup handlers complete.

Import, factory, startup-hook, and resource-discovery failures cannot produce a successful observation even when Pi continues loading other extensions. Readiness is rechecked before and after turns and after native restoration. Shutdown invalidates that session's receipt; process cleanup removes the attachment directory. Internal witness commands cannot be invoked from the chat input.

A selected extension command or an input handler returning `action: handled` can complete without a model request or `agent_settled`. The bridge records successful handling, and the runtime completes that turn only after native prompt acceptance and receipt validation. Usage remains unknown rather than invented. Model turns still wait for `agent_settled`; handling evidence cannot prematurely finish an active model/tool run. Extension dialogs use the existing typed, cancellable desktop controls. Commands that replace the native session fail identity checks; arbitrary queued continuations and all TUI-only APIs are not promised.

Pi defers its native transcript until the first assistant/model reply. A verified live session can run extension-only commands before that file exists. The adapter still validates its private reference and session identity; after native history has existed, deletion is an error. Native resume always requires a valid transcript, so an empty or extension-only conversation is not guaranteed to resume. Application history remains available after failed restoration.

## Evidence and limits

The [installed CLI record](probes/2026-09-18-pi-plugin-activation.json) covers an explicit multi-entry package, awaited factories, relative TypeScript and virtual TypeBox imports, CommonJS/ESM files, custom tools and system hooks reaching a local provider, extension commands and confirmation cancellation, handled input before the first model reply, and native resume. It rejects import/factory/startup/resource errors, missing dependencies, invalid factories, and a selected entry changed before resume.

The [Electron record](probes/2026-09-18-pi-plugin-desktop.json) covers a selected extension through saved-profile capture, native startup, system-hook effects at the local provider, English/Chinese confirmation controls and configuration reports, handled input without a model call, and application restart with native resume.

Entry files, explicit relative module dependencies, and package scopes (including absence) are observed and rechecked; see [dependency source checks](plugin-dependency-sources.md). Package installation trees, computed imports, arbitrary runtime file reads, and remote resources remain outside the observed closure. Source coverage remains **partial**. Receipts are lifecycle evidence from selected executable code, not a sandbox or a defense against malicious extensions. Full dependency provenance, generic package resource composition, an options editor, automatic installation/upgrades, external-provider acceptance, and other platforms remain open. MCP needs a separately verified extension; none is selected implicitly.

## Reproduce

```sh
AGENT_MATRIX_TEST_PI=/absolute/path/to/pi \
AGENT_MATRIX_PI_PLUGIN_REPORT=/absolute/path/to/plugin-report.json \
npx vitest run --config vitest.pi.config.ts tests/pi-plugin-activation.probe.ts

AGENT_MATRIX_SESSION_ENGINE=pi \
AGENT_MATRIX_TEST_PI=/absolute/path/to/pi \
AGENT_MATRIX_SESSION_REPORT=/absolute/path/to/desktop-report.json \
npm run test:sessions
```

Fixtures use isolated temporary state, synthetic credentials, and a local HTTP provider. Primary contracts: [versioned extensions guide](https://github.com/earendil-works/pi/blob/v0.85.1/packages/coding-agent/docs/extensions.md), [native extension loader](https://github.com/earendil-works/pi/blob/v0.85.1/packages/coding-agent/src/core/extensions/loader.ts), and [RPC contract](https://github.com/earendil-works/pi/blob/v0.85.1/packages/coding-agent/docs/rpc.md).
