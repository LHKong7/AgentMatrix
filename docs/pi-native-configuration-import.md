# Pi native configuration import

Updated: **2026-09-19**. The desktop importer interprets explicitly selected files using the **Pi 0.85.1** contract. It shares the encrypted archive, credential transaction, revision checks, and immutable history used by [OpenCode import](native-configuration-import.md).

## Workflow and selected sources

Save a Pi installation, then open **Settings → Import native configuration**. Select any combination of these files from one folder in the file chooser:

| File               | Imported content                                                                                           |
| ------------------ | ---------------------------------------------------------------------------------------------------------- |
| `models.json`      | Provider connections, model profiles, supported model-specific routes, headers, and sampling parameters    |
| `auth.json`        | Selected providers' API-key references and literal credentials, with stored-auth precedence                |
| `settings.json`    | Explicit default provider/model selection and thinking level; other settings remain reviewable diagnostics |
| `SYSTEM.md`        | A versioned Prompt asset bound in replacement mode                                                         |
| `APPEND_SYSTEM.md` | A separate versioned Prompt asset bound in append mode                                                     |

The chooser supports multiple selection; one file is also valid. File roles are determined by these exact names. Mixed folders, duplicate roles, unknown filenames, and more than five files are rejected. The importer reads only selected files. For example, selecting `models.json` alone does not inspect an adjacent `auth.json`, even if that file would override credentials during an ordinary native launch.

JSON files must contain strict JSON objects without duplicate keys. Their UTF-8 BOMs are accepted; original bytes remain unchanged in the archive. Markdown content retains its original text, line endings, and BOM. Empty or oversized prompt content is retained with a diagnostic rather than creating a runnable empty prompt. Total selected input is bounded to 1 MiB, each JSON document to 4,000 values/32 nesting levels/200-character keys, and mapped Prompt content to 100,000 characters.

Preview lists new library entries, credential count, every selected source, field mappings, and unconverted fields in English or Chinese. Apply publishes the group as one import transaction. An initially nonexistent executable is sufficient for import; installation probing and native session launch remain separate user actions.

## Model and authentication mapping

Explicit APIs map to shared protocols: `openai-completions`, `openai-responses`, `anthropic-messages`, and `google-generative-ai`. Provider IDs do not imply an API or built-in endpoint. Literal HTTP(S) endpoints are accepted without embedded userinfo, query, or fragment. Missing/unsupported APIs remain unresolved connection drafts.

A provider normally creates one reusable connection. A model-level API, endpoint, or header override creates a separate connection, preserving the provider's shared connection. Model headers override the same provider header name; conflicting case variants are diagnosed. `samplingParams.temperature` and `top_p` map to shared model parameters on supported OpenAI routes. Other sampling fields, cost, context limits, input capabilities, and unknown metadata are retained with diagnostics.

Compatibility options, thinking-level maps, and matching `modelOverrides` require explicit review and leave the affected model's connection unresolved. The importer does not claim that the current shared schema can reproduce arbitrary provider-specific request behavior. Duplicate model IDs within one provider are rejected rather than selecting an ambiguous source.

When `auth.json` is selected, a provider's stored credential takes precedence over its `models.json` key. An unresolved stored credential does not silently fall back to the other key. OAuth entries remain encrypted in the source and mark an engine-login draft; tokens are not copied into shared API-key fields, refreshed, or logged. Pi's current managed runtime rejects that unresolved login route.

API-key and header values are parsed as data:

- Literal values become encrypted vault credentials. Uppercase strings without a dollar prefix are literals.
- Exact `$NAME` and `${NAME}` references remain host-environment references without reading the host environment.
- If the selected `auth.json` explicitly supplies a nonempty literal `env.NAME`, that source value becomes a vault credential; both the original reference and the supplying field are recorded in provenance. Its content is not recursively interpreted.
- `$$` and `$!` decode to literal dollar and exclamation characters. A decoded leading exclamation character is still literal data.
- Leading `!command` values and mixed environment templates remain unresolved. Import never executes commands, performs login, or resolves arbitrary expressions.

Known credentials are absent from preview payloads and ordinary workspace JSON. The exact source files, including unused keys and OAuth tokens, are retained only in the encrypted archive. Names, prompt content, and other ordinary user-authored strings are not a general secret-detection boundary.

