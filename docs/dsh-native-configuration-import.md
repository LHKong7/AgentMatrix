# DeepSeek Harness native configuration import

Updated: **2026-09-19**. The importer interprets explicitly selected files against the installed **DSH 0.1.5-rc.2** contract. It reuses [encrypted import storage and recovery](native-configuration-import.md) and creates disabled Agent drafts for review. Both the generic Pi-AI route and the native DeepSeek route pass local Electron/provider fixtures.

## Select files

Save a DeepSeek Harness installation, then open **Settings → Import native configuration**. The installation path need not be executable to preview or import. Choose any of the following files; use **Add files to preview** to select additional files from another folder. This supports profile and harness-home sources without copying or editing them. Each exact filename can appear once, with at most four files per import. Cancelling an additional selection preserves the preview. Adding files creates a new preview and invalidates its predecessor.

| File                | Interpretation                                                                                           |
| ------------------- | -------------------------------------------------------------------------------------------------------- |
| `cordis.yml`        | A selected array of native component rows, including a previously exported composed tree                 |
| `cordis.patch.yml`  | Root insertions and updates to selected rows by ID, applied after `cordis.yml`                           |
| `settings.yaml`     | Explicit provider namespaces and default model selection, layered over selected component configurations |
| `.credentials.yaml` | The version-1 native credential document: named references and provider-owned records                    |

The chooser shows hidden files. Import reads only the selected files: it does not execute the CLI, discover bundles, traverse `package.json`, load plugins, evaluate JavaScript, read the host environment, follow includes, or search adjacent `.env`/credential files. It never rewrites the originals. Custom settings filenames and other native source layers require further ingestion support.

## Composition and field provenance

The selected base rows are copied before applying patches. Root `insert` rows become available to later patches in the same list. An update requires a matching selected ID; an explicit mismatched module name is not applied. Each supplied row field replaces the corresponding field wholesale, so a patch's `config` replaces the old configuration rather than merging it. Settings then recursively merge ordinary object fields over that result; arrays and other values replace their lower-layer values. Mapped fields retain the pointer to the winning selected source.

Only explicit module names for `dsh-llm-pi-ai`, `dsh-llm-deepseek`, `dsh-agent-default-model`, and `dsh-system-prompt` are interpreted. An ID such as `llm-pi-ai` alone does not prove which module a missing bundle would supply. Unmatched patches, grouped insertions, scoped/conditional components, repeated known module instances, and other components stay diagnostic. A selected disabled known module does not become active merely because settings name its namespace. Settings-only import creates declarations for review; it does not establish which modules a user's native profile mounts.

Unknown and overridden values remain in the encrypted original files. Diagnostic paths show the original locations; they do not contain the original values. This is partial selected-source composition, not discovery of the complete native profile, global/home/CLI precedence, or observed effective configuration.

## Shared connections, models, and credentials

Generic routes map explicit API names, endpoints, model IDs, display names, headers, and supported reasoning declarations into shared connections/models. Missing catalog-derived APIs or endpoints remain unresolved. Native DeepSeek keeps its distinct `deepseek-official` protocol and documented default key reference. A native model's absent reasoning setting retains the native `high` default; explicit selection and disabled thinking take precedence. Unsupported shared-runtime reasoning values are still subject to launch validation.

Explicit `agent-default-model` provider/model fields select the imported profile's model; the importer never chooses the first model arbitrarily. Compatibility options, matching model overrides, and model-specific behavior that the shared schema cannot reproduce leave the affected model connection unresolved. Duplicate row IDs, route ownership, and model IDs fail rather than choosing an ambiguous source. Native catalogs, pricing, capacities and broad provider options are not inferred.

`apiKeyEnv` becomes an environment reference unless the selected credential document supplies its named stored value. In that case, the value enters the encrypted vault and the shared connection uses that explicit credential copy. Both the reference and the supplying field have provenance, and **a precedence diagnostic is required**: native DSH prioritizes its launching environment above the stored file and has additional `.env` fallbacks. Import does not inspect those values or reproduce that chain. Enabling the managed draft accepts the reviewed shared authentication choice.

Without `apiKeyEnv`, a selected Pi-AI API-key record can supply a literal key. Command/template records and records with environment overrides remain unresolved; grant/OAuth records stay opaque and mark an engine-login draft that the current DSH adapter cannot launch. No authorization or token refresh occurs. An explicit unresolved reference never falls back to a different stored record. Invalid versioned credential structures are rejected before creating entries.

Literal generic headers become vault references. Exact inert expressions such as `!!js process.env.HEADER_KEY` or `!!js process.env['HEADER_KEY']` become environment references without reading them. Other JavaScript remains an unresolved diagnostic. Native DeepSeek custom headers and conflicting/reserved dictionary entries are not silently converted. Ordinary strings containing dollar signs or `!!js` remain literal strings.

