# Architecture conventions

## Data flow

```text
React UI → typed preload API → sender-checked IPC → WorkspaceStore → workspace.json
                    ↑                                  ↑
           src/shared/api.ts                  src/shared/workspace.ts
```

The renderer displays and edits drafts, committing page state only after a successful save. The main process validates and persists data. The UI has no direct filesystem or process execution access. Browser preview implements the same API using separate localStorage.

## Configuration model

`Workspace` contains `schemaVersion`, `revision`, `agents`, `mcpServers`, `skills`, and `plugins`.

- `Agent` stores the role, model configuration, and resource ID references.
- `McpServer` is a discriminated union of stdio and Streamable HTTP configurations, preventing invalid combinations of transport fields.
- `Skill` stores instruction text. `sourcePath` records provenance only; file reading and watching are not implemented.
- `Plugin` stores a version and resource references. It is a reusable capability bundle, not an executable script.
- `resolveResources` combines direct bindings with enabled plugin resources, removes duplicates, and excludes disabled resources.
- `removeResource` cleans both agent and plugin references to prevent dangling bindings.

When adding fields, update the shared schema, defaults, editors, and relevant tests together. Changes to the persisted structure require a `schemaVersion` increment and an explicit migration. Never overwrite an unreadable configuration.

## Storage consistency

The single-instance desktop app serializes reads and writes through one `WorkspaceStore`. Saving reloads the current file and checks its revision, validates the full configuration, writes a temporary file in the same directory, and renames it over the destination. Failed saves do not commit UI state and preserve the draft for retry. Corrupt files and files from unsupported schema versions are preserved and reported.

This mechanism is not a cross-process database transaction and does not lock out external editors. Edit the file manually only while the application is closed. Multi-window editing and live external-file watching are not implemented.

## Internationalization

`src/shared/i18n/` owns the typed English and Simplified Chinese catalogs, locale resolution, and interpolation. The React `I18nProvider` owns the active locale and exposes `t`, `number`, and `setLocale`; UI components do not maintain translated copies of application data.

The renderer stores an explicit language preference in localStorage under `agent-matrix:locale`. This preference is separate from `workspace.json`, so switching language does not modify workspace data or increment its revision. The first supported system/browser language is used when no valid preference exists; the fallback is English. Switching language updates `document.documentElement.lang`. Preference-storage failures do not block the workspace or switching for the current window.

New agent drafts use the current UI language. The initial desktop workspace uses Electron's system locale; the browser preview uses its resolved UI locale. Previously saved names, descriptions, prompts, and Skill contents are never translated. No schema migration is required for language support.

Shared validation messages use stable translation keys. Main-process application errors use a message envelope that survives Electron's error serialization, then `formatError` translates them in the renderer. Keep error objects in component state so they can be rendered in a different language without repeating the failed operation. Unknown native errors retain their technical diagnostics.

To add or change UI text, update both catalogs and use a key rather than a literal sentence. Keep interpolation placeholders identical across locales. Technical identifiers, provider names, and user content may remain untranslated. Unit tests verify locale fallback, persistence failure handling, catalog compatibility, default-content boundaries, and error localization. Desktop smoke tests cover both languages and preference persistence across reload and restart.

## Extension boundaries

Future runtime code belongs in a module or utility process managed by the main process. It will own streaming model requests, MCP connections, tool execution, cancellation, and logs. Return events through explicit IPC APIs; do not expose `ipcRenderer` or arbitrary filesystem/shell access to the UI.

Credentials should use the operating system's credential storage, with only credential IDs or environment variable names in configuration. Plugin installation requires separate manifest validation, provenance, and permission design. The current resource-bundle model does not authorize execution of third-party code.

For the initial CLI integrations, use engine adapter → session service → typed events → chat UI, reusing each CLI's native agent loop. Shared configuration, engine-specific options, and migration proposals are covered in the [CLI agent research](cli-agent-research.md); work items, priorities, and dependencies are in the [implementation plan](cli-agent-plan.md). If AgentMatrix later adds its own agent, build a separate direct-model provider adapter and MCP tool loop.
