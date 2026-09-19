export const nativeImportEn = {
  'nativeImport.title': 'Import native configuration',
  'nativeImport.description':
    'Select native OpenCode or Pi configuration to preview shared library entries and draft Agents.',
  'nativeImport.piFiles':
    'For Pi, select models.json, auth.json, settings.json, SYSTEM.md and/or APPEND_SYSTEM.md from one folder. Only selected files are read. Commands and extensions are not executed; host environment values are not read. Review the execution policy before enabling the imported draft.',
  'nativeImport.installation': 'Import for engine installation',
  'nativeImport.choose': 'Choose configuration file',
  'nativeImport.reading': 'Reading configuration…',
  'nativeImport.preview': 'Import preview',
  'nativeImport.apply': 'Import configuration',
  'nativeImport.importing': 'Importing…',
  'nativeImport.scope':
    'This imports selected files only. Other native sources, referenced files, plugins, and unsupported fields are not applied automatically. New Agents are disabled drafts for review.',
  'nativeImport.secrets':
    '{count} literal secrets will be stored as encrypted credentials. Host environment values are not read during import. Secret values are not included in this preview.',
  'nativeImport.archive':
    'Exact source files, including unconverted fields, are retained in encrypted application storage. Original files are never modified.',
  'nativeImport.entities': 'New library entries',
  'nativeImport.diagnostics': 'Fields requiring review',
  'nativeImport.none': 'No unconverted fields.',
  'nativeImport.history': 'Saved import sources',
  'nativeImport.empty': 'No native configuration has been imported.',
  'nativeImport.source': 'Source at import',
  'nativeImport.mapping': 'Imported field mapping',
  'nativeImport.saved':
    'Configuration imported. Review and enable the new Agent drafts when ready.',
  'nativeImport.noInstallation':
    'Save an OpenCode or Pi installation in Engines first. The import itself does not run or verify the CLI.',
  'nativeImport.diagnostic.unconverted':
    'Retained in the encrypted source; no shared mapping is applied.',
  'nativeImport.diagnostic.invalid-value':
    'This value cannot be represented by the shared field; review the draft.',
  'nativeImport.diagnostic.unresolved-reference':
    'Reference retained without reading a file or resolving an environment value.',
  'nativeImport.diagnostic.review-policy':
    'Native policy requires review; the imported Agent remains disabled.',
  'error.nativeImportDesktopOnly': 'Native configuration import is available in the desktop app.',
  'error.nativeImportEngine': 'Select a saved OpenCode or Pi installation for this import.',
  'error.nativeImportSelection':
    'Choose one OpenCode JSON/JSONC file, or up to five different Pi files from one folder: models.json, auth.json, settings.json, SYSTEM.md and APPEND_SYSTEM.md.',
  'error.nativeImportSyntax':
    'JSON settings must contain objects without duplicate keys. Pi requires strict JSON; OpenCode also accepts JSONC. Source contents were not logged.',
  'error.nativeImportLimit':
    'Selected files are limited to 1 MiB in total; each JSON document to 4,000 values, 32 levels, and 200-character keys.',
  'error.nativeImportRead':
    'The selected configuration file could not be read as a regular UTF-8 file.',
  'error.nativeImportChanged':
    'The source file or installation changed after preview. Choose the file again.',
  'error.nativeImportExpired':
    'This import preview expired or is no longer available. Choose the file again.',
  'error.nativeImportBusy': 'Another native configuration import is in progress.',
  'error.nativeImportArchive': 'The encrypted import archive could not be saved or verified.',
  'error.nativeImportHistory': 'Saved native import provenance cannot be removed or rewritten.',
  'error.nativeImportRecovery': 'A prior import needs recovery before credentials can be changed.',
} as const
