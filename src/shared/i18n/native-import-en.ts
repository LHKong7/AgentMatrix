export const nativeImportEn = {
  'nativeImport.title': 'Import native configuration',
  'nativeImport.description':
    'Select an OpenCode JSON/JSONC file to preview shared connections, models, prompts, MCP definitions, and draft Agents.',
  'nativeImport.installation': 'Import for engine installation',
  'nativeImport.choose': 'Choose configuration file',
  'nativeImport.reading': 'Reading configuration…',
  'nativeImport.preview': 'Import preview',
  'nativeImport.apply': 'Import configuration',
  'nativeImport.importing': 'Importing…',
  'nativeImport.scope':
    'This imports the selected file only. Native precedence, referenced files, plugins, and unsupported fields are not applied automatically. New Agents are disabled drafts for review.',
  'nativeImport.secrets':
    '{count} literal secrets will be stored as encrypted credentials. Environment references remain references. Secret values are not included in this preview.',
  'nativeImport.archive':
    'The exact source file, including comments and unconverted fields, is retained in encrypted application storage. The original file is never modified.',
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
    'Save an OpenCode installation in Engines first. The import itself does not run or verify the CLI.',
  'nativeImport.diagnostic.unconverted':
    'Retained in the encrypted source; no shared mapping is applied.',
  'nativeImport.diagnostic.invalid-value':
    'This value cannot be represented by the shared field; review the draft.',
  'nativeImport.diagnostic.unresolved-reference':
    'Reference retained without reading a file or resolving an environment value.',
  'nativeImport.diagnostic.review-policy':
    'Native policy requires review; the imported Agent remains disabled.',
  'error.nativeImportDesktopOnly': 'Native configuration import is available in the desktop app.',
  'error.nativeImportEngine': 'Select a saved OpenCode installation for this import.',
  'error.nativeImportSyntax':
    'The selected file must be a JSON/JSONC object without duplicate keys. No source contents were logged.',
  'error.nativeImportLimit':
    'Import is limited to 1 MiB, 4,000 values, 32 levels, and 200-character keys.',
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
