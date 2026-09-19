# Native configuration import

Updated: **2026-09-19**. This document describes the selected **OpenCode JSON/JSONC file** importer, interpreted against the **1.18.16** configuration contract, and the shared persistence boundaries. The [Pi 0.85.1 importer](pi-native-configuration-import.md) also supports explicitly selected model, auth, settings, and Prompt files in one transaction. DeepSeek Harness import remains separate work. Importing does not probe an installation or verify a delivery gate.

## Desktop workflow

1. Save an OpenCode installation in **Engines**. Its executable does not need to be runnable for import.
2. Open **Settings → Import native configuration**, select the installation, and choose a file.
3. Review the new library entries, credential count, field mappings, and unconverted-field diagnostics. Preview does not write the workspace, vault, archive, or original file.
4. Choose **Import configuration**. The application appends shared resources and disabled Agent drafts, stores credential references, and records immutable source provenance. Existing library entries are not overwritten or deduplicated by name.
5. Review the draft's connection, model, execution policy, bindings, and unresolved fields. Select a working directory, explicitly check the installation, and enable the Agent when ready.

All controls, diagnostics, and errors support English and Simplified Chinese. Saved import sources remain visible after restart and after imported resources are edited or removed. Browser preview cannot import local native configuration.

## Mapping contract

| Native input                                   | Shared result                                          | Boundaries                                                                                                                                                                                                                                                                                                                                                 |
| ---------------------------------------------- | ------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `provider.<id>.npm`                            | Connection protocol                                    | Explicit `@ai-sdk/openai-compatible`, `@ai-sdk/openai`, `@ai-sdk/anthropic`, and `@ai-sdk/google` map to Chat Completions, Responses, Anthropic Messages, and Gemini respectively. Missing/custom SDKs remain unresolved; provider names do not establish a protocol.                                                                                      |
| `provider.<id>.options.baseURL`                | Connection endpoint                                    | A literal HTTP(S) endpoint without userinfo, query, or fragment. Environment/file expressions remain unresolved. Default/built-in provider endpoints are not inferred.                                                                                                                                                                                     |
| `options.apiKey`, `options.headers`            | Authentication and secret-header references            | Literal values enter the encrypted credential vault. Exact `{env:NAME}` values remain environment references. File expressions and mixed macros are not expanded. A custom SDK's unmapped key remains only in the encrypted source.                                                                                                                        |
| `provider.<id>.models.<key>` and `model`       | Shared model profile and Agent binding                 | Explicit API `id` overrides the route key. A selected route may create a model under an imported provider. Per-model provider/options/headers/variants require review and leave the model connection unresolved. Cost, context limits, capabilities, and other unsupported fields are retained with diagnostics.                                           |
| `agent.<name>.prompt`                          | Version 1 role Prompt asset, bound in replacement mode | Literal inline prompts only. Referenced prompt files and `instructions` are retained but not read or applied.                                                                                                                                                                                                                                              |
| Agent `temperature`, `top_p`                   | Agent-specific model profile parameters                | A separate shared model profile preserves the selected Agent's sampling settings. Invalid values are diagnosed.                                                                                                                                                                                                                                            |
| Global or Agent `permission`                   | Requested execution policy                             | Scalar `ask`, `deny`, and `allow` map to ask, deny, and unrestricted. Rule objects require review and default to ask. Agent mode/disable and unconverted tool controls are not reproduced automatically. Every imported Agent starts disabled.                                                                                                             |
| Local `mcp` command, environment, cwd, timeout | Stdio MCP definition                                   | Command arrays split into executable/arguments. Literal nonempty environment values enter the vault; exact environment macros remain references. Absolute cwd and supported timeout bounds are mapped. Relative cwd and macro arguments require review. Recognizable key/token/password/header arguments are retained without copying into plaintext argv. |
| Remote `mcp` URL, headers, OAuth metadata      | Streamable HTTP MCP draft                              | Headers use credential references; `oauth: false` maps to no OAuth, otherwise engine-owned OAuth with optional scopes. Client registration/secrets, redirects, and other advanced OAuth fields remain unconverted. Import does not validate an HTTP/OAuth connection or prove its transport.                                                               |

New Agents bind imported MCP definitions; an explicit native `enabled: false` is preserved. A file without named Agents creates a `build` draft. `default_agent`, subagent behavior, plugins, Skill discovery, native authentication files, and additional sources are not silently converted. Inspect every diagnostic before enabling a draft; import is not an effective-native-configuration snapshot.

The shared model has no general secret-reference syntax inside arbitrary strings or command arguments. Recognizable credential arguments are rejected for automatic mapping, but arbitrary prompt text, labels, IDs, and ordinary argv remain user content. This importer does not claim to detect a credential hidden in every possible string. Use explicit authentication, secret-header, or environment-reference fields for secrets.

## Read and persistence boundaries

