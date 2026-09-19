# Application crash cleanup

Updated: **2026-09-19**.

A reproduced failure left a native CLI and a resistant descendant running after the application host received `SIGKILL`. Electron quit hooks cannot execute in this case. `ManagedProcess` now starts a guardian before launching any native executable, so cleanup can continue independently of the application.

## Ownership and recovery

The guardian and native CLI use separate POSIX process groups. The main process sends the executable, argument array, working directory and explicit environment through private IPC only after the guardian announces startup. Public PID, exit code and signal retain the native CLI's identity; selected-plugin receipts and session checks therefore continue to refer to the actual engine.

The guardian streams stdin/stdout/stderr without parsing protocol messages. IPC disconnection, stdin EOF, explicit stop or native exit begins group cleanup: `SIGTERM`, a grace period, then `SIGKILL` if members remain. Cleanup timers remain referenced after the parent or native leader exits. Pipes receive a bounded drain period; truncated output stays explicit. The main process also retains cleanup ownership and takes over if the guardian unexpectedly exits after reporting the native PID. Completion requires the native group to disappear, the guardian to exit and owned pipes to close. A termination timeout remains an error rather than proof of completion.

The guardian runs fixed bundled source using `process.execPath`. Electron uses its documented [`ELECTRON_RUN_AS_NODE` mode](https://www.electronjs.org/docs/latest/api/environment-variables#electron_run_as_node); native engines receive only their original explicit environment. No provider key or resolved launch data is added to guardian arguments. Parent-death detection uses Node's [IPC disconnection event](https://nodejs.org/api/child_process.html#event-disconnect) and pipe closure.

Session journals remain the authority after restart. Unfinished conversations become interrupted. Restart does not resubmit a prompt; explicit resume revalidates the retained capture and asks the engine to restore its original native session. A crash can still interrupt native file writes, and native restoration may fail. Such failure must stay visible instead of creating a replacement conversation.

## Verification

The subprocess regression bundles the production supervisor into an isolated Node host, launches a native leader and a descendant that ignores `SIGTERM`, then kills either the host or its guardian. Both cases require the native leader, descendant, group and guardian to disappear. Additional tests cover cancellation before guardian startup, native nonzero exit codes, complete large output, spawn failures, normal termination, resistant descendants, ACP failure, explicit environments and credential masking.

The desktop fixture also kills the actual Electron main process during an active provider turn. It records owned descendant group identities before the crash, waits for their disappearance and provider-stream closure, then restarts the same isolated application data. It checks interrupted history without automatic resubmission and explicitly resumes the same native session and captured configuration. Normal quit/restart and bilingual configuration, history and lifecycle checks remain in the fixture.

The following installed-engine fixtures passed on **macOS arm64, 2026-09-19**, using Electron **44.4.1** and a local Chat Completions service with synthetic credentials. Each crash cleaned four groups: two guardians and the two conversations' native engines. No external model service was called.

| Engine           | Installed version | Desktop result                                                               |
| ---------------- | ----------------- | ---------------------------------------------------------------------------- |
| OpenCode         | 1.18.16           | [Recorded lifecycle and crash checks](probes/2026-09-19-crash-opencode.json) |
| Pi               | 0.85.1            | [Recorded lifecycle and crash checks](probes/2026-09-19-crash-pi.json)       |
| DeepSeek Harness | 0.1.5-rc.2        | [Recorded lifecycle and crash checks](probes/2026-09-19-crash-dsh.json)      |

Run `npx vitest run tests/process-crash.test.ts tests/managed-process.test.ts --maxWorkers=1` for the subprocess checks. Run the [desktop session fixture](desktop-sessions.md#reproducible-verification) once per installed engine for end-to-end verification. Run native suites sequentially and do not rebuild while a desktop fixture is active.

## Boundaries

The guarantee assumes one supervisor survives long enough to clean its known group. Simultaneous termination of the main process and guardian, guardian death before native identity delivery, machine failure and deliberately detached descendants are outside it. This is process cleanup, not filesystem or network isolation. Closing a local provider stream also does not prove that a remote service stopped processing its request.

Windows supervision is unsupported. Linux requires separate acceptance. Packaged, signed and notarized builds require their own checks; the guardian needs Electron's `runAsNode` fuse enabled. Disabling that fuse is incompatible with this implementation and cannot inherit development-build evidence. External provider routes, complete native provenance and the broader X3/X4 and delivery gates remain open.
