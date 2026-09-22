# Shared assets across OpenCode, Pi, and DeepSeek Harness

The desktop acceptance fixture uses **one workspace, one shared Prompt, one directory Skill, one model profile, and one connection** across three Agent profiles. It exercises the combined update scenario in [the implementation plan](cli-agent-plan.md#8-phase-d-deepseek-harness-as-the-third-engine). The engine mappings remain separate; no runtime protocol translation or conversation migration is introduced.

## Scenario and evidence

The fixture starts a real Electron window and explicitly probes installed OpenCode **1.18.16**, Pi **0.85.1**, and DSH **0.1.5-rc.2**. It imports a directory containing `SKILL.md` and `references/guide.md` through the desktop editor, then binds that same Skill and the shared Prompt to all three Agents using latest-version selection. Only the native folder chooser is substituted; capture, persistence, editors, IPC, factories, adapters, and installed CLIs run unchanged.

All three profiles use the same OpenAI Chat Completions connection, model ID `fixture-model`, and synthetic bearer credential reference. A local HTTP server verifies authentication, the underlying model ID, streamed requests, and native tool round trips for each engine. DSH uses its generic `dsh-llm-pi-ai` component here. This proves compatibility with this particular local protocol fixture, not acceptance by an external model service or DSH's separate native provider route.

| Phase, repeated for each engine            | Captured Prompt / Skill | Checked behavior                                                                                                                  |
| ------------------------------------------ | ----------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| Initial conversation                       | v1 / v1                 | Shared prompt reaches system instructions; native tools load the captured Skill entry and reference                               |
| Turn running during shared edits           | v1 / v1                 | All three provider responses are held while both assets are updated; releasing them still yields v1 tool results and instructions |
| Another turn in the old conversation       | v1 / v1                 | Saved v2 does not replace an existing run's inputs; the report shows v2 pending                                                   |
| New conversation after edits               | v2 / v2                 | A separate run capture uses both new revisions; the report shows captured and saved versions agree                                |
| Old conversation resumed after app restart | v1 / v1                 | Native conversation ID and original input digest survive, with fresh attachment evidence                                          |
| New conversation resumed after app restart | v2 / v2                 | The newer native conversation likewise retains its own captured revisions                                                         |

There are six native conversations, eighteen completed turns, and fifty-four model requests in the tested round trips. Every turn asks for the Skill entry and then its reference file. OpenCode and DSH use their native `skill` tool; Pi uses native `read` for the captured `SKILL.md`. All three read the reference with their own tool argument format. The provider checks tool results correlated to that turn's unique call IDs, so a prior transcript entry cannot stand in for a fresh read. Prompt markers are checked in system/developer messages rather than arbitrary transcript text.

## Shared edits, reports, and capture boundaries

The shared Prompt is edited once in English and the Skill directory is reimported once in Chinese. Impact previews identify all three profiles and retained conversations. The existing Agent profiles and connection remain unchanged; no per-engine asset copies are added to the library. Both asset histories retain v1 when v2 becomes current.

While the turns are held, the fixture changes the original Skill source to unrelated, unimported content. It checks that each conversation is still running before releasing its response. After app quit, it deletes that original directory. Old turns, new captures, and resumed conversations continue to use their respective imported and captured bytes. The fixture compares the immutable manifest bytes across later turns and native restoration, and checks distinct input captures for the old and new conversations.

English and Chinese configuration reports show both assets' captured, next-session, and library versions. Historical observations remain historical after restart; successful native restoration publishes new evidence for the new process while retaining the same native conversation and snapshot. Each resumed conversation executes fresh tool calls before an explicit, confirmed Close.

## Reproduce

```sh
AGENT_MATRIX_TEST_OPENCODE=/absolute/path/to/opencode \
AGENT_MATRIX_TEST_PI=/absolute/path/to/pi \
AGENT_MATRIX_TEST_DSH=/absolute/path/to/dsh \
AGENT_MATRIX_SHARED_ASSETS_REPORT=/absolute/path/to/shared-assets.json \
npm run test:shared-assets
```

All three executable paths are required. The command builds the app, then runs `scripts/shared-assets-smoke.mjs`. It requires a desktop graphics environment, creates isolated application/home/project directories, uses synthetic credentials, and makes no external model calls. It does not install CLIs. Native OpenCode dependency initialization follows its existing adapter behavior. Successful fixtures remove temporary state; failed fixtures retain it for diagnosis after process cleanup.

The [recorded macOS arm64 result](probes/2026-09-19-shared-assets-desktop.json) records engine versions, executable paths, service/protocol/model, date, and per-turn observations. The home prefix in the checked-in executable path is redacted. This is native integration and UI evidence with a deterministic provider; it is not a model-quality evaluation.

## Remaining acceptance

The combined local shared-asset update scenario is covered. It does not pass B7, C4, or D4 by itself. Intended external endpoint/model/auth acceptance, full native configuration import and override provenance, credential-rotation reporting, and other required gate work remain open. Platform claims are limited to the recorded host.

MCP is checked separately: the [OpenCode configuration fixture](opencode-configuration.md) and [DSH configuration fixture](dsh-configuration.md) exercise native stdio MCP calls. Pi's core baseline rejects MCP bindings without a verified extension; see [engine compatibility](engine-capabilities.md). This scenario has no MCP bindings and supplies no new remote MCP or OAuth evidence. Fixed revision bindings and bundle precedence retain their separate resolver, impact-preview, and configuration-report tests.
