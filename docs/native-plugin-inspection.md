# Installed native plugin inspection

AgentMatrix can inspect explicitly selected installed **OpenCode, Pi, and DeepSeek Harness** plugins from its library editor. Inspection remains read-only. Supported bindings have separate startup and resume activation checks for [OpenCode](opencode-plugin-activation.md), [Pi](pi-plugin-activation.md), and [DSH](dsh-plugin-activation.md).

## Desktop workflow

1. Save an OpenCode, Pi, or DeepSeek Harness installation and create or edit a native plugin reference.
2. Enter the installed directory or module path and select **Inspect installed files**. Each engine retains its supported entry formats below.
3. Review the local source, all resolved entries, package name/version and metadata path, declared version ranges, inspection time, and file digests. If needed, select **Use package version** to update the draft version.
4. Enter the native plugin ID separately and save the reference. Inspection never replaces an existing ID or source description, and never saves the draft automatically.

The controls and diagnostics are available in English and Simplified Chinese. Changing the selected path or engine clears the result, including an outstanding asynchronous result. Closing and reopening the editor requires a new inspection. Browser preview reports that filesystem inspection requires the desktop app.

## Evidence and boundaries

Inspection reuses the engine's native entry resolver and returns allowlisted metadata, SHA-256 digests, logical/resolved paths, and the pinned resolver version. It does not return source code, package scripts or arbitrary package fields. Engine range comparisons use the saved CLI probe version and pinned `semver` parsing, with distinct match, mismatch, absent declaration, invalid range, unprobed engine and invalid saved version results. A range match is not runtime compatibility evidence. A package name does not establish an executable module's exported ID.

| Engine contract  | Entry and metadata behavior                                                                                                                         | Version declarations                                                                                                                                 |
| ---------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| OpenCode 1.18.16 | Explicit server exports, package main entries, selected files and supported index fallbacks; adjacent package metadata can redirect a selected file | `engines.opencode` against the saved OpenCode probe                                                                                                  |
| Pi 0.85.1        | Selected extension files, `index.ts`/`index.js` directories, or all explicit `pi.extensions` file entries; adjacent metadata                        | Both `@earendil-works/pi-coding-agent` and `@mariozechner/pi-coding-agent` peer declarations are shown separately, including conflicts               |
| DSH 0.1.5-rc.2   | Compiled JavaScript modules or package root import/main/index entries; a selected file can obtain metadata from its nearest ancestor package        | `@deepseek-ai/dsh` uses the saved CLI probe; declared DSH/Cordis framework peer versions remain uninspected, with invalid ranges reported separately |

Pi packages that also declare Skills, prompts or themes require explicit extension-file selection and separate shared-asset configuration. Pi glob/directory extension declarations and DSH patch bundles remain unsupported. DSH cannot use a matching CLI version to establish installed Cordis or ACP package versions. Their actual framework checks belong to the separate runtime activation path.

Results are temporary observations. They do not alter the workspace, create run inputs, resolve secrets, import modules, start a CLI, execute package scripts, install dependencies, or contact a registry. The local file URL identifies the inspected source; it does not authenticate a publisher or verify a user-entered repository URL. Existing plugin references remain editable without a successful inspection.

An unprobed or different engine version is called out in the result. Ambiguous package directory imports are rejected instead of guessed. OpenCode follows the [pinned native entry resolver](https://github.com/anomalyco/opencode/blob/v1.18.16/packages/opencode/src/plugin/shared.ts); Pi and DSH share the same entry inspection used by their respective capture/startup adapters.

Package metadata is limited to 256 KiB and each entry file to 20 MB; Pi allows at most 100 declared entries. Reads require regular files and reject detected concurrent changes. Pi/DSH display metadata comes from a bounded reread whose digest and resolved path must match the native resolver's observation. Installation directory symlinks retain their physical paths; declared package entries escaping their directory are rejected. These checks are deliberately stricter than the native loader for malformed metadata and ambiguous directory resolution. They are not a snapshot of the full dependency tree and cannot establish successful module import or initialization.

## Separate activation checks

The activation path verifies the captured entry/package observations at startup and resume and checks initializer/config-hook receipts from the instance acknowledged by ACP. Inspection results do not substitute for these checks. Complete dependency coverage remains open. Hook effects need their own checks; successful initialization alone does not prove every hook works.

The [installed-release contract probe](opencode-plugin-contract.md) confirms that local packages bypass the native engine-range gate. It also verifies that OpenCode can continue after a plugin load, initialization, or config-hook error, and that pure mode excludes external plugins. Reading generated configuration or receiving an ACP session is therefore insufficient activation evidence; the separate activation verifier handles these cases.

Pi and DSH editor inspection complements their separate [Pi activation](pi-plugin-activation.md) and [DSH activation](dsh-plugin-activation.md) checks. DSH retains separate native options editing; general bundle patch import remains open. No Pi MCP extension is chosen implicitly. The [native plugin installation documentation](https://opencode.ai/docs/plugins/) describes package-manager installation and local discovery; automatic installation remains outside AgentMatrix's initial scope. Existing OpenCode, Pi and DSH capture identities and persisted inspection schemas are unchanged by this editor extension.

## Validation

Unit coverage exercises semantic ranges, prerelease rules, unknown probe metadata, export/main precedence, adjacent versus ancestor metadata, index selection, linked installations, file digests, metadata filtering, missing and malformed files, size limits, path escapes, edits during inspection, request validation, and the separation of file inspection from runtime evidence.

The Electron configuration smoke fixture checks all three engines through the real preload/IPC/filesystem path in both languages: explicit version adoption, matching/mismatching/unknown range diagnostics, every Pi entry/digest, separate Pi aliases, unknown DSH framework versions, unchanged native ID/source, no workspace mutation from inspection, native package restrictions, clearing obsolete results, and saved reference persistence across restart. Fixture entries would write markers if executed; all markers must remain absent. Saved engine versions are synthetic probe metadata and executables are absent. This validates read-only desktop inspection on macOS, not native plugin execution or installed-version acceptance.

Optional `AGENT_MATRIX_PLUGIN_REPORT` writes a JSON evidence record and `AGENT_MATRIX_PLUGIN_SCREENSHOT` records the OpenCode view plus separate Pi/DSH English/Chinese screenshots. See the [2026-09-19 desktop result](probes/2026-09-19-three-engine-plugin-inspection.json).

```bash
npx vitest run tests/native-plugin-inspection.test.ts tests/plugin-engine-range.test.ts --maxWorkers=2
npm run test:smoke
```
