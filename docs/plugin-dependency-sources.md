# Selected plugin dependency sources

OpenCode, Pi, and DeepSeek Harness now record explicit relative module dependencies when capturing selected installed plugins. Changing only a helper module, while leaving the selected entry unchanged, invalidates startup or native resume with the old capture. Restoring the original observed sources allows the same capture to pass reuse checks again; ordinary native attachment checks still apply.

## Observed files

The planner parses source without importing or executing it. It follows runtime `import` and `export ... from` declarations, literal `import()` expressions, unshadowed literal `require()` calls, and TypeScript import-equals declarations. Type-only imports and exports are excluded. If the module binds or assigns `require`, its calls are conservatively recorded as unresolved.

Traversal follows explicit `./` and `../` references with `.js`, `.jsx`, `.mjs`, `.cjs`, `.ts`, `.tsx`, `.mts`, `.cts`, or `.json` extensions. These observations do not add formats to an engine's native loader. JSON dependencies are hashed without parsing their contents for imports. Each source also records package scope candidates up to the nearest existing `package.json` or filesystem root, including absent nearer candidates. A newly appearing module or package scope therefore counts as source drift.

Each observation contains the logical path, resolved physical path when present, SHA-256, byte count, and existence. Cycles terminate; shared paths are deduplicated, and symlink retargeting is checked even when bytes are unchanged. Import references resolve from the physical importing file; native processes continue importing the original installed files.

## Partial coverage

The report lists unresolved categories and counts per source: package imports, computed or shadowed calls, unsupported resolution forms, syntax failures, and parsing limits. It does not persist raw unresolved specifiers or file bodies. Built-in Node modules are ignored.

Package and virtual imports, extensionless or directory resolution, absolute and remote imports, computed imports, arbitrary file reads, and other runtime effects are outside the observed closure. Static traversal may include declarations in inactive branches; it is not a receipt of actual module loading. These observations do not freeze an installation or prevent same-user changes after verification. Source coverage remains **partial**, independently of native plugin activation evidence.

Inspection bounds are 1,000 aggregate external files, 64 MiB of tracked plugin bytes, 20 MB per module, 256 KiB per package manifest, and 64 package-scope ancestors. Files above 2 MiB retain their hash but are not parsed; source inspection also limits AST traversal to 200,000 nodes. Hard capture limits produce localized errors. The existing capture publication and reuse checks recheck observed files before launch.

## Persistence and bilingual reports

The optional manifest-v1 `externalSources.pluginDependencies` field groups observed file paths by native plugin reference and records unresolved categories. Every grouped path must refer to a captured external-file observation. The field has no default: legacy snapshots retain their original digest and display that no dependency observations were recorded. Existing native binding identities and activation receipt formats remain unchanged.

The English and Simplified Chinese **Configuration report** shows captured plugin names, source paths, digests, absence, resolved links, and unresolved categories. Viewing historical data does not rescan the installation or copy module/package contents. A source rejection remains separate from the last successful native activation observation, and failed resume does not rewrite the capture.

## Verification

- Unit tests cover the reproduced Pi helper-only drift, static syntax and type-only references, shadowed calls, nested cycles, JSON files, package-scope appearance, symlink changes, bounded inspection, legacy parsing, and historical reports without source bodies.
- Installed CLI fixtures verify helper-only changes are rejected before new provider calls for [OpenCode 1.18.16](probes/2026-09-19-plugin-dependencies-opencode.json), [Pi 0.85.1](probes/2026-09-19-plugin-dependencies-pi.json), and DSH 0.1.5-rc.2 through both [pi-ai](probes/2026-09-19-plugin-dependencies-dsh-pi-ai.json) and [DeepSeek-native](probes/2026-09-19-plugin-dependencies-dsh-deepseek-native.json) routes. Restoring helper bytes makes the original capture reusable.
- Electron fixtures cover dependency effects reaching the local provider, English/Chinese source reports, application restart, helper-only rejection without new requests, immutable historical inputs, and successful native resume after restoration for [OpenCode](probes/2026-09-19-plugin-dependencies-opencode-desktop.json), [Pi](probes/2026-09-19-plugin-dependencies-pi-desktop.json), and [DSH](probes/2026-09-19-plugin-dependencies-dsh-desktop.json).

These results use synthetic credentials and local providers on macOS arm64. Full dependency provenance, external-provider acceptance, other platforms, and delivery gates remain open.

To reproduce, run each engine's activation probe with `--maxWorkers=1` and the environment variables documented in its activation guide. Build once, then run `scripts/session-smoke.mjs` sequentially for each engine using `AGENT_MATRIX_SESSION_ENGINE`, its `AGENT_MATRIX_TEST_*` executable path, and `AGENT_MATRIX_SESSION_REPORT`. Set `AGENT_MATRIX_DEPENDENCY_SCREENSHOT` to an output prefix for English and Chinese screenshots. Do not rebuild while an Electron fixture is running.
