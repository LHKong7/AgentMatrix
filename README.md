# AgentMatrix

A desktop workspace for managing agent configurations locally. Built with **Electron + React + TypeScript**, using electron-vite for development and builds.

Documentation: [Architecture](docs/architecture.md) · [Research: nine CLI agents and configuration design](docs/cli-agent-research.md) · [Integration implementation plan](docs/cli-agent-plan.md) · [Three-engine acceptance checklist](docs/three-engine-acceptance.md).

## Getting started

Requires Node.js **22.12+ (22.x) or 24+**. The Node 22 version in `.nvmrc` is recommended.

```bash
npm ci
npm run dev
```

The first launch creates a general assistant configuration. Save your edits to keep them across restarts.

To preview the UI in a browser:

```bash
npm run dev:web
```

Browser preview uses separate localStorage and never reads or writes desktop workspace files.

## Current features

- **Agents and engines:** maintain drafts for OpenCode, Pi, and DeepSeek Harness, with installation paths, model bindings, and separate native settings. Saving a path does not execute or verify the CLI.
- **OpenCode, Pi, and DSH desktop sessions:** explicitly check a saved installation, then start from a saved profile. View messages and tools, answer supported native permission requests, cancel turns, reload history, and resume interrupted sessions. Adapters are pinned to OpenCode 1.18.16, Pi 0.85.1, and experimental DSH 0.1.5-rc.2. DSH displays committed replies; OpenCode and Pi stream text. Native approvals apply to OpenCode and DSH; Pi requires an explicit compatible execution policy; see [setup and verification](docs/desktop-sessions.md).
- **Shared connections and models:** maintain API protocols, endpoints, authentication references, model IDs, and optional sampling parameters independently of agents. Anthropic connections use a [shared root-or-`/v1` endpoint convention](docs/anthropic-provider-acceptance.md) across the three engines.
- **Configuration diagnostics:** [failed native checks](docs/configuration-failures.md) identify affected field groups in the conversation, history, and bilingual report, preserve historical successes, and omit native values. OpenCode reports can show [captured declarations matching a conflict](docs/opencode-override-sources.md), with ambiguous and unknown source attribution kept explicit.
- **Native source tracking:** new OpenCode snapshots capture [Agent, Mode, and Command directory inventories](docs/native-resource-sources.md), display their metadata in both languages, and reject resume after source changes. Complete field-level override provenance remains open.
- **Native configuration import:** preview an [OpenCode JSON/JSONC file](docs/native-configuration-import.md), [Pi model/auth/settings and Prompt files](docs/pi-native-configuration-import.md), or [DSH composition/settings/credentials](docs/dsh-native-configuration-import.md) in Settings, then import shared resources and disabled Agent drafts. Known credentials enter the encrypted vault; exact source bytes and unknown fields remain in an encrypted archive with immutable per-file provenance.
- **Versioned prompts and Skills:** edit Markdown assets, preserve previous revisions, and bind either the latest revision or a specific version. Prompt application modes are explicit. A [combined desktop fixture](docs/shared-asset-acceptance.md) verifies one shared Prompt and directory Skill across all three engines, including edits during active turns and old/new versions after native resume.
- **Skill directory imports:** select a directory in the desktop editor to capture `SKILL.md`, scripts, and references with file digests. Reimport creates a new revision while retaining previous bytes; importing never executes scripts.
- **MCP definitions:** configure stdio, Streamable HTTP, or SSE, with arguments, environment values, secret references, headers, and authentication metadata.
- **Resource bundles:** reuse prompt, Skill, and MCP bindings. Native plugins have separate metadata tied to an engine installation. The desktop editor can [inspect selected installed OpenCode, Pi, and DSH plugin files](docs/native-plugin-inspection.md), including entry resolution, package versions, declared engine ranges, and digests; supported installed ESM plugins now have [instance-specific startup and resume checks](docs/opencode-plugin-activation.md). Selected [Pi extensions](docs/pi-plugin-activation.md) also support native startup/resume checks, custom tools, and extension command dialogs; they require unrestricted execution. Selected [DSH modules](docs/dsh-plugin-activation.md) support native boot/session checks, separate instances of the same module, and bilingual JSON options editing.
- **Saved history:** browse older events in bounded pages and export the selected history to JSONL. Historical interaction requests are read-only, and exports preserve the journal's existing credential redaction; see [history and export behavior](docs/session-history.md).
- **Session configuration reports:** inspect captured values, native readback evidence, asset versions and binding sources, and changes pending a new session. An expandable [native capability table](docs/session-capabilities.md) separates mechanism, verification and current availability, including declared versus successfully used restoration. Reports preserve historical checks after restart and leave unsupported readback unknown; see [evidence and limits](docs/configuration-report.md).
- **Resolved previews:** inspect shared bindings and draft diagnostics before native adapter validation. Direct bindings override bundle bindings; disabled assets are excluded. Removing definitions cleans references while retaining dependent agents as drafts.
- **Local persistence:** schema v2 JSON, Zod validation, atomic replacement, revision conflicts, immutable asset history, and automatic v1 migration with an exact-byte backup.
- **API credentials:** add, replace, and delete encrypted credentials in Settings. Main-process storage uses Electron’s asynchronous OS-backed encryption; the UI receives metadata only. Session reports compare [attachment and stored revisions](docs/credential-rotation.md); active processes keep prior inputs, while new starts and native resumes resolve current credentials. Browser preview disables credential storage.
- **English and Simplified Chinese:** instant language switching, translated forms and application errors, and a saved language preference.

