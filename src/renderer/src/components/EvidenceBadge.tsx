import { CircleAlert, CircleCheck, CircleDashed, CircleHelp } from 'lucide-react'
import {
  evidenceStatus,
  type EvidenceKind,
  type EvidenceSubject,
} from '../../../shared/engines/evidence'
import type { EngineWorkspace } from '../../../shared/engines/workspace'
import { useI18n } from '../i18n'
import { Badge } from './ui/badge'

/**
 * What has been observed about one engine, connection, grant or agent — and nothing more.
 *
 * Being found on disk or in a native file is reported as exactly that. It only becomes
 * "the endpoint answered" when something actually called the endpoint, and a change to the
 * subject retires what was observed rather than carrying it over.
 */
export function EvidenceBadge({
  workspace,
  subject,
  className,
}: {
  workspace: EngineWorkspace
  subject: EvidenceSubject
  className?: string
}) {
  const { t, locale } = useI18n()
  const status = evidenceStatus(workspace, subject)
  const observedAt = [...status.current].sort((a, b) => a.observedAt.localeCompare(b.observedAt))[
    status.current.length - 1
  ]?.observedAt
  if (status.failures.length) {
    const failure = status.failures[0]!
    return (
      <Badge variant="destructive" className={className} title={failure.detail || undefined}>
        <CircleAlert aria-hidden="true" />
        {t('evidence.failed')}
      </Badge>
    )
  }
  if (!status.level) {
    const changed = status.stale.length > 0
    return (
      <Badge
        variant={changed ? 'warning' : 'muted'}
        className={className}
        title={changed ? t('evidence.stale') : undefined}
      >
        {changed ? <CircleAlert aria-hidden="true" /> : <CircleDashed aria-hidden="true" />}
        {t(changed ? 'evidence.stale' : 'evidence.none')}
      </Badge>
    )
  }
  const confirmed: EvidenceKind[] = ['session-ready', 'model-response']
  return (
    <Badge
      variant={confirmed.includes(status.level) ? 'success' : 'outline'}
      className={className}
      title={
        observedAt
          ? t('evidence.observedAt', { time: new Date(observedAt).toLocaleString(locale) })
          : undefined
      }
    >
      {confirmed.includes(status.level) ? (
        <CircleCheck aria-hidden="true" />
      ) : (
        <CircleHelp aria-hidden="true" />
      )}
      {t(`evidence.${status.level}`)}
    </Badge>
  )
}
