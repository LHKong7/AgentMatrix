import { describe, expect, it } from 'vitest'
import { createSessionSnapshot } from '../src/shared/sessions/state'
import type { SessionSnapshot, SessionStatus } from '../src/shared/sessions/schema'
import {
  matchesSessionFilter,
  sessionListCounts,
  sessionListFilters,
  sessionListView,
  sessionStatusGroup,
  sessionStatusGroups,
} from '../src/shared/sessions/list'

function conversation(
  id: string,
  values: Partial<SessionSnapshot> & { status?: SessionStatus } = {},
): SessionSnapshot {
  return {
    ...createSessionSnapshot({
      id,
      agentId: `${id}-agent`,
      installationId: 'installation-1',
      engineVersion: '1.18.16',
      mode: 'acp',
      cwd: `/projects/${id}`,
      snapshotId: `snapshot-${id}`,
      snapshotDigest: 'a'.repeat(64),
      createdAt: '2026-09-18T00:00:00.000Z',
    }),
    ...values,
  }
}
const names: Record<string, string> = { first: 'Reviewer', second: 'Planner', third: 'Reviewer' }
const agentName = (session: SessionSnapshot) => names[session.id] ?? 'Removed'

describe('session list grouping', () => {
  it('assigns every session status to exactly one group', () => {
    const statuses: SessionStatus[] = [
      'created',
      'starting',
      'resuming',
      'ready',
      'running',
      'waiting',
      'cancelling',
      'closing',
      'interrupted',
      'failed',
      'closed',
    ]
    const grouped = Object.values(sessionStatusGroups).flat()
    expect([...grouped].sort()).toEqual([...statuses].sort())
    expect(sessionStatusGroup('waiting')).toBe('attention')
    expect(sessionStatusGroup('interrupted')).toBe('failed')
    expect(sessionStatusGroup('closed')).toBe('finished')
  })
  it('keeps every conversation under the all filter and one status filter', () => {
    for (const status of ['ready', 'waiting', 'closed', 'failed'] as SessionStatus[]) {
      const selected = sessionListFilters.filter((filter) => matchesSessionFilter(status, filter))
      expect(selected).toHaveLength(2)
      expect(selected).toContain('all')
    }
  })
})

describe('session list view', () => {
  const sessions = [
    conversation('first', { status: 'waiting', updatedAt: '2026-09-18T01:00:00.000Z' }),
    conversation('second', { status: 'closed', updatedAt: '2026-09-18T03:00:00.000Z' }),
    conversation('third', { status: 'failed', updatedAt: '2026-09-18T02:00:00.000Z' }),
  ]
  it('orders by most recent activity and filters by status', () => {
    expect(
      sessionListView(sessions, { filter: 'all', search: '', agentName }).map((item) => item.id),
    ).toEqual(['second', 'third', 'first'])
    expect(
      sessionListView(sessions, { filter: 'attention', search: '', agentName }).map(
        (item) => item.id,
      ),
    ).toEqual(['first'])
    expect(sessionListView(sessions, { filter: 'failed', search: '', agentName })).toHaveLength(1)
  })
  it('searches the agent name, folder and identifier without changing the input list', () => {
    expect(
      sessionListView(sessions, { filter: 'all', search: 'reviewer', agentName }).map(
        (item) => item.id,
      ),
    ).toEqual(['third', 'first'])
    expect(
      sessionListView(sessions, { filter: 'all', search: '/projects/second', agentName }),
    ).toHaveLength(1)
    expect(
      sessionListView(sessions, { filter: 'all', search: '  SECOND ', agentName }),
    ).toHaveLength(1)
    expect(sessionListView(sessions, { filter: 'all', search: 'absent', agentName })).toEqual([])
    expect(sessions.map((item) => item.id)).toEqual(['first', 'second', 'third'])
  })
  it('counts each group once', () => {
    expect(sessionListCounts(sessions)).toEqual({
      total: 3,
      active: 0,
      attention: 1,
      finished: 1,
      failed: 1,
    })
    expect(sessionListCounts([])).toMatchObject({ total: 0 })
  })
})
