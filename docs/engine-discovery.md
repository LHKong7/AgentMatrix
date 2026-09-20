# Installed CLI detection and one-click download

The **Engines** page checks for a supported agent CLI when it opens and can download the pinned
version. Detection is read-only; a download writes only inside this application's own data
directory. Neither step changes native engine settings, and neither sends a prompt to a model.

## What detection does

`discoverEngines` (`src/main/engines/discovery.ts`) searches, in order:

1. `userData/engines/<kind>/node_modules/.bin` — previous AgentMatrix downloads (`managed`).
2. every `PATH` entry, in order (`path`).
3. the usual per-user and system install roots: `~/.local/bin`, `~/bin`, `~/.bun/bin`,
   `~/.deno/bin`, `~/.npm-global/bin`, `~/.volta/bin`, `~/node_modules/.bin`, `/usr/local/bin`,
   `/opt/homebrew/bin`, `/usr/bin` (`common`).

The first four distinct executables per engine (resolved through symlinks, and only if executable)
are kept. Each one runs `<executable> --version` through the ordinary process guardian in a
temporary configuration home (`XDG_*`, `PI_CODING_AGENT_DIR`, `DSH_HOME` all point into a throwaway
directory that is deleted afterwards). Output that is not a plain version string, a non-zero exit,
or a timeout produces `version: null` rather than a guess.

Each candidate is reported with its origin, its version, whether that version equals the pinned
adapter version, and the ID of a saved installation that already points at the same path. An engine
is `ready` when a pinned match exists, `version-mismatch` when only other versions were found, and
`missing` when nothing was found. Only the pinned version can start a session, so a mismatch stays
visible and editable but is not treated as usable.

Detection runs the CLI, so it is available on macOS and Linux desktop builds only. Browser preview
returns a report marked unsupported instead of failing.

## Using a detected CLI

**Use this CLI** saves the detected path as an engine installation (when none refers to it yet) and
then runs the existing installation check, which records the version and the supported runtime mode.
Nothing is adopted silently: the saved entry is an ordinary library item that can be renamed,
edited, or removed.

## What a download does

**Download `<version>`** runs, with no shell:

```text
npm install --prefix <userData>/engines/<kind> --ignore-scripts --no-audit --no-fund --save-exact <package>@<version>
```

| Engine           | Package                           | Pinned version |
| ---------------- | --------------------------------- | -------------- |
| OpenCode         | `opencode-ai`                     | 1.18.16        |
| Pi               | `@earendil-works/pi-coding-agent` | 0.85.1         |
| DeepSeek Harness | `@deepseek-ai/dsh`                | 0.1.5-rc.2     |

The renderer sends only an engine kind. The package name, the version, the destination, and the
arguments are fixed in the main process, so a compromised renderer cannot install something else.
Lifecycle scripts stay disabled, and the install writes only under `userData/engines/<kind>`.

Afterwards the new `node_modules/.bin/<binary>` is detected and its version command is run like any
other candidate. A package whose binary needs its install scripts therefore fails the check and is
reported as a failed download instead of being presented as ready; the exact command stays visible
in the panel so it can be run in a terminal instead. `npm` itself is located the same way engines
are; without it, download is unavailable and the panel says so.

One check and one download run at a time. Quitting the application aborts both.

## Boundaries

- A matching version is not a guarantee: starting a session still runs the existing configuration,
  credential, native-source and native-state checks.
- Detection never writes to the workspace. Adopting a CLI writes one installation entry and then
  uses the same probe that the **Check installation** button uses.
- Windows is out of scope for both detection and downloads, matching the desktop runtime.
- Network access and registry availability are the user's; a failed download reports the failure
  rather than retrying silently.

## Verification

`tests/engine-discovery.test.ts` covers the pinned download arguments, search order, status
grouping, and the browser-preview report, and drives the real main-process code against fake CLIs
and a fake `npm`: a pinned match, another version, an unreadable version command, a successful
download that is verified afterwards, a download that produces no runnable CLI, and a missing `npm`.
