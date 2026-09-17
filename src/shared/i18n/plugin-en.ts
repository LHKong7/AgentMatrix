export const pluginEn = {
  'plugin.inspect': 'Inspect installed files',
  'plugin.inspecting': 'Inspecting files…',
  'plugin.result': 'Installed file inspection',
  'plugin.filesOnly': 'Files checked · Activation unverified',
  'plugin.scope':
    'Checks the selected local entry and adjacent package metadata. Dependencies, exported plugin ID, hooks, and runtime compatibility still need verification. Session activation is not yet available.',
  'plugin.engineHint': 'File inspection currently supports OpenCode installations.',
  'plugin.versionHint':
    'Entry resolution follows OpenCode {version}. The selected engine version has not been verified against this contract.',
  'plugin.package': 'Package name',
  'plugin.version': 'Package version',
  'plugin.range': 'Declared OpenCode version range',
  'plugin.rangeHint': 'This declaration is displayed without evaluating compatibility.',
  'plugin.unknown': 'Not declared',
  'plugin.entry': 'Resolved server entry',
  'plugin.localSource': 'Local source',
  'plugin.checkedAt': 'Checked at',
  'plugin.digest': 'Entry SHA-256',
  'plugin.metadataDigest': 'Package metadata SHA-256',
  'plugin.useVersion': 'Use package version',
  'plugin.versionMismatch':
    'The configured version differs from the installed package version. Review it before saving.',
  'plugin.idHint':
    'Enter the native plugin ID separately; a package name does not establish the exported plugin ID.',
  'error.pluginDesktopOnly': 'Installed plugin inspection is available in the desktop app.',
  'error.pluginBusy': 'Another plugin inspection is still in progress.',
  'error.pluginEngine': 'Choose a saved OpenCode installation before inspecting a plugin.',
  'error.pluginPath': 'Enter an absolute path on this computer to an installed plugin.',
  'error.pluginMissing': 'The selected plugin or its declared entry is missing.',
  'error.pluginFile': 'Plugin entries and package metadata must be regular files.',
  'error.pluginMetadata':
    'The adjacent package.json contains invalid or oversized metadata fields.',
  'error.pluginEntry':
    'A supported server entry could not be identified. Select a JavaScript/TypeScript file or a package with an explicit server entry.',
  'error.pluginOutside': 'The declared entry resolves outside the selected plugin directory.',
  'error.pluginLimit': 'Inspection is limited to 256 KiB of package metadata and a 20 MB entry.',
  'error.pluginChanged': 'Plugin files changed during inspection. Retry after edits finish.',
  'error.pluginRead': 'The installed plugin files could not be read.',
} as const
