# Desktop agent sessions

The desktop app connects saved Agent profiles to **OpenCode 1.18.16 over ACP**, **Pi 0.85.1 over RPC**, and experimental **DSH 0.1.5-rc.2 over ACP**. All three UI paths are verified on macOS arm64 with installed CLIs and local Chat Completions protocol fixtures. Browser preview has no CLI runtime.

## Start a session

1. In **Engines**, save an OpenCode, Pi, or DSH installation with an absolute executable path and the current platform. Use **Check installation** to run its version command. Saving a path alone never executes it. Only the pinned version records its supported ACP or Pi RPC mode; another version remains visible but cannot launch through this adapter.
2. Create a shared connection and model. Select the intended API protocol, endpoint, native model ID, and a credential or environment reference. Environment references resolve from the desktop process environment; a GUI launch may have a different environment from a shell. Existing native engine-login stores are not imported.
3. Save an enabled Agent profile with that installation, model, and working directory. Select shared Prompt, Skill, and MCP bindings as needed. Resolve missing configuration and review the engine-specific settings. Native plugins are not supported by these adapter revisions. Pi additionally rejects MCP bindings and the shared `ask` execution policy. Select no-tools or unrestricted tools explicitly; project trust is a separate Pi option.
4. Open **Sessions**, choose the saved profile, and start a new session. The main process captures immutable inputs, resolves credentials, checks the native version/configuration, and connects the native protocol. The conversation becomes ready only after the applicable native model, agent or Skill settings, and session identity pass verification.
5. Send a message. Inspect text and tool details. OpenCode and Pi stream text; DSH displays committed replies. OpenCode and DSH permission controls show the native choices with localized action labels and available tool arguments. Cancellation invalidates pending controls and waits for a terminal native result or confirmed cleanup.

The working directory currently comes from the saved profile. The session API also accepts an explicit cwd override; the UI does not yet expose a separate per-launch picker. A complete shared preview is only a planned configuration, not proof of applied native settings. OpenCode project/global/managed configuration remains relevant; readback conflicts stop startup. Pi uses a private native home and explicit project trust/context settings, with observed sources checked before reuse. DSH captures its native composition, isolates controls, and checks its model/session identity; it has no ACP permission-policy readback. See the [Pi configuration boundaries](pi-configuration.md) and [DSH runtime boundaries](dsh-runtime.md).

Use **Configuration report** in the conversation header to inspect captured values, native checks, asset revisions, and pending changes. Reports distinguish composition checks from runtime readback and preserve historical observations across restart. See [report semantics and limits](configuration-report.md).

## History, configuration changes, and recovery

Each session retains the configuration captured at creation. Editing a shared Prompt or other asset affects new sessions; it does not rewrite an existing session's inputs. Resume verifies the captured inputs and observed native sources before restoring the same native conversation. Incompatible or failed restoration is reported without creating a replacement conversation. Pi may not persist an empty native conversation until a model turn writes history, so a never-used Pi conversation is not guaranteed to resume.

Switching pages or reloading the renderer attaches to durable history and current events without resubmitting messages. The UI retains up to 1,000 recent events / approximately 4 MiB and shows a notice when history is capped. Full durable history is preserved; export and browsing older pages are not exposed yet. Native output is rendered as literal text, including HTML-like content. Tool truncation and unknown usage/cost remain explicit.

Quitting the app or closing its final window, including on macOS, aborts active work and waits for owned process cleanup. Sessions become interrupted and can be explicitly resumed after restart when their native engine supports it. **Close session** instead creates a terminal closed conversation after cleanup. A cleanup failure blocks quit and shows an error so cleanup can be retried; it is never reported as a confirmed close.

Only the selected session ID and language preference are cached in renderer localStorage. Transcripts live in the main-process journal; run inputs and mutable native state live under the run store. Known injected credentials are redacted from application events, including matching user text. Native CLI storage remains engine-owned and is not covered by the application's journal redaction guarantee.

## IPC and launch boundaries

Session IPC checks the exact window, main frame, and renderer URL. Subscriptions belong to a main-process identity that changes on navigation; destruction and in-flight subscription races remove stale ownership. The preload exposes typed commands and events, without a generic shell, filesystem, or plaintext-credential API. Main-process failures return stable localized errors rather than raw native exceptions.

The factory derives a stable input capture ID from the session creation request. A retry after capture succeeds but journal creation fails reuses and verifies those inputs. A genuinely new session captures the current saved workspace. Optimistic revision checks prevent a slow installation probe from overwriting configuration edits.

## Reproducible verification

```sh
AGENT_MATRIX_TEST_OPENCODE=/absolute/path/to/opencode \
AGENT_MATRIX_SESSION_REPORT=/absolute/path/to/report.json \
AGENT_MATRIX_SESSION_SCREENSHOT=/absolute/path/to/session.png \
npm run test:sessions
```

For Pi, select its fixture explicitly:

```sh
AGENT_MATRIX_SESSION_ENGINE=pi \
AGENT_MATRIX_TEST_PI=/absolute/path/to/pi \
AGENT_MATRIX_SESSION_REPORT=/absolute/path/to/pi-report.json \
npm run test:sessions
```

For DSH, set `AGENT_MATRIX_SESSION_ENGINE=dsh` and `AGENT_MATRIX_TEST_DSH=/absolute/path/to/dsh` using the same command. The [DSH desktop record](probes/2026-09-18-dsh-desktop-sessions.json) verifies committed messages, tools, approvals, both cancellation paths, immutable Prompt revisions, reload/restart, native resume, and both languages. Separate [runtime fixtures](dsh-runtime.md) cover both provider components.

The script requires a desktop graphics environment. It creates isolated application/home/config/project directories, uses synthetic credentials and engine-specific isolation (OpenCode pure mode or a private Pi/DSH home), and binds an HTTP fixture on loopback. It does not use the user's workspace or call an external model provider. Successful runs remove temporary fixture state; failed runs retain it for diagnosis. Report and screenshot output paths are optional.

The [recorded OpenCode macOS result](probes/2026-09-18-desktop-sessions.json) covers explicit UI version probing, saved-profile launch, permission replies, native file tools, escaped output, reload without duplicate submission, streaming and permission cancellation, a shared-Prompt edit with old/new session inputs, app quit/restart, native resume, confirmed close, both languages, and application-journal credential redaction. Unit tests separately cover factory capture/retry/revision behavior, IPC ownership, renderer cursor recovery, and the owned-process cleanup registry.

The [Pi desktop record](probes/2026-09-18-pi-desktop-sessions.json) covers the same saved-profile, text/tool, streaming cancellation, snapshot, reload, restart/resume, close, and bilingual paths. Universal tool approval and permission cancellation are explicitly unsupported for Pi. Its [runtime fixture](pi-runtime.md) additionally checks native restoration with retained tool context and provider errors after acceptance.

The [lower-level OpenCode fixture](opencode-configuration.md) additionally covers directory Skills and stdio MCP mapping; the [Pi configuration fixture](pi-configuration.md) covers directory Skills and reference files. These results do not pass the external-provider or three-engine delivery gates. The intended endpoint/model/auth route, library-wide update impact reporting and complete native provenance, the combined cross-engine asset-update scenario, other platforms, remote MCP/OAuth, and plugin activation remain open.
