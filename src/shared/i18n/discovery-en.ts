export const discoveryEn = {
  'discovery.title': 'Installed agent CLIs',
  'discovery.description':
    'AgentMatrix checks for a supported CLI when this page opens and can download a pinned version for you.',
  'discovery.boundary':
    'Detection reads each executable’s version command in a temporary configuration directory. It never changes native settings, and it never sends a prompt.',
  'discovery.check': 'Check again',
  'discovery.checking': 'Looking for installed agent CLIs…',
  'discovery.checkedAt': 'Checked {time}',
  'discovery.never': 'Not checked yet',
  'discovery.status.ready': 'Pinned version installed',
  'discovery.status.version-mismatch': 'Installed, other version',
  'discovery.status.missing': 'Not installed',
  'discovery.expected': 'Pinned version {version}',
  'discovery.origin.managed': 'Downloaded by AgentMatrix',
  'discovery.origin.path': 'Found on PATH',
  'discovery.origin.common': 'Common install location',
  'discovery.versionUnknown': 'Version command unreadable',
  'discovery.use': 'Use this CLI',
  'discovery.linked': 'Saved as “{name}”',
  'discovery.saving': 'Saving and checking…',
  'discovery.download': 'Download {version}',
  'discovery.downloading': 'Downloading {package}…',
  'discovery.downloadHint':
    'Downloads {package}@{version} into this application’s own data directory with install scripts disabled, then verifies the version command. Nothing outside that directory is changed.',
  'discovery.manual': 'Or run this command yourself:',
  'discovery.mismatchHint':
    'This adapter launches the pinned version only. Another version stays visible and editable, but cannot start a session.',
  'discovery.empty': 'No executable found on PATH or in the common install locations.',
  'discovery.unsupported':
    'Detection and downloads require the macOS or Linux desktop application.',
  'discovery.unavailable':
    'npm was not found, so one-click download is unavailable. Install Node.js, or install the CLI yourself and check again.',
  'discovery.managedRoot': 'Download location',
  'discovery.savedName': '{engine} (detected)',
  'error.engineDiscoveryBusy': 'A CLI check is already running. Wait for it to finish.',
  'error.engineDownloadBusy': 'A download is already running. Wait for it to finish.',
  'error.engineDownloadUnsupported':
    'Downloading an agent CLI requires the macOS or Linux desktop application.',
  'error.engineDownloadUnavailable':
    'npm could not be found. Install Node.js, or install the CLI yourself and check again.',
  'error.engineDownloadFailed':
    'The download did not produce a runnable pinned CLI. Run the shown command in a terminal and check again.',
} as const
