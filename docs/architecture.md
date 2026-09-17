# Architecture conventions

## Data flow

```text
React UI → typed preload API → sender-checked IPC → EngineWorkspaceStore → workspace.json
                    ↑                                    ↑
           src/shared/api.ts                  src/shared/engines/workspace.ts
```

The renderer displays and edits drafts, committing page state only after a successful save. The main process validates and persists data. The UI has no direct filesystem or process execution access. Browser preview implements the same API using separate localStorage.

## Configuration model

`EngineWorkspace` contains `schemaVersion: 2`, `revision`, and nine collections: `agents`, `installations`, `connections`, `models`, `prompts`, `mcpServers`, `skills`, `bundles`, and `nativePlugins`.

- `AgentProfile` binds an engine installation and model profile to shared assets, requested execution policy, and engine-specific options. Null bindings permit incomplete drafts; shared resolution reports missing inputs.
- Connections separate protocol, endpoint, and authentication references from model IDs and optional parameters. The UI never substitutes a default sampling temperature.
- Prompt and Skill assets retain immutable revisions. Bindings follow the latest revision or pin a saved version; prompt application mode is explicit. Skills support inline Markdown and captured directories. Directory import publishes private, content-addressed files before the editor can save a reference; new directory revisions are verified by the main process before workspace publication. See [Skill capture boundaries](skill-capture.md).
- MCP definitions distinguish stdio, Streamable HTTP, and SSE, with typed authentication and environment references. These forms do not connect to servers.
- Resource bundles contain prompt, Skill, and MCP bindings. Native plugin metadata belongs to a specific engine installation and does not authorize installation or execution.
- `resolveAgentProfile` combines enabled bundles with direct bindings, resolves versions, deduplicates resources, and reports conflicts. Direct bindings take precedence. Its output always requires adapter validation; the UI labels previews as planned configuration.
- `removeConfiguration` cleans references while preserving dependent agents and models as editable drafts. `revisePrompt` and `reviseMarkdownSkill` append content changes without replacing saved history.

When adding fields, update the shared schema, defaults, editors, and relevant tests together. Changes to the persisted structure require a `schemaVersion` increment and an explicit migration. Never overwrite an unreadable configuration.

## Storage consistency

The single-instance desktop app serializes reads and writes through one `EngineWorkspaceStore`. Saving reloads the current file, checks its revision and immutable asset history, validates the full configuration, writes a temporary file in the same directory, and renames it over the destination. Failed saves do not commit UI state and preserve the draft for retry. Invalid UTF-8, corrupt files, and unsupported schema versions are preserved and reported.

On first loading schema v1, the store creates an exact-byte, digest-addressed backup before atomically publishing v2. Migration preserves resource identities and leaves unresolved choices as drafts. Fresh v2 workspaces use native v2 defaults without going through legacy conversion. The legacy `WorkspaceStore` is retained for migration tests and is not a second active writer.

Browser preview uses `BrowserWorkspaceStore` with the same schema, revision checks, and append-only history rules. It migrates the old localStorage value to a separate v2 key while retaining the original string. Invalid v2 data never falls back to a fresh workspace or a legacy copy. Browser storage is separate from desktop files and has no credential vault.

This mechanism is not a cross-process database transaction and does not lock out external editors. Edit the file manually only while the application is closed. Multi-window editing and live external-file watching are not implemented.

## Internationalization

`src/shared/i18n/` owns the typed English and Simplified Chinese catalogs, locale resolution, and interpolation. The React `I18nProvider` owns the active locale and exposes `t`, `number`, and `setLocale`; UI components do not maintain translated copies of application data.

The renderer stores an explicit language preference in localStorage under `agent-matrix:locale`. This preference is separate from `workspace.json`, so switching language does not modify workspace data or increment its revision. The first supported system/browser language is used when no valid preference exists; the fallback is English. Switching language updates `document.documentElement.lang`. Preference-storage failures do not block the workspace or switching for the current window.

New agent drafts use the current UI language. The initial desktop workspace uses Electron's system locale; the browser preview uses its resolved UI locale. Previously saved names, descriptions, prompts, and Skill contents are never translated. No schema migration is required for language support.

Shared validation messages use stable translation keys. Main-process application errors use a message envelope that survives Electron's error serialization, then `formatError` translates them in the renderer. Keep error objects in component state so they can be rendered in a different language without repeating the failed operation. Unknown native errors retain their technical diagnostics.