All three engines are connected to the desktop UI and verified on macOS against local provider fixtures. DSH has separate [configuration](docs/dsh-configuration.md) and [runtime](docs/dsh-runtime.md) evidence, including both its generic and native DeepSeek provider components. External provider acceptance, complete native override provenance, complete native source ingestion, and third-party plugin installation remain open. Enabled means the configuration is available; it does not mean an agent or service is running. Resolved previews show intended inputs, not verified native behavior.

Configure an engine installation, then create a shared connection and model. Maintain prompts, Skills, and MCP definitions in their own libraries and select them in an agent's Bindings tab. The Resolved preview tab reports missing configuration. Incomplete profiles remain editable; a complete shared preview still requires native adapter compatibility checks before launch.

## Language support

Use the language selector in the top bar or **Settings → Language**. On the first visit, the UI follows the first supported system/browser language, with English as the fallback. Chinese language variants resolve to Simplified Chinese. An explicit choice is saved under `agent-matrix:locale` in localStorage and restored after reload or restart. Desktop and browser preview keep separate preferences.

Switching languages updates UI text, accessible labels, dialogs, validation messages, and number formatting. It also updates the document's `lang` attribute. Existing agent names, descriptions, prompts, Skill instructions, and resource data are user content and are never translated or overwritten. New agent drafts use the active language; the first desktop workspace uses the system language. If preference storage is unavailable, switching still works for the current window.

Translations live in `src/shared/i18n/en.ts` and `zh-CN.ts`, including their `configuration-*.ts` and `session-*.ts` catalogs. Use stable keys through `useI18n().t()` in React or `translate()` in shared code. Chinese entries must satisfy the English key schema; tests verify matching placeholders. Main-process application failures use stable serialized error codes so the renderer can translate them in the current language. Native OS diagnostics retain their technical details.

## Commands

| Command                            | Purpose                                                                                                                                    |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `npm run dev`                      | Start Electron with hot reload                                                                                                             |
| `npm run dev:web`                  | Preview the UI in a browser                                                                                                                |
| `npm run check`                    | Run ESLint, unit tests, TypeScript, and production builds                                                                                  |
| `npm run test:smoke`               | Build and test a real Electron window, including language switching and persistence                                                        |
| `npm run test:sessions`            | Build and test desktop sessions with an explicitly selected OpenCode, Pi, or DSH CLI and a local provider fixture                          |
| `npm run test:shared-assets`       | Build and verify shared Prompt/Skill updates across all three installed engines in one desktop workspace                                   |
| `npm run test:native-import`       | Verify OpenCode, Pi or DSH import, OS encryption, bilingual UI, and an imported native session against a local provider                    |
| `npm run test:credential-rotation` | Verify stored-key rotation, active/new/resumed native sessions, deletion failures, and bilingual revision reports across all three engines |
| `npm run probe:dsh`                | Opt-in installed DSH lifecycle, configuration, and coordinated runtime through two local provider routes                                   |
| `npm run probe:providers`          | Opt-in Responses and Anthropic Messages endpoint, authentication, tool and lifecycle checks across all three installed engines using local fixtures     |
| `npm run probe:pi`                 | Opt-in installed Pi transport, configuration, and coordinated runtime with local fixtures                                                  |
| `npm run probe:acp`                | Opt-in installed OpenCode/DSH handshake through the application ACP client                                                                 |
| `npm run format`                   | Format source and documentation                                                                                                            |
| `npm run format:check`             | Check formatting                                                                                                                           |
| `npm run build`                    | Build into `out/`                                                                                                                          |
| `npm start`                        | Run the existing production build                                                                                                          |
| `npm run package`                  | Create an unsigned app directory for the current platform                                                                                  |
| `npm run dist`                     | Build platform distributables into `release/`                                                                                              |

Configuration reports now show [selected Skill source evidence](docs/skill-source-verification.md), distinguishing Pi RPC observations, OpenCode preflight, and unknown results.

Closed conversations support [confirmed deletion and recoverable cleanup](docs/session-retention.md), including reference checks before removing captured inputs and native state. Shared assets, credentials, project files, and exported histories are retained.

Desktop smoke tests use a temporary configuration directory and clean it up afterward. They require a desktop graphics environment. CI runs `check`, which does not require a display.

