# AgentMatrix

A desktop workspace for managing agent configurations locally. Built with **Electron + React + TypeScript**, using electron-vite for development and builds.

Documentation: [Architecture](docs/architecture.md) · [Research: nine CLI agents and configuration design](docs/cli-agent-research.md) · [Integration implementation plan](docs/cli-agent-plan.md).

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
- **OpenCode desktop sessions:** explicitly check a saved installation, then start from a saved profile. Stream messages, inspect tools, answer native permission requests, cancel turns, reload history, and resume interrupted sessions. The current adapter is pinned to OpenCode 1.18.16; see [setup and verification](docs/desktop-sessions.md).
- **Shared connections and models:** maintain API protocols, endpoints, authentication references, model IDs, and optional sampling parameters independently of agents.
- **Versioned prompts and Skills:** edit Markdown assets, preserve previous revisions, and bind either the latest revision or a specific version. Prompt application modes are explicit.
- **Skill directory imports:** select a directory in the desktop editor to capture `SKILL.md`, scripts, and references with file digests. Reimport creates a new revision while retaining previous bytes; importing never executes scripts.
- **MCP definitions:** configure stdio, Streamable HTTP, or SSE, with arguments, environment values, secret references, headers, and authentication metadata.
- **Resource bundles:** reuse prompt, Skill, and MCP bindings. Native plugins have separate metadata tied to an engine installation.
- **Resolved previews:** inspect shared bindings and draft diagnostics before native adapter validation. Direct bindings override bundle bindings; disabled assets are excluded. Removing definitions cleans references while retaining dependent agents as drafts.
- **Local persistence:** schema v2 JSON, Zod validation, atomic replacement, revision conflicts, immutable asset history, and automatic v1 migration with an exact-byte backup.
- **API credentials:** add, replace, and delete encrypted credentials in Settings. Main-process storage uses Electron’s asynchronous OS-backed encryption; the UI receives metadata only. Browser preview disables credential storage.
- **English and Simplified Chinese:** instant language switching, translated forms and application errors, and a saved language preference.

OpenCode execution is connected to the desktop UI and verified on macOS against a local provider fixture. Pi and DeepSeek Harness remain configurable drafts without runtime adapters. External provider acceptance, complete configuration application reporting, native configuration import, and third-party plugin installation remain open. Enabled means the configuration is available; it does not mean an agent or service is running. Resolved previews show intended inputs, not verified native behavior.

Configure an engine installation, then create a shared connection and model. Maintain prompts, Skills, and MCP definitions in their own libraries and select them in an agent's Bindings tab. The Resolved preview tab reports missing configuration. Incomplete profiles remain editable; a complete shared preview still requires native adapter compatibility checks before launch.

## Language support

Use the language selector in the top bar or **Settings → Language**. On the first visit, the UI follows the first supported system/browser language, with English as the fallback. Chinese language variants resolve to Simplified Chinese. An explicit choice is saved under `agent-matrix:locale` in localStorage and restored after reload or restart. Desktop and browser preview keep separate preferences.

Switching languages updates UI text, accessible labels, dialogs, validation messages, and number formatting. It also updates the document's `lang` attribute. Existing agent names, descriptions, prompts, Skill instructions, and resource data are user content and are never translated or overwritten. New agent drafts use the active language; the first desktop workspace uses the system language. If preference storage is unavailable, switching still works for the current window.

Translations live in `src/shared/i18n/en.ts` and `zh-CN.ts`, including their `configuration-*.ts` and `session-*.ts` catalogs. Use stable keys through `useI18n().t()` in React or `translate()` in shared code. Chinese entries must satisfy the English key schema; tests verify matching placeholders. Main-process application failures use stable serialized error codes so the renderer can translate them in the current language. Native OS diagnostics retain their technical details.

## Commands

