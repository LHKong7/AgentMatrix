# Session list

**Session list** is a workspace-level view of every conversation this installation has run. The
**Sessions** page remains the place to start and drive one conversation; the session list is where
past and current work is found again.

## What it shows

- Five counters: total, active, waiting for a response, finished, and failed. Every session status
  belongs to exactly one group (`src/shared/sessions/list.ts`), so the counters add up to the total.
- A filter (all / active / needs a response / finished / failed) and a search over the agent name,
  working directory, conversation ID, and engine version.
- One row per conversation, most recent activity first, with the agent name, status, working
  directory, engine version, and last update.
- A record pane for the selected conversation: when it started and last changed, the engine version
  and runtime mode, the working directory, the outcome of the last turn, whether a response is
  pending, and the latest saved events rendered with the ordinary transcript view.

Actions on the selected conversation: **Continue in Sessions** opens it in the sessions page,
**Browse full history** opens the existing paged history dialog (including its JSONL export), and
**Configuration report** opens the existing captured-configuration report.

## Where the records come from

The list reads `sessions.list()`, and the record pane reads the last 40 events through the same
`sessions.history()` boundary the history dialog uses. Nothing new is stored: events keep the
journal's existing credential masking, interaction response text stays out of the journal, and
conversations with no events yet show an empty record instead of an error. The list polls every five
seconds and can be refreshed explicitly.

An agent configuration that has been deleted is labelled as removed; the conversation itself is
untouched, because it runs from its own captured inputs.

Browser preview has no session storage, so the page states that and stays empty.

## Verification

`tests/session-list.test.ts` covers the status grouping (every status in exactly one group, and one
status filter plus `all` per session), ordering by most recent activity, search across agent name,
folder and identifier, and the counters.
