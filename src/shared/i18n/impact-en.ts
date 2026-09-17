export const impactEn = {
  'impact.title': 'Impact before saving',
  'impact.description':
    'Preview this draft against saved Agent bindings. Saving changes the inputs for future sessions.',
  'impact.incomplete': 'Complete the invalid or required fields to preview this draft.',
  'impact.loading': 'Checking bindings and retained session captures…',
  'impact.profiles': 'Related Agent profiles: {count} · Confirmed changes: {changed}',
  'impact.noProfiles': 'No saved Agent profile references this library item.',
  'impact.profile.changed': 'Next session inputs change',
  'impact.profile.unchanged': 'Resolved inputs stay the same',
  'impact.profile.unresolved': 'Draft or disabled — impact cannot be resolved',
  'impact.profile.blocked': 'This draft makes the profile unresolved',
  'impact.profile.resolved': 'This draft resolves the profile',
  'impact.sessions': 'Existing conversations',
  'impact.retained':
    'Existing conversations keep their captured configuration, including after resume. Differences below compare their captures with the proposed inputs for a new session. Closed conversations are excluded.',
  'impact.scanned': 'Conversation captures checked: {count}. Refresh to include new conversations.',
  'impact.noSessions':
    'No related conversations were found. Any unreadable captures are shown separately.',
  'impact.noSessionsYet': 'No related conversations in the pages checked so far.',
  'impact.session.pending': 'Retains earlier inputs',
  'impact.session.same': 'Captured inputs still match',
  'impact.session.unresolved': 'Retained capture; profile is missing or unresolved',
  'impact.session.unavailable': 'Capture unavailable — relationship and impact unknown',
  'impact.alreadyPending':
    'This conversation already differed from the saved profile before this edit.',
  'impact.versions': 'Retained v{captured} · Proposed binding {proposed}',
  'impact.more': 'Check more conversations',
  'impact.browser':
    'Browser preview checks saved profiles only. Desktop conversations are unavailable here.',
  'impact.limits':
    'This is a configuration preview, not a CLI compatibility or application check. Fixed versions and direct binding overrides are respected. Credential values and rotations are not compared.',
} as const