## Agent drafts and application limits

One disabled Pi Agent draft is created for the selected file group. Explicit `defaultProvider` plus `defaultModel` select the imported model; no arbitrary first model or native catalog default is selected. A declared default model can create a model profile under an imported provider, but this does not verify that a remote service supports that ID. Valid `defaultThinkingLevel` values populate the Pi-specific option.

The draft starts with no working directory, project trust denied, context files inherited, and execution policy set to ask for explicit review. Pi does not support the shared universal-approval policy: choose a supported deny-tools or unrestricted policy before enabling and launching. Native `defaultTools`, project trust decisions, retries, compaction, package/extension lists, Skill paths, MCP extensions, and unselected files are not silently applied. Existing library editors and installed-extension bindings remain available for deliberate configuration.

The shared Prompt assets are copies of the selected files. Later changes to native sources do not edit the imported assets or earlier run captures. Native global/project/CLI precedence and automatic discovery are not reconstructed by this file-group import. Unknown fields retain source-qualified diagnostic paths such as `/models.json/providers/custom/compat/...`.

## Storage and recovery

Pi history records identify the first canonical source with `sourceKind` and retain up to four `additionalSources`. Each source has its own path, resolved path, SHA-256, and byte count. The archive encrypts a canonical envelope of original file bytes; verification checks the role, count, length, and digest of every file. Existing OpenCode records and their single-file payload remain compatible.

Every selected file is rechecked before publication. Changing any source or the workspace after preview rejects application. The existing credential journal and committed import ID govern rollback, interrupted-import recovery, and idempotent retries. Import does not modify original files, create Pi lockfiles, or call Pi's native settings/authentication loaders. Unreferenced encrypted archives after failed publication and retention/export controls have the same limits described in the [shared persistence contract](native-configuration-import.md#read-and-persistence-boundaries).

## Verification

The **macOS arm64** Electron fixture passed with installed **Pi 0.85.1** against a local synthetic Chat Completions provider on 2026-09-19. It selects five files, checks English/Chinese controls, rejects a changed secondary `auth.json`, verifies three OS-encrypted credentials and exact archived bytes, restarts the app, retries the committed import, explicitly configures/probes the CLI, and completes a native turn from the imported draft. The provider checks stored-auth priority, endpoint/model, replacement and append prompts, sampling, literal escaped headers, and an environment header resolved only at launch. A command marker remains absent. [Redacted result](probes/2026-09-19-pi-native-import-desktop.json).

```bash
AGENT_MATRIX_IMPORT_ENGINE=pi \
AGENT_MATRIX_TEST_PI=/absolute/path/to/pi \
npm run test:native-import
```

Only the native file chooser is substituted; the IPC, OS encryption, filesystem, editors, restart, and Pi runtime are real. Unit tests additionally cover malformed/duplicate selections, strict JSON, per-model routing, unresolved credentials, OAuth retention, escaped templates, empty Markdown, near-limit encrypted archives, changes to each of the five sources, immutable history, and failed-publication rollback. OpenCode's existing import/native-call fixture also passes the extended implementation.

No external model provider is called. Full native precedence, catalog discovery, general OAuth/compatibility mapping, referenced resource ingestion, archive retention/export, and other platforms remain unverified or unimplemented. This increment does not pass C4 or the overall three-engine gate.

## Primary references

- [Pi 0.85.1 models documentation](https://github.com/earendil-works/pi/blob/v0.85.1/packages/coding-agent/docs/models.md)
- [Provider composition and stored-auth precedence](https://github.com/earendil-works/pi/blob/v0.85.1/packages/coding-agent/src/core/provider-composer.ts)
- [Native secret-template interpretation](https://github.com/earendil-works/pi/blob/v0.85.1/packages/coding-agent/src/core/resolve-config-value.ts)
- [Credential storage](https://github.com/earendil-works/pi/blob/v0.85.1/packages/coding-agent/src/core/auth-storage.ts)
- [Settings and project trust](https://github.com/earendil-works/pi/blob/v0.85.1/packages/coding-agent/docs/settings.md)
- [Native prompt/resource discovery](https://github.com/earendil-works/pi/blob/v0.85.1/packages/coding-agent/src/core/resource-loader.ts)
