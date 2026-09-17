# Installed native plugin inspection

AgentMatrix can inspect an explicitly selected installed **OpenCode** plugin from its library editor. This is the first implementation step for the native plugin scope in A6/B3. It does not pass the plugin activation gate: profiles with native plugin bindings remain blocked by launch validation for all three engines.

## Desktop workflow

1. Save an OpenCode engine installation and create or edit a native plugin reference.
2. Enter the installed directory or JavaScript/TypeScript file path and select **Inspect installed files**.
3. Review the local source, resolved server entry, declared package name/version, OpenCode version-range result, inspection time, and file digests. If needed, select **Use package version** to update the draft version.
4. Enter the native plugin ID separately and save the reference. Inspection never replaces an existing ID or source description, and never saves the draft automatically.

The controls and diagnostics are available in English and Simplified Chinese. Changing the selected path or engine clears the result, including an outstanding asynchronous result. Closing and reopening the editor requires a new inspection. Browser preview reports that filesystem inspection requires the desktop app.

## Evidence and boundaries

Inspection reads the selected entry and its adjacent `package.json`, when present. It returns allowlisted metadata, SHA-256 digests, logical and resolved paths, and the version of the resolver contract. It does not return source code, package scripts, credentials, or arbitrary package fields. The declared OpenCode version range is compared with the last saved CLI probe version using pinned `semver` parsing. Results distinguish a match, mismatch, absent declaration, invalid range, unprobed engine, and invalid saved version. This comparison never launches the CLI or promotes a range match to runtime compatibility evidence. A package name does not establish the ID exported by executable plugin code.

Results are temporary observations. They do not alter the workspace, create run inputs, resolve secrets, import modules, start a CLI, execute package scripts, install dependencies, or contact a registry. The local file URL identifies the inspected source; it does not authenticate a publisher or verify a user-entered repository URL. Existing plugin references remain editable without a successful inspection.

The resolver is based on OpenCode **1.18.16**. It recognizes explicit server exports, package main entries, explicit files, and supported index fallbacks. Selecting a file can still be redirected by a main/server entry in an adjacent package. An unprobed or different engine version is called out in the result. Ambiguous package directory imports are rejected instead of guessed. See the [pinned native entry resolver](https://github.com/anomalyco/opencode/blob/v1.18.16/packages/opencode/src/plugin/shared.ts).

Package metadata is limited to 256 KiB and entry files to 20 MB. Reads require regular files and reject detected concurrent changes. Installation directory symlinks are supported and their physical paths are shown; declared package entries escaping their directory are rejected. These checks are deliberately stricter than the native loader for malformed metadata and ambiguous directory resolution. They are not a snapshot of the full dependency tree and cannot establish that a module will import or initialize successfully.

## Work still required for activation

Activation must verify the installed plugin's identity and source observations again at startup and resume, establish the dependency and compatibility boundary, pass the selected references to the native runtime, and observe successful initialization in that same runtime attachment. Plugin source changes must invalidate stale evidence. Hook effects need their own checks; successful initialization alone does not prove every hook works.

The [installed-release contract probe](opencode-plugin-contract.md) confirms that local packages bypass the native engine-range gate. It also verifies that OpenCode can continue after a plugin load, initialization, or config-hook error, and that pure mode excludes external plugins. Reading the generated configuration or receiving an ACP session is therefore insufficient activation evidence. The implementation must account for these behaviors before enabling bound plugins. See the [pinned plugin lifecycle](https://github.com/anomalyco/opencode/blob/v1.18.16/packages/opencode/src/plugin/index.ts).

Pi extension selection and DeepSeek Harness plugin/composition recognition remain separate adapter work. No Pi MCP extension is chosen implicitly. The [native plugin installation documentation](https://opencode.ai/docs/plugins/) describes package-manager installation and local discovery; automatic installation remains outside AgentMatrix's initial scope.

## Validation

Unit coverage exercises semantic ranges, prerelease rules, unknown probe metadata, export/main precedence, adjacent versus ancestor metadata, index selection, linked installations, file digests, metadata filtering, missing and malformed files, size limits, path escapes, edits during inspection, request validation, and the continued activation block.

The Electron configuration smoke fixture checks the real preload/IPC/filesystem path in both languages, explicit version adoption, matching/mismatching/unknown range diagnostics, unchanged native ID/source, no workspace mutation from inspection, error display, clearing obsolete results, and saved reference persistence across restart. Its installed entry would write a marker if executed; the fixture checks that no marker exists. This validates read-only desktop inspection on macOS, not native plugin execution or cross-platform runtime acceptance.

```bash
npx vitest run tests/native-plugin-inspection.test.ts tests/plugin-engine-range.test.ts
npm run test:smoke
```
