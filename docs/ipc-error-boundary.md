# IPC exception projection

Every invoke handler now projects unexpected exceptions before Electron receives them. The application-level registration helper covers workspace operations, credential operations, Skill import, engine/plugin inspection, native import, directory selection and history export. Session handlers retain their owner-bound registration and use the same exception projection. Sender verification runs inside the boundary and precedes service execution.

## Reproduced defects

Some application handlers previously bypassed `safeSessionOperation`. A missing Skill source produced a native filesystem exception containing the selected path. The new Electron fixture failed against the previous build because a synthetic private marker embedded in that path appeared in the preload rejection.

The existing wrapper also trusted any `Error.message` beginning with a valid application error payload and rethrew the original object. A dependency could therefore supply a recognized error key with private parameters, a cause or other properties. Two unit cases failed before the fix: a forged error was passed through, and a modified application error lost its original localized diagnostic.

## Error contract

`appError` records its serialized payload in a module-local `WeakMap` when the error is constructed. At the invoke boundary, `copyAppError` recognizes only these local objects and creates a fresh exception from that original payload. It preserves the intended code and localization parameters but does not retain the original stack, cause, added properties or later message/parameter mutations. Fresh projected application errors remain recognizable when an operation passes through nested wrappers.

A message prefix alone is insufficient. Unknown exceptions become a static operation error, and Zod failures become `error.invalidData`. The renderer can still decode Electron-wrapped error codes through the existing translation path. Parsing a code for display is separate from trusting an exception inside the main process.

The registry is not a secret scanner. Intentional `appError` parameters remain visible, including supported configuration feature diagnostics and the workspace location in an unreadable-file error. Successful response payloads, saved ordinary configuration text, fatal startup errors, unrelated operating-system logs and native agent transcripts retain their separate boundaries. This change does not complete X3.

## Verification

On September 19, 2026, all 983 unit tests across 61 files, lint, typecheck/build, the ten-case IPC desktop fixture and the existing full desktop smoke passed on macOS arm64. The two Electron suites ran sequentially after the build completed; no native agent suite was rerun for this application-error change.

`tests/session-ipc.test.ts` adds seven cases for raw/schema/forged errors, original payload preservation, synchronous/asynchronous service failures and sender rejection before execution. Existing ownership, subscription and bilingual error-formatting cases remain in place.

The original `scripts/ipc-errors-smoke.mjs` fixture invokes the real preload API in both locale settings. It selects a missing Skill path, injects a forged chooser exception, exercises a known unsafe-source error, and forces actual workspace read/save failures using a temporary self-referencing symlink. The fixture restores workspace bytes afterward and checks that each rejected Skill import releases its busy state. It captures Electron stderr during these operations and checks both replies and logs for the synthetic marker. The native chooser is controlled; IPC, filesystem services and error projection are real.

```sh
AGENT_MATRIX_IPC_ERRORS_REPORT=/absolute/path/to/ipc-errors.json npm run test:ipc-errors
```

The test launches one Electron application without an agent or provider. Run it after the build completes and separately from other desktop/native suites. The [dated verification record](probes/2026-09-19-ipc-error-boundary.json) links the desktop output and records the exact source hashes and regression results.

## Duplicate Skill diagnostics

The September 20 follow-up found that OpenCode and Pi deliberately interpolated a Skill's frontmatter name into a trusted configuration error. The IPC wrapper correctly preserved that application error, including the source text. A synthetic private value used as the duplicate name reached the preload rejection in the previous Electron build. Four factory regressions also failed before the fix, covering Markdown and captured-directory Skills in both adapters.

Both adapters now emit the static `skill.duplicate` feature diagnostic, matching DSH's existing behavior. English and Chinese error formatting remains available. Rejection occurs during capture, before credential resolution or native attachment; the fix neither decrypts credentials to inspect names nor rewrites source content. Removing the duplicate binding permits capture with the original Skill body intact. Saved ordinary content remains outside this error-only boundary.

All **987 unit tests in 61 files**, lint, typecheck/build and the expanded **14-case Electron fixture** pass. The four new desktop cases cover OpenCode/Pi in both locale settings and verify unchanged saved configuration, no published session or run capture, and no marker in replies or captured Electron stderr. Installation metadata and an unused executable are fixtures; no installed CLI or provider is invoked. Directory capture and bilingual message formatting are exercised by the factory regressions. The [desktop result](probes/2026-09-20-skill-diagnostic-desktop.json) records the new cases. This closes the duplicate-name disclosure without completing the wider X3 audit.