The ACP probe requires explicit executable-path environment variables; see [ACP client verification](docs/acp-client.md#verification). Its successful handshake does not validate model calls or tool execution. The separate [Pi RPC probe](docs/pi-rpc.md) verifies native turns, cancellation, restoration, and trust behavior against a local fixture; the [Pi runtime and desktop fixtures](docs/pi-runtime.md) also pass.

## Project layout

```text
src/
  main/                  Electron lifecycle, IPC boundaries, local storage
  preload/               Explicit, typed configuration and session APIs
  shared/                Schemas, domain types, composition rules, IPC contracts
    i18n/                Typed English and Simplified Chinese catalogs
    errors.ts            Localizable application error codes and formatting
  renderer/
    src/
      components/        Configuration editors, language controls, and sessions
      i18n/              React translation context and language preferences
      lib/               Desktop API / browser preview adapter
      App.tsx            Workspace pages and navigation
      tokens.css         Color, typography, and design tokens
      styles.css         UI styles
tests/                   Configuration, composition, persistence, and i18n tests
scripts/                 Development CSP and real Electron smoke tests
docs/                    Architecture, CLI research, and implementation plan
```

## Data and development conventions

Desktop configuration lives in Electron's `userData/workspace.json`; Settings shows its exact path. On macOS it is usually `~/Library/Application Support/AgentMatrix/workspace.json`. Development smoke tests use `AGENT_MATRIX_DATA_DIR` for isolation; packaged builds ignore that variable.

Connections and MCP definitions store **secret references**, either an environment variable name or a credential ID. Settings provides the encrypted credential vault at `userData/credentials/vault.json`; configuration editors can select saved credential metadata without reading plaintext values. The desktop runtime resolves only the captured references immediately before launching OpenCode, Pi, or DSH. Do not put keys into prompts, arguments, or ordinary configuration fields.

The active store uses schema v2. Before converting a v1 workspace, it preserves the original bytes as `workspace.json.v1.<sha256>.bak`; migration retains IDs and bindings and leaves unresolved engine choices editable. A fresh workspace has no assumed provider, model, installation, or sampling temperature. Browser preview writes `agent-matrix:preview:v2` and retains the old `agent-matrix:preview:v1` value when migrating.

Imported Skill files live under `userData/assets/skills/<digest>/`. The importer rejects symlinks, ambiguous/nonportable paths, changed sources, and oversized directories. It preserves frontmatter without interpreting it. Skill discovery and name compatibility still require an engine adapter. See [Skill capture boundaries](docs/skill-capture.md) for limits and retention behavior.

Unreadable or incompatible workspace files produce an error and are preserved. There is no silent reset. Exit the app and make a backup before editing its workspace file manually.

The main process enables context isolation and renderer sandboxing, and disables Node integration. Preload exposes workspace loading/saving, app information, credential metadata/set/delete operations, explicit installation probing, and typed session commands/events. No plaintext credential read operation is exposed. IPC validates the sender. Production uses a restrictive CSP; development permits inline scripts for React Fast Refresh only. See [Electron Context Isolation](https://www.electronjs.org/docs/latest/tutorial/context-isolation) and [electron-vite development](https://electron-vite.org/guide/dev).

## Next stages

1. Complete native provenance and library-wide update impact reporting for **OpenCode, Pi, and DeepSeek Harness**. Shared libraries, selected-file native import, Skill capture, bilingual editors, credential revision reports, v2 migration, immutable run inputs, and typed session IPC are active. Automatic installation discovery, complete native precedence, and referenced-resource ingestion remain open.
2. Finish the **OpenCode ACP** acceptance gate: verify the intended external endpoint/model/auth route, complete effective configuration reporting, and audit the remaining shared-configuration requirements. Early Pi and DSH lifecycle probes now pass against local fixtures. Streaming, tools, permissions, cancellation, history, and restart/resume now run through the bilingual desktop UI against a local fixture. Shared prompt/Skill/MCP mappings remain part of acceptance.
3. Complete **Pi RPC** and **DeepSeek Harness ACP** acceptance, reusing the shared library and session UI with separate native mappings and acceptance checks. Pi MCP requires a separately verified extension; DSH uses a pinned composition and explicit ACP limits after its installed SDK probe. General plugin installation and automatic upgrades are deferred. See the [probe report](docs/engine-probe-2026-09-18.md), [delivery milestones](docs/cli-agent-plan.md#21-incremental-delivery), and [implementation status](docs/implementation-status.md).
4. After the initial three-engine milestone, expand to Claude Code, Codex, Gemini CLI, Cline, Goose, and OpenHands, then later scheduling and collaboration. See the [implementation plan](docs/cli-agent-plan.md) and [nine-engine research](docs/cli-agent-research.md).

Packaging targets are configured for macOS DMG, Windows NSIS, and Linux AppImage. Brand assets, signing, notarization, and platform verification remain release work.