| Command                 | Purpose                                                                                               |
| ----------------------- | ----------------------------------------------------------------------------------------------------- |
| `npm run dev`           | Start Electron with hot reload                                                                        |
| `npm run dev:web`       | Preview the UI in a browser                                                                           |
| `npm run check`         | Run ESLint, unit tests, TypeScript, and production builds                                             |
| `npm run test:smoke`    | Build and test a real Electron window, including language switching and persistence                   |
| `npm run test:sessions` | Build and test desktop sessions with an explicitly selected OpenCode CLI and a local provider fixture |
| `npm run probe:pi`      | Opt-in installed Pi RPC lifecycle against an isolated local provider fixture                          |
| `npm run probe:acp`     | Opt-in installed OpenCode/DSH handshake through the application ACP client                            |
| `npm run format`        | Format source and documentation                                                                       |
| `npm run format:check`  | Check formatting                                                                                      |
| `npm run build`         | Build into `out/`                                                                                     |
| `npm start`             | Run the existing production build                                                                     |
| `npm run package`       | Create an unsigned app directory for the current platform                                             |
| `npm run dist`          | Build platform distributables into `release/`                                                         |

Desktop smoke tests use a temporary configuration directory and clean it up afterward. They require a desktop graphics environment. CI runs `check`, which does not require a display.

The ACP probe requires explicit executable-path environment variables; see [ACP client verification](docs/acp-client.md#verification). Its successful handshake does not validate model calls or tool execution. The separate [Pi RPC probe](docs/pi-rpc.md) verifies native turns, cancellation, restoration, and trust behavior against a local fixture; Pi desktop execution is still pending.

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

Connections and MCP definitions store **secret references**, either an environment variable name or a credential ID. Settings provides the encrypted credential vault at `userData/credentials/vault.json`; configuration editors can select saved credential metadata without reading plaintext values. The desktop runtime resolves only the captured references immediately before launching OpenCode. Do not put keys into prompts, arguments, or ordinary configuration fields.

The active store uses schema v2. Before converting a v1 workspace, it preserves the original bytes as `workspace.json.v1.<sha256>.bak`; migration retains IDs and bindings and leaves unresolved engine choices editable. A fresh workspace has no assumed provider, model, installation, or sampling temperature. Browser preview writes `agent-matrix:preview:v2` and retains the old `agent-matrix:preview:v1` value when migrating.

Imported Skill files live under `userData/assets/skills/<digest>/`. The importer rejects symlinks, ambiguous/nonportable paths, changed sources, and oversized directories. It preserves frontmatter without interpreting it. Skill discovery and name compatibility still require an engine adapter. See [Skill capture boundaries](docs/skill-capture.md) for limits and retention behavior.

Unreadable or incompatible workspace files produce an error and are preserved. There is no silent reset. Exit the app and make a backup before editing its workspace file manually.

The main process enables context isolation and renderer sandboxing, and disables Node integration. Preload exposes workspace loading/saving, app information, credential metadata/set/delete operations, explicit installation probing, and typed session commands/events. No plaintext credential read operation is exposed. IPC validates the sender. Production uses a restrictive CSP; development permits inline scripts for React Fast Refresh only. See [Electron Context Isolation](https://www.electronjs.org/docs/latest/tutorial/context-isolation) and [electron-vite development](https://electron-vite.org/guide/dev).

## Next stages

1. Complete configuration provenance and application reporting for **OpenCode, Pi, and DeepSeek Harness**. Shared libraries, Skill capture, bilingual editors, credentials, v2 migration, immutable run inputs, and typed session IPC are active. Automatic installation discovery and native configuration import remain open.
2. Finish the **OpenCode ACP** acceptance gate: verify the intended external endpoint/model/auth route, complete effective configuration reporting, and collect early DSH lifecycle evidence. Streaming, tools, permissions, cancellation, history, and restart/resume now run through the bilingual desktop UI against a local fixture. Shared prompt/Skill/MCP mappings remain part of acceptance.
3. Deliver **Pi through RPC**, then **DeepSeek Harness through ACP**, reusing the shared library and session UI with separate native mappings and acceptance checks. Pi MCP requires a separately verified extension; DSH uses a pinned composition and explicit ACP limits after its installed SDK probe. General plugin installation and automatic upgrades are deferred. See the [probe report](docs/engine-probe-2026-09-18.md), [delivery milestones](docs/cli-agent-plan.md#21-incremental-delivery), and [implementation status](docs/implementation-status.md).
4. After the initial three-engine milestone, expand to Claude Code, Codex, Gemini CLI, Cline, Goose, and OpenHands, then later scheduling and collaboration. See the [implementation plan](docs/cli-agent-plan.md) and [nine-engine research](docs/cli-agent-research.md).

Packaging targets are configured for macOS DMG, Windows NSIS, and Linux AppImage. Brand assets, signing, notarization, and platform verification remain release work.