The importer parses data directly with pinned `jsonc-parser` 3.3.1. It never calls OpenCode's configuration loader: that loader resolves macros/references and can write a missing `$schema` back to a configuration file. Import does not execute a CLI, import a plugin, install a package, contact an endpoint, expand the environment, or read a referenced file.

Reads are limited to regular UTF-8 files of 1 MiB, 4,000 values, 32 nesting levels, and 200-character keys. Comments and trailing commas are accepted; duplicate keys, invalid UTF-8, and ambiguous JSON are rejected. Prototype-like keys are inert data. Selected symlinks are resolved and their target identity is rechecked. Source bytes, hash, physical path, file identity, installation, and workspace revision are checked again before applying a preview. A preview expires after ten minutes and is not persisted across app restarts.

Ordinary `workspace.json` contains an optional, append-only `nativeImports` array. Each record stores the source path, resolved path, SHA-256, byte count, capture time, interpretation version, installation identity, imported entity/field mappings, and diagnostic codes/JSON pointers. It contains no raw source values. Existing workspaces without imports retain their original schema shape.

`native-imports/<import-id>.json` stores the exact original bytes, including comments and unknown fields, as OS-encrypted ciphertext alongside matching metadata. Encryption availability is required even when a file has no mapped credentials. Archives use private files, immutable publication, and digest verification; a conflicting or corrupt archive is preserved and blocks the import. There is no renderer API for decrypting the source. Supported literal credential fields are stored separately in the existing vault; the preview receives names/counts and references, never their values. Source archival does not turn unknown fields into runnable options.

The main process owns the import plan and accepts only its token and expected workspace revision from the renderer. Apply stages encrypted credentials with a pending-import journal, then atomically publishes the workspace and its import ID. Restart recovery uses that committed ID to retain published credentials or remove unpublished additions. Publication failure rolls back new credentials; an acknowledgment failure after a successful publication does not remove referenced keys. Retrying a committed ID is idempotent. Pending transactions block ordinary vault mutation and stored-key resolution until recovered.

A failed publication can leave an encrypted, unreferenced source archive for recovery/inspection. Archive retention and deletion controls are deferred. This is process-interruption recovery, not a claim of cross-file atomicity under filesystem corruption or sudden storage loss.

## Verification and remaining work

The unit suite covers inert JSONC parsing, duplicate/depth/size rejection, field conversion, unknown siblings, escaped provenance pointers, secret omission, exact-byte encrypted archival, immutable history, source/symlink changes, revision conflicts, idempotent retry, encryption/publication failures, and both outcomes of interrupted credential-journal recovery.

The opt-in desktop fixture exercises the real preload/IPC, OS encryption, filesystem, editors, restart, and installed OpenCode against a local synthetic Chat Completions endpoint. Only the native file chooser is substituted. Run it with an absolute OpenCode 1.18.16 executable:

```bash
AGENT_MATRIX_TEST_OPENCODE=/absolute/path/to/opencode npm run test:native-import
```

Its assertions cover cancellation, read-only preview, English/Chinese UI, changed-source rejection, three encrypted credentials, exact archived source bytes, restart/history, idempotent retry, and an explicitly enabled imported Agent's native turn with the imported endpoint, model, key, header, and system prompt. No external provider or real API key is used.

**Recorded result:** the macOS arm64 fixture passed on 2026-09-19 with OpenCode 1.18.16 and one completed primary provider round trip. [Redacted result](probes/2026-09-19-opencode-native-import-desktop.json). The initial installation path deliberately points to a nonexistent executable; import succeeds before the test selects and explicitly probes the real CLI.

Remaining work includes the DSH importer, combined native precedence and discovery, OpenCode file-based instruction/Skill ingestion and native authentication-store discovery, complete per-field runtime override provenance, expanded provider/model and OAuth mappings, import archive retention/export, and external-provider/platform acceptance. Native-file write-back and bidirectional synchronization remain deferred.

## Primary references

- [OpenCode 1.18.16 configuration loader and precedence](https://raw.githubusercontent.com/anomalyco/opencode/v1.18.16/packages/opencode/src/config/config.ts)
- [OpenCode 1.18.16 JSONC parser](https://raw.githubusercontent.com/anomalyco/opencode/v1.18.16/packages/opencode/src/config/parse.ts)
- [Provider configuration schema](https://raw.githubusercontent.com/anomalyco/opencode/v1.18.16/packages/core/src/v1/config/provider.ts)
- [Agent configuration schema](https://raw.githubusercontent.com/anomalyco/opencode/v1.18.16/packages/core/src/v1/config/agent.ts)
- [MCP configuration schema](https://raw.githubusercontent.com/anomalyco/opencode/v1.18.16/packages/core/src/v1/config/mcp.ts)
- [Microsoft JSONC parser](https://github.com/microsoft/node-jsonc-parser)