To add or change UI text, update both catalogs and use a key rather than a literal sentence. Keep interpolation placeholders identical across locales. Technical identifiers, provider names, and user content may remain untranslated. Unit tests verify locale fallback, persistence failure handling, catalog compatibility, default-content boundaries, and error localization. Desktop smoke tests cover both languages and preference persistence across reload and restart.

## Extension boundaries

Runtime modules are owned by the main process. The OpenCode adapter delegates model requests, MCP connections, and tool execution to the CLI; the application supervises processes, credentials, cancellation, and durable session events. Return events through explicit IPC APIs; do not expose `ipcRenderer` or arbitrary filesystem/shell access to the UI.

The directory-import IPC opens a native folder chooser in the main process. The renderer cannot supply a filesystem path or read captured file contents through that API. The sender is checked before opening the chooser and again before copying. The response contains source provenance and a bounded file manifest, which the user attaches to a Skill by saving its draft. Browser preview reports that directory import requires the desktop app.

The main-process `CredentialVault` stores ciphertext in `userData/credentials/vault.json` using Electron’s asynchronous `safeStorage` encryption. It serializes mutations, checks per-credential revisions, atomically replaces private files, and preserves corrupt storage. The preload exposes only metadata, replacement, and deletion; decrypted values are available only to the main-process runtime. Missing secure backends, including Linux `basic_text`, cannot save credentials. Browser preview never stores credentials. Active v2 editors bind credential IDs or environment references; the OpenCode runtime resolves captured references in memory immediately before launch. Plugin installation requires separate manifest validation, provenance, and permission design. The current resource-bundle model does not authorize execution of third-party code.

For the initial CLI integrations, use engine adapter → session service → typed events → chat UI, reusing each CLI's native agent loop. Shared configuration, engine-specific options, and migration proposals are covered in the [CLI agent research](cli-agent-research.md); work items, priorities, and dependencies are in the [implementation plan](cli-agent-plan.md). If AgentMatrix later adds its own agent, build a separate direct-model provider adapter and MCP tool loop.

The [session contract](session-contract.md) defines separate conversation, process attachment, turn, and interaction identities. Shared schemas and the lifecycle projection are implemented alongside a bounded main-process event stream with cursor replay and frame-owned subscriptions. A journal-first coordinator persists command receipts, manages attachments and scoped permissions, escalates cancellation, and preserves native identity through shutdown/recovery. The desktop factory captures saved profiles and supplies the OpenCode runtime. Electron IPC verifies the exact window, main frame, and renderer URL; navigation replaces subscription ownership. The bilingual session page reconnects using snapshots and cursor history without resubmitting commands.

The [ACP client](acp-client.md) supplies typed v1 negotiation and requests, bounded LF framing, ordered update callbacks, scoped permission cancellation, and explicit deadlines. Its [attachment wrapper](process-lifecycle.md) owns a process group and couples protocol closure with process cleanup. Both installed ACP engines initialize and shut down through these modules. OpenCode configuration, credential injection, runtime normalization, and durable coordination are implemented and fixture-tested. Desktop session controls are connected and fixture-tested; the other two runtime adapters remain separate work.

The [run input store](run-inputs.md) captures resolved configuration, Prompt and Skill revisions, generated native files, and a versioned launch manifest before execution. It publishes inputs once, keeps mutable native state separate, and verifies file integrity and observed source changes before reuse. It retains snapshots independently of their original library assets. Production adapters and session coordination must enforce engine semantics, source coverage, credential availability, and native resume acknowledgment; a valid snapshot alone does not pass those checks.

The [OpenCode configuration adapter](opencode-configuration.md) generates provider/model routing, Prompt references, Skill directories, MCP settings, and explicit secret environment references for a pinned CLI contract. `prepareRunLaunch` resolves secrets only in the main process after snapshot verification. An opt-in native probe exercises these modules through a real ACP turn against a local protocol fixture. The desktop runtime connects explicit installation probing, native readback, session/event persistence, and user controls. App quit and final-window closure await owned process cleanup and retain resumable interruptions. See the [desktop workflow and evidence](desktop-sessions.md).

The [Pi RPC client](pi-rpc.md) has separate strict LF framing, correlated responses, ordered event delivery, and asynchronous extension dialogs. Its process attachment reuses the supervisor. An installed Pi fixture verifies local turns, tool calls, cancellation, native restoration, and trust behavior. It is not yet wired to immutable run inputs, the shared runtime/session interface, or desktop launch. Pi extension dialogs must not be translated into universal ACP-style tool permissions.
