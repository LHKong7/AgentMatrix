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

- **Agents:** create, edit, delete, enable, disable, and search configurations.
- **Model settings:** provider, model ID, base URL, and temperature.
- **System prompts:** edit system instructions independently.
- **MCP servers:** stdio commands, arguments, and environment references, or Streamable HTTP endpoints and token environment references.
- **Skills:** Markdown instructions with optional source paths.
- **Plugin bundles:** combine existing MCP servers and Skills into reusable capabilities.
- **Resource bindings:** bind resources directly or through plugins, deduplicate them, filter disabled resources, and clean references on deletion.
- **Local persistence:** versioned JSON, Zod validation, atomic file replacement, serialized saves, and revision conflict checks.
- **API credentials:** add, replace, and delete encrypted credentials in Settings. Main-process storage uses Electron’s asynchronous OS-backed encryption; the UI receives metadata only. Browser preview disables credential storage.
- **English and Simplified Chinese:** instant language switching, translated forms and application errors, and a saved language preference.

This is a configuration management foundation. **Model requests, MCP connections, Skill file loading, and third-party plugin installation are not implemented.** Enabled means the configuration is available; it does not mean an agent or service is running. Plugins currently describe resource bundles and do not execute third-party code.

## Language support

Use the language selector in the top bar or **Settings → Language**. On the first visit, the UI follows the first supported system/browser language, with English as the fallback. Chinese language variants resolve to Simplified Chinese. An explicit choice is saved under `agent-matrix:locale` in localStorage and restored after reload or restart. Desktop and browser preview keep separate preferences.

Switching languages updates UI text, accessible labels, dialogs, validation messages, and number formatting. It also updates the document's `lang` attribute. Existing agent names, descriptions, prompts, Skill instructions, and resource data are user content and are never translated or overwritten. New agent drafts use the active language; the first desktop workspace uses the system language. If preference storage is unavailable, switching still works for the current window.

Translations live in `src/shared/i18n/en.ts` and `zh-CN.ts`. Use stable keys through `useI18n().t()` in React or `translate()` in shared code. Chinese entries must satisfy the English key schema; tests verify matching placeholders. Main-process application failures use stable serialized error codes so the renderer can translate them in the current language. Native OS diagnostics retain their technical details.

## Commands

| Command                | Purpose                                                                             |
| ---------------------- | ----------------------------------------------------------------------------------- |
| `npm run dev`          | Start Electron with hot reload                                                      |
| `npm run dev:web`      | Preview the UI in a browser                                                         |
| `npm run check`        | Run ESLint, unit tests, TypeScript, and production builds                           |
| `npm run test:smoke`   | Build and test a real Electron window, including language switching and persistence |
| `npm run format`       | Format source and documentation                                                     |
| `npm run format:check` | Check formatting                                                                    |
| `npm run build`        | Build into `out/`                                                                   |
| `npm start`            | Run the existing production build                                                   |
| `npm run package`      | Create an unsigned app directory for the current platform                           |
| `npm run dist`         | Build platform distributables into `release/`                                       |

Desktop smoke tests use a temporary configuration directory and clean it up afterward. They require a desktop graphics environment. CI runs `check`, which does not require a display.

## Project layout

```text
src/
  main/                  Electron lifecycle, IPC boundaries, local storage
  preload/               Explicit, typed configuration API only
  shared/                Schemas, domain types, composition rules, IPC contracts
    i18n/                Typed English and Simplified Chinese catalogs
    errors.ts            Localizable application error codes and formatting
  renderer/
    src/
      components/        Agent, MCP, Skill, plugin, and language editors
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

Environment settings store **variable-name references**, such as `{"API_TOKEN":"MY_API_TOKEN"}`, for a future runtime to resolve. Settings now provides an encrypted credential vault at `userData/credentials/vault.json`; schema v2 connection bindings will reference its IDs. The current schema v1 agents do not call providers or consume these credentials yet. Do not put keys into prompts, arguments, or ordinary configuration fields.

Unreadable or incompatible workspace files produce an error and are preserved. There is no silent reset. Exit the app and make a backup before editing its workspace file manually.

The main process enables context isolation and renderer sandboxing, and disables Node integration. Preload exposes workspace loading/saving, app information, and credential metadata/set/delete operations. No plaintext credential read operation is exposed. IPC validates the sender. Production uses a restrictive CSP; development permits inline scripts for React Fast Refresh only. See [Electron Context Isolation](https://www.electronjs.org/docs/latest/tutorial/context-isolation) and [electron-vite development](https://electron-vite.org/guide/dev).

## Next stages

1. Probe **OpenCode, Pi, and DeepSeek Harness**; separate engines, model connections, and shared assets, with credential storage and explicit draft-to-launch validation.
2. Complete **OpenCode ACP → Pi RPC → DeepSeek Harness ACP** integrations, including session UI, supported native controls, immutable run inputs, and configuration application status. The initial DSH probe selected ACP because the installed SDK lacks cancel/resume; see the [probe report](docs/engine-probe-2026-09-18.md) and [implementation status](docs/implementation-status.md).
3. Add complete Skill imports and MCP distribution. Start with read-only native configuration imports and managed output; recognize installed native plugins and pin DSH composition. Pi MCP requires a separately verified extension; general plugin installation and automatic upgrades are deferred.
4. After the initial three-engine milestone, expand to Claude Code, Codex, Gemini CLI, Cline, Goose, and OpenHands, then later scheduling and collaboration. See the [implementation plan](docs/cli-agent-plan.md) and [nine-engine research](docs/cli-agent-research.md).

Packaging targets are configured for macOS DMG, Windows NSIS, and Linux AppImage. Brand assets, signing, notarization, and platform verification remain release work.
