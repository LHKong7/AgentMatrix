export const pluginEn = {
  'plugin.clearOptions': 'Clear plugin options',
  'plugin.dshOptions': 'DSH plugin configuration (JSON)',
  'plugin.dshOptionsHint':
    'Plain configuration passed to the native plugin schema. Up to 64 KiB; executable expression objects are not accepted. Keep API keys in shared credential references.',
  'error.dshPluginEntry':
    'Select a compiled DSH JavaScript module or an installed package with an explicit root import export, main entry, or index.js. Export arrays and TypeScript sources are not supported.',
  'error.dshPluginBundle':
    'This directory is a DSH patch bundle. Select a component module explicitly; bundle patch import is not implemented yet.',
  'error.dshPluginId':
    'DSH plugin IDs must be unique, use up to 100 letters, digits, hyphens or underscores, and not conflict with managed component IDs.',
  'error.dshPluginRange':
    'The installed plugin declares an incompatible or invalid DSH or Cordis peer dependency range.',
  'error.dshPluginFramework':
    'The installed DSH or Cordis framework differs from the verified plugin loader versions, or its files could not be inspected.',

  'plugin.inspect': 'Inspect installed files',
  'plugin.inspecting': 'Inspecting files…',
  'plugin.result': 'Installed file inspection',
  'plugin.filesOnly': 'Files checked · Activation unverified',
  'plugin.scope':
    'Checks the entries and package metadata resolved for the selected engine. Supported plugins are checked again at session startup and resume. Transitive dependencies are not captured; this inspection alone does not prove activation.',
  'plugin.engineHint': 'Choose an OpenCode, Pi, or DeepSeek Harness installation to inspect files.',
  'plugin.versionHint':
    'Entry resolution follows {engine} {version}. The selected engine version has not been verified against this contract.',
  'plugin.package': 'Package name',
  'plugin.version': 'Package version',
  'plugin.range': 'Declared {engine} version range',
  'plugin.rangeHint':
    'Engine ranges use the saved CLI version. Other dependencies require separate checks; this inspection does not verify runtime compatibility.',
  'plugin.range.matched': 'The declared range includes saved {engine} version {version}.',
  'plugin.range.mismatched': 'The declared range excludes saved {engine} version {version}.',
  'plugin.range.undeclared': 'No {engine} version range is declared; compatibility is unknown.',
  'plugin.range.invalid-range': 'The declared {engine} version range is invalid.',
  'plugin.dependencyUnverified':
    'This dependency version has not been inspected. The saved CLI version does not establish its compatibility.',
  'plugin.range.engine-unverified': 'Check the engine installation before comparing its version.',
  'plugin.range.invalid-version': 'The saved engine version is not a valid semantic version.',
  'plugin.unknown': 'Not declared',
  'plugin.entry': 'Resolved entries',
  'plugin.localSource': 'Local source',
  'plugin.checkedAt': 'Checked at',
  'plugin.digest': 'Entry SHA-256',
  'plugin.metadataDigest': 'Package metadata SHA-256',
  'plugin.metadataSource': 'Package metadata source',
  'plugin.useVersion': 'Use package version',
  'plugin.versionMismatch':
    'The configured version differs from the installed package version. Review it before saving.',
  'plugin.idHint':
    'V1 exported IDs are checked at startup. For OpenCode legacy modules and Pi extensions without an exported ID, this is a label; source digests identify the binding. DSH uses this as a unique native component ID; distinct IDs allow separate instances of the same module.',
  'error.pluginDesktopOnly': 'Installed plugin inspection is available in the desktop app.',
  'error.pluginBusy': 'Another plugin inspection is still in progress.',
  'error.pluginEngine':
    'Choose a saved OpenCode, Pi, or DeepSeek Harness installation before inspecting a plugin.',
  'error.pluginPath': 'Enter an absolute path on this computer to an installed plugin.',
  'error.pluginMissing': 'The selected plugin or its declared entry is missing.',
  'error.pluginFile': 'Plugin entries and package metadata must be regular files.',
  'error.pluginMetadata':
    'The resolved package.json contains invalid or oversized metadata fields.',
  'error.pluginEntry':
    'A supported server entry could not be identified. Select a JavaScript/TypeScript file or a package with an explicit server entry.',
  'error.pluginOutside': 'The declared entry resolves outside the selected plugin directory.',
  'error.pluginLimit': 'Inspection is limited to 256 KiB of package metadata and a 20 MB entry.',
  'error.pluginChanged': 'Plugin files changed during inspection. Retry after edits finish.',
  'error.pluginRead': 'The installed plugin files could not be read.',
  'error.pluginExports':
    'Select an ESM plugin with explicit JavaScript/TypeScript exports. CommonJS and export-star entries are not supported yet.',
  'error.pluginDuplicate': 'Two selected plugins resolve to the same entry. Keep one binding.',
  'error.pluginVersion': 'The installed package version differs from the selected plugin version.',
  'error.pluginRange':
    'The installed plugin requires a different OpenCode version or declares an invalid version range.',
  'error.piPluginEntry':
    'Select a Pi extension file, an index.ts/index.js directory, or a package with explicit pi.extensions file entries. Glob and directory entries are not supported yet.',
  'error.piPluginResources':
    'This Pi package also declares Skills, prompts, or themes. Select an extension file explicitly and configure shared assets separately.',
  'error.piPluginRange':
    'The installed extension declares an incompatible or invalid Pi peer dependency version range.',
} as const
