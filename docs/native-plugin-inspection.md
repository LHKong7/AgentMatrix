# Installed native plugin inspection

AgentMatrix can inspect an explicitly selected installed **OpenCode** plugin from its library editor. Inspection remains read-only. Supported OpenCode ESM bindings now have separate [startup and resume activation checks](opencode-plugin-activation.md); [Pi activation](pi-plugin-activation.md) uses separate capture/startup inspection; [DSH activation](dsh-plugin-activation.md) likewise inspects selected entries and package scopes during capture and startup.

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

## Separate activation checks

The activation path verifies the captured entry/package observations at startup and resume and checks initializer/config-hook receipts from the instance acknowledged by ACP. Inspection results do not substitute for these checks. Complete dependency coverage remains open. Hook effects need their own checks; successful initialization alone does not prove every hook works.

The [installed-release contract probe](opencode-plugin-contract.md) confirms that local packages bypass the native engine-range gate. It also verifies that OpenCode can continue after a plugin load, initialization, or config-hook error, and that pure mode excludes external plugins. Reading generated configuration or receiving an ACP session is therefore insufficient activation evidence; the separate activation verifier handles these cases.

Pi extension selection now has its own [resolver and activation checks](pi-plugin-activation.md); the editor inspection button remains OpenCode-only. [DSH module resolution and activation](dsh-plugin-activation.md) now run during capture/startup, with separate native options editing; general bundle patch import remains open. No Pi MCP extension is chosen implicitly. The [native plugin installation documentation](https://opencode.ai/docs/plugins/) describes package-manager installation and local discovery; automatic installation remains outside AgentMatrix's initial scope.

## Validation

Unit coverage exercises semantic ranges, prerelease rules, unknown probe metadata, export/main precedence, adjacent versus ancestor metadata, index selection, linked installations, file digests, metadata filtering, missing and malformed files, size limits, path escapes, edits during inspection, request validation, and the separation of file inspection from runtime evidence.

The Electron configuration smoke fixture checks the real preload/IPC/filesystem path in both languages, explicit version adoption, matching/mismatching/unknown range diagnostics, unchanged native ID/source, no workspace mutation from inspection, error display, clearing obsolete results, and saved reference persistence across restart. Its installed entry would write a marker if executed; the fixture checks that no marker exists. This validates read-only desktop inspection on macOS, not native plugin execution or cross-platform runtime acceptance.

```bash
npx vitest run tests/native-plugin-inspection.test.ts tests/plugin-engine-range.test.ts
npm run test:smoke
```
