# Shared configuration impact previews

Library editors now show **Impact before saving** in English and Simplified Chinese. The preview uses the same candidate that Save submits, including a newly appended Prompt or Markdown Skill revision and an imported directory Skill revision. It covers installations, connections, model profiles, Prompts, Skills, capability bundles, MCP definitions, and native plugin references.

## Profiles and binding rules

The comparison resolves the saved workspace and the proposed workspace with the same resolver used for session capture. Workspace validation and immutable asset-history checks run before comparison. A stale workspace revision is rejected.

Related profiles are listed even when a binding is disabled or shadowed. Resolution determines the result:

| Result                                  | Meaning                                                                                                                                 |
| --------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| Next session inputs change              | Both versions resolve, but one or more configuration fields differ.                                                                     |
| Resolved inputs stay the same           | Both resolve to the same inputs, for example because a binding pins an older revision or a direct binding overrides the changed bundle. |
| Draft or disabled                       | Impact cannot be resolved; it is not reported as unchanged.                                                                             |
| This draft makes the profile unresolved | The saved version resolved but the proposed version has a binding or configuration issue.                                               |
| This draft resolves the profile         | The proposed version resolves a previously unresolved profile. Native adapter validation is still required.                             |

The comparison includes endpoint and authentication references, model parameters, installation identity, execution choices, native options, resolved Prompt/Skill revisions and sources, MCP definitions, and native plugin references. It shares this projection with [session configuration reports](configuration-report.md). Connection/Agent display names and probe timestamps alone do not mark executable inputs as changed. Credential values and value rotations are not compared.

## Existing conversations

The desktop checks nonclosed conversation captures, including conversations whose profile or relevant binding was later removed. It shows retained Prompt/Skill versions next to the proposed bindings for a new session. Existing conversations continue to use their captured configuration, including after native resume.

Session differences compare the whole captured configuration against the proposed profile. A separate note identifies conversations that already differed before the current edit, so earlier pending changes are not attributed to the edit. A missing or unresolved profile remains explicit. Unreadable captures and identity mismatches are shown as unknown, even when their relationship to the edited item cannot be established.

Each page verifies at most 20 captures, counting unrelated and unreadable captures. The stable session-ID cursor advances across every scanned capture; an empty result page can still have more conversations to check. The UI exposes **Check more conversations** and **Reload**. Session inventory and status are observations, not an atomic or continuously updated view; refresh includes newly created conversations. Closed conversations are outside this preview. Journal enumeration itself still uses the existing session-list implementation.

## Read boundaries

The sender-checked `sessions.impact` IPC accepts a workspace revision, one typed library change, and an optional session cursor. The service has read access to the workspace and captured inputs. It neither saves the proposed workspace nor launches a CLI, resolves credentials, or rewrites captured inputs. The response contains only profile/session metadata, resolution issue codes, changed field names, and asset versions. It omits prompt bodies, header/environment values, executable arguments, file paths, and credential references.

Profile resolution parses each workspace once for the whole batch. The editor debounces drafts by 500 ms, serializes preview requests, skips obsolete queued drafts, and ignores replies from superseded drafts. Editing resets session pagination. A failed read clears the result instead of retaining a stale preview. A revision check after capture reads rejects a workspace change during analysis. Saving remains independent of the preview and uses the normal workspace validation/revision checks.

Browser preview resolves its own saved profiles and explicitly states that desktop conversations are unavailable. Directory Skill capture still happens through the existing explicit import action; previewing a directory revision does not import it or verify future adapter compatibility.

## Evidence and remaining work

`tests/library-impact.test.ts` covers shared bindings across OpenCode, Pi, and DeepSeek Harness; pinned/latest revisions; direct overrides; disabled bundles/profiles; conflicting bindings; endpoint/authentication changes; model, installation, MCP, and plugin effects; Markdown/directory Skill revisions; stale revisions and history rewrites; removed profiles; corrupt captures; bounded pagination; and workspace changes during reads. Production factory/coordinator tests verify retained captures without credential resolution or workspace writes. IPC tests cover owner, frame, and navigation boundaries.

The extended [desktop session smoke](desktop-sessions.md) checks previews before saving, revert/recompute behavior, retained v1 versus proposed v2, previously pending changes, unchanged workspace/session state during preview, and both UI languages. It continues through old/new native sessions and restart/resume. The message helper waits for the submitted turn to start or complete; a cursor advance alone can still expose the preceding Ready state.

Recorded macOS arm64 runs use OpenCode 1.18.16, Pi 0.85.1, and DSH 0.1.5-rc.2:

- [OpenCode desktop report](probes/2026-09-18-library-impact-opencode.json)
- [Pi desktop report](probes/2026-09-18-library-impact-pi.json)
- [DSH desktop report](probes/2026-09-18-library-impact-dsh.json)

The full unit suite (382 tests), ESLint, TypeScript, production build, and generic Electron configuration smoke passed. Provider fixtures are local and synthetic; they do not establish external-provider or cross-platform acceptance.

This implements the library-edit portion of B6. Native override provenance, native configuration import, credential-rotation metadata, and complete capability reporting remain open. Native plugin impact compares references; it does not implement plugin activation. The combined three-engine shared-asset runtime acceptance scenario also remains open. Inline library toggles, deletion, and Agent-profile editing do not yet have this before-save preview.
