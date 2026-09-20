# Model configuration follows the CLI

Model routes are per-agent configuration (see [shared setup](shared-setup.md) for what is shared
instead). A model profile and connection describe a provider route; what may be filled in depends on
the CLI that will run it. OpenCode, Pi and DeepSeek Harness map different protocols, accept
different authentication strategies, and ignore or reject different parameters. The editors
therefore ask which engine the values are for and describe that engine's rules field by field.

## The table

`src/shared/engines/model-requirements.ts` holds one entry per engine and route:

|                     | OpenCode 1.18.16                                                                                                         | Pi 0.85.1                                                      | DeepSeek Harness 0.1.5-rc.2                                                         |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| Routes              | chat completions, responses, Anthropic messages, Gemini                                                                  | the same four                                                  | the same four plus the native `deepseek-official` route                             |
| Authentication      | bearer, API key or none on chat completions; bearer on responses; `x-api-key` for Anthropic; `x-goog-api-key` for Gemini | bearer on the OpenAI routes; the same standard API-key headers | bearer on the OpenAI routes and the native route; the same standard API-key headers |
| Temperature / top-p | applied on every route                                                                                                   | OpenAI routes only                                             | never applied                                                                       |
| Reasoning           | not mapped                                                                                                               | `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`      | `off`, plus `low`, `high`, `max` on the native route                                |
| Custom headers      | forwarded                                                                                                                | forwarded                                                      | `User-Agent` is reserved; the native route takes no custom headers                  |
| Base URL            | Anthropic accepts a provider root or a `/v1` base                                                                        | the same                                                       | the same                                                                            |

Everything in that table is also enforced at launch by `engineConfigurationIssues`. A test walks
every engine × route × authentication × header × reasoning combination and asserts the table and
the validator agree, so the editors cannot drift from what a session will accept.

## In the editors

- **Connections** and **Models** start with **Configure for engine**. It defaults to the engine an
  agent already binds to that resource, or to the only installed supported engine; otherwise it
  asks. The choice guides the form and is _not_ saved: a profile stays shared.
- The **route** list marks which engines map each protocol, and marks the ones the selected engine
  cannot use. Choosing a route that needs a fixed API-key header rewrites the header.
- The **authentication** list only offers strategies the selected route accepts, plus whatever the
  draft already uses.
- **Model ID** shows the identifier form the route expects as its placeholder and hint.
- **Temperature/top-p** warn when the engine ignores them, and **reasoning** becomes a list of the
  values the route accepts instead of free text (free text remains where an engine has no list).
- Every editor, and the agent editor's General tab, ends with an **Engine requirements** checklist:
  route, base URL, authentication, credential reference, custom headers, model ID, sampling and
  reasoning, each reported as ready, still to fill in, not requested, or blocked with the reason.

## Boundaries

These are adapter rules for the pinned engine versions. A passing checklist does not prove the
provider accepts the request: starting a session still runs the configuration, credential, native
source and native state checks, and the session's configuration report remains the record of what
was actually used. Values that another engine rejects stay editable, because one profile can be
shared by agents on different engines — the checklist reports them per engine instead of deleting
them.
