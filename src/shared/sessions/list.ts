import type { SessionSnapshot, SessionStatus } from './schema'

export type SessionListFilter = 'all' | 'active' | 'attention' | 'finished' | 'failed'
export const sessionListFilters: SessionListFilter[] = [
  'all',
  'active',
  'attention',
  'finished',
  'failed',
]
/** Every status belongs to exactly one group, so the counts add up to the conversation total. */
export const sessionStatusGroups = {
  active: ['created', 'starting', 'resuming', 'ready', 'running', 'cancelling'],
  attention: ['waiting'],
  finished: ['closing', 'closed'],
  failed: ['failed', 'interrupted'],
} as const satisfies Record<Exclude<SessionListFilter, 'all'>, readonly SessionStatus[]>

export function sessionStatusGroup(status: SessionStatus): Exclude<SessionListFilter, 'all'> {
  for (const [group, values] of Object.entries(sessionStatusGroups))
    if ((values as readonly string[]).includes(status))
      return group as Exclude<SessionListFilter, 'all'>
  return 'active'
}

export function matchesSessionFilter(status: SessionStatus, filter: SessionListFilter): boolean {
  return filter === 'all' || sessionStatusGroup(status) === filter
}

export interface SessionListQuery {
  filter: SessionListFilter
  search: string
  /** Agent names live in the workspace, not in the snapshot, so the caller resolves them. */
  agentName: (session: SessionSnapshot) => string
}

/** Filters by status and free text, newest activity first. */
export function sessionListView(
  sessions: readonly SessionSnapshot[],
  { filter, search, agentName }: SessionListQuery,
): SessionSnapshot[] {
  const needle = search.trim().toLowerCase()
  return sessions
    .filter((session) => matchesSessionFilter(session.status, filter))
    .filter(
      (session) =>
        !needle ||
        `${agentName(session)} ${session.cwd} ${session.id} ${session.engineVersion}`
          .toLowerCase()
          .includes(needle),
    )
    .slice()
    .sort((first, second) => second.updatedAt.localeCompare(first.updatedAt))
}

export function sessionListCounts(sessions: readonly SessionSnapshot[]) {
  const counts = { total: sessions.length, active: 0, attention: 0, finished: 0, failed: 0 }
  for (const session of sessions) counts[sessionStatusGroup(session.status)] += 1
  return counts
}