## Prompts, policies, and parser limits

A literal native persona prefix or suffix becomes a versioned shared Prompt in append mode with matching DSH placement. Native `{{variable}}` templates and executable Prompt expressions are retained as unresolved sources. If both positions have content, both Prompt assets are captured but neither is automatically bound: the current shared DSH profile has one append-placement option and cannot reproduce both positions at once. Native identity/runtime-context toggles are retained for review.

The Agent draft is disabled, has no working directory, uses the managed ACP profile, and requests tool approval. Native policy rows, arbitrary MCP/plugin components, Skill roots, bundle lists, watch settings and project discovery are not activated by import. Users can maintain the already-supported shared assets and installed-plugin bindings through their dedicated editors. General native component/bundle ingestion remains separate work.

Input is bounded to 1 MiB across all selected files and 4,000 values, 32 nesting levels, and 200-character keys per document. UTF-8 BOM and original line endings survive in the archive. YAML duplicate/non-string keys, aliases, merge keys, non-finite numbers, multiple documents and unknown tags are rejected. `!!js` is accepted only in Cordis files as an inert tagged scalar; it never becomes executable code in Electron.

Every file has its own path, resolved path, byte count and digest. Before publication, the importer rechecks all selected files and the workspace revision. Credentials, shared additions and immutable history use the existing transaction/recovery rules. The archive's encrypted envelope retains every original file exactly and checks roles, counts and digests. OpenCode and Pi archive formats remain compatible. The shared [credential-copy check](native-configuration-import.md#known-credentials-copied-into-ordinary-data) rejects extracted literal values repeated in ordinary fields, names or source metadata before returning a preview. It does not read unselected credential files or detect arbitrary secrets in author-controlled prose.

## Verification and remaining work

The macOS arm64 Electron fixtures pass on DSH 0.1.5-rc.2 with both routes:

- [Generic Pi-AI route](probes/2026-09-19-dsh-native-import-pi-ai.json): three encrypted credentials, literal/environment headers and one imported native turn.
- [Native DeepSeek route](probes/2026-09-19-dsh-native-import-deepseek-native.json): the distinct native protocol, one encrypted credential and one imported native turn.

Both fixtures select four files across two folders, cancel an additional selection, exercise English/Chinese controls, reject a changed secondary credential file, verify exact OS-encrypted archive bytes, restart, retry the committed import, explicitly probe the installation and enable the draft, and check the imported endpoint/key/model/Prompt in the actual provider request. Conflicting original endpoint/model/Prompt values do not appear in the request. A synthetic host key differs from the selected stored key; the fixture checks the precedence diagnostic and the managed stored-copy behavior. An executable-expression marker remains absent. Only the native file chooser is substituted.

```bash
AGENT_MATRIX_IMPORT_ENGINE=deepseek-harness \
AGENT_MATRIX_TEST_DSH=/absolute/path/to/dsh \
npm run test:native-import

AGENT_MATRIX_IMPORT_ENGINE=deepseek-harness \
AGENT_MATRIX_DSH_ROUTE=deepseek-native \
AGENT_MATRIX_TEST_DSH=/absolute/path/to/dsh \
npm run test:native-import
```

Unit coverage includes inert parsing, resource limits, exact leaf provenance, whole-config patch replacement, settings merge, disabled/conditional/ambiguous modules, credential precedence, unsupported templates/OAuth, both Prompt positions, per-file changes, additional-selection tokens, immutable history, restart/idempotence and failed-publication rollback. The full suite has 618 passing tests with two workers, plus lint, TypeScript and production build. An earlier default-concurrency run hit the existing five-second large-file Skill fixture limit; the limited-concurrency full run passed without changing that test.

These are local synthetic providers; no external endpoint or real credentials were used. Full native profile discovery/precedence, general bundle/component/MCP/Skill ingestion, broader compatibility/OAuth support, import archive retention/export and other-platform acceptance remain open. This increment does not pass D4 or the overall delivery gates.

## Primary references

The implementation was checked against the installed 0.1.5-rc.2 package READMEs, declarations and compiled source. Repository links below track upstream and may move beyond this pinned contract.

- [CLI profile composition](https://github.com/deepseek-ai/deepseek-harness/tree/master/apps/cli)
- [Settings merge contract](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/settings/settings/src/index.ts)
- [Local credential document and precedence](https://github.com/deepseek-ai/deepseek-harness/tree/master/packages/credentials/credentials-local)
- [Generic provider configuration](https://github.com/deepseek-ai/deepseek-harness/tree/master/packages/llm/llm-pi-ai)
- [Native DeepSeek provider](https://github.com/deepseek-ai/deepseek-harness/tree/master/packages/llm/llm-deepseek)
- [System Prompt component](https://github.com/deepseek-ai/deepseek-harness/tree/master/packages/core/system-prompt)
