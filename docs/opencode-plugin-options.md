# OpenCode plugin configuration

Selected installed OpenCode plugins now have an **OpenCode plugin configuration (JSON)** field in the English and Simplified Chinese native-plugin editor. The adapter passes this object through OpenCode 1.18.16's native `[module, options]` tuple, so both legacy initializers and V1 `server(input, options)` receive the configured data.

## Editing and capture

The JSON root must be an object. Nested arrays, booleans, finite numbers, strings and null are supported. Configuration is limited to 64 KiB, 12 nesting levels, 4,096 values, 16,384 characters per string and 200 characters per key. The shared plain-configuration validator rejects accessors, cycles, non-JSON values and the reserved keys `__jsExpr`, `__proto__`, `constructor` and `prototype`.

Saving, inspecting files and creating a capture do not execute the selected plugin. OpenCode's normal configuration readback and native launch do execute it. A plugin's own configuration requirements remain its responsibility; successful draft validation alone does not prove that the plugin accepts the options.

Example configuration:

```json
{
  "enabled": true,
  "labels": ["review", "中文"],
  "output": { "format": "markdown", "maxItems": 5 }
}
```

Options belong to the native-plugin reference and are shared by profiles selecting that reference. Saved edits appear in the library impact preview and as pending plugin changes in retained conversations. Active processes keep their previous options. A new session captures the edited object; native resume retains the original captured object, including after application restart. Capture and attachment identities already include the plugin reference, so changing ordinary options changes new capture identities without rewriting old snapshots.

**Clear plugin options** removes the optional field. References without options retain their existing string declaration and native default behavior. Explicit `{}` produces a tuple with an empty object. Legacy workspace and snapshot shapes acquire no defaults, preserving their digests and activation identities.

Switching installations preserves the saved options' engine kind. The editor explains a mismatch instead of silently converting OpenCode configuration to DSH configuration. Clear the old options before entering configuration for the new engine. Launch validation rejects mismatched kinds; Pi has no generic JSON option mapping.

## Native and data boundaries

The adapter preserves the native loader's option delivery, initializer ordering, alias identity and V1 receiver. The existing activation and current-instance checks remain required. Configuration readback compares the generated tuple with native configuration; it is separate from evidence that a plugin uses every option correctly.

OpenCode expands native configuration macros before JSON parsing. Generated option **keys and values** escape opening braces in the serialized JSON so strings such as `{env:NAME}` and `{file:path}` reach the plugin literally. Only expressions created by the adapter for supported credential/Prompt mappings are expanded. This option field does not resolve environment values, read referenced files or evaluate expressions.

Options are ordinary persisted configuration, not secret storage. Keep provider keys in the shared connection's credential references. Plugin-specific secret-reference injection is not implemented. Configuration reports indicate plugin changes and activation without exposing arbitrary option bodies.

## Verification

- Unit tests verify native tuple generation, literal macro keys/values, unchanged legacy string declarations, immutable captures and rejection of an incompatible engine kind. Existing shared bounded-JSON tests cover invalid and oversized values.
- The [installed CLI result](probes/2026-09-19-opencode-plugin-options-native.json) verifies legacy and V1 options, nested literals, macro keys, unchanged native-resume inputs after saved edits, and edited options reaching the provider from a new capture. Existing failure, source-drift and instance-activation checks also pass.
- The [Electron lifecycle result](probes/2026-09-19-opencode-plugin-options-desktop.json) verifies both editor languages, saved edits and impact reports, active-session isolation, new-session options, persistence, application interruption and native resume.
- The [configuration editor result](probes/2026-09-19-plugin-options-editor.json) checks engine switching retains an explicit kind until cleared and preserves existing three-engine file-inspection behavior without executing plugin code.

Evidence uses synthetic credentials and a local HTTP provider on macOS arm64. This change does not establish arbitrary plugin compatibility, full dependency provenance, external-provider acceptance or a delivery gate.

The desktop crash fixture still requires every owned process group to disappear and the provider stream to close. If a signal-zero probe returns `EPERM`, it checks fresh process-group membership with `ps`; denied signal permission is never treated as proof of exit.

Run the activation fixture with `AGENT_MATRIX_TEST_OPENCODE` and `AGENT_MATRIX_OPENCODE_ACTIVATION_REPORT` using `npx vitest run --config vitest.opencode.config.ts tests/opencode-plugin-activation.probe.ts --maxWorkers=1`. After building, run `node --experimental-strip-types scripts/session-smoke.mjs` with the OpenCode executable and `AGENT_MATRIX_SESSION_REPORT`; `AGENT_MATRIX_PLUGIN_OPTIONS_SCREENSHOT` records both editor languages. Run `node scripts/smoke.mjs` separately with `AGENT_MATRIX_PLUGIN_REPORT` for the configuration editor fixture.
