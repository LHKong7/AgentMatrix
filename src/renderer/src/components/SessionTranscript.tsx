import { useMemo } from 'react'
import type { HistoryEvent } from '../../../shared/sessions/schema'
import { transcriptRows } from '../../../shared/sessions/transcript'
import { useI18n } from '../i18n'
import { ConfigurationFailureDetails } from './ConfigurationFailureDetails'
import { cn } from '../lib/utils'

// The channel name stays on the element: the desktop tests read `.message.assistant pre`.
const channelSurfaces = {
  user: 'bg-muted',
  assistant: 'bg-card',
  reasoning: 'bg-surface text-muted-foreground',
} as const
const messageSurface = 'message grid gap-1 rounded-lg border border-border p-3'

export function Transcript({
  events,
  history = false,
}: {
  events: HistoryEvent[]
  history?: boolean
}) {
  const { t, number } = useI18n()
  const rows = useMemo(() => transcriptRows(events, history), [events, history])
  return rows.map(({ id, data, firstCursor, lastCursor, timestamp }) => {
    const content = (() => {
      if (data.kind === 'engine.notice')
        return (
          <article className={cn(messageSurface, 'bg-card')} key={id}>
            <strong>{t(`sessions.notice.${data.code}`)}</strong>
            {data.text && <pre>{data.text}</pre>}
          </article>
        )
      if (data.kind === 'turn.started' || data.kind === 'message.delta') {
        const channel = data.kind === 'turn.started' ? 'user' : data.channel
        return (
          <article className={cn(messageSurface, channel, channelSurfaces[channel])} key={id}>
            <strong>{t(`sessions.${channel}`)}</strong>
            <pre>{data.text}</pre>
          </article>
        )
      }
      if (data.kind === 'tool.updated')
        return (
          <details className="rounded-lg border border-border bg-card px-3 py-2 text-xs" key={id}>
            <summary className="flex flex-wrap items-center justify-between gap-2 font-medium">
              {data.title}
              <span className="text-[11px] text-muted-foreground">
                {t(`sessions.tool.${data.status}`)}
              </span>
            </summary>
            {data.content && <pre>{data.content}</pre>}
            {data.contentTruncated && <small>{t('sessions.truncated')}</small>}
          </details>
        )
      if (data.kind === 'turn.finished')
        return (
          <div
            className="flex flex-wrap items-center gap-3 rounded-md bg-muted px-3 py-2 text-[11px]"
            key={id}
          >
            <strong>{t(`sessions.outcome.${data.outcome}`)}</strong>
            <span>
              {t('sessions.tokens')}:{' '}
              {data.usage
                ? `${data.usage.inputTokens ?? t('sessions.unknown')} / ${data.usage.outputTokens ?? t('sessions.unknown')} (${t(`sessions.usage.${data.usage.scope ?? 'unknown'}`)})`
                : t('sessions.unknown')}
            </span>
            <span>
              {t('sessions.cost')}:{' '}
              {data.usage?.cost
                ? `${number(data.usage.cost.amount)} ${data.usage.cost.currency}`
                : t('sessions.unknown')}
            </span>
            {data.nativeStopReason && (
              <small>
                {t('sessions.stopReason')}: {data.nativeStopReason}
              </small>
            )}
          </div>
        )
      if (history)
        return (
          <article className="grid gap-1 rounded-md bg-muted p-3">
            <strong>{t(`history.event.${data.kind}`)}</strong>
            {data.kind === 'interaction.requested' && (
              <>
                <pre>{data.request.title}</pre>
                {'message' in data.request && <pre>{data.request.message}</pre>}
                {'options' in data.request && (
                  <ul>
                    {data.request.options.map((option) => (
                      <li key={option.id}>{option.label}</li>
                    ))}
                  </ul>
                )}
              </>
            )}
            {data.kind === 'interaction.resolved' && (
              <p>{t(`history.disposition.${data.disposition}`)}</p>
            )}
            {(data.kind === 'run.failed' || data.kind === 'run.interrupted') && (
              <>
                <p>{t(`sessions.failure.${data.failure.code}`)}</p>
                {data.failure.code === 'configuration' && (
                  <ConfigurationFailureDetails diagnostic={data.failure.configuration} />
                )}
              </>
            )}
          </article>
        )
      return null
    })()
    return history ? (
      <section key={id} className="grid gap-1" data-history-cursor={firstCursor}>
        <small>
          {firstCursor === lastCursor ? `#${firstCursor}` : `#${firstCursor}–${lastCursor}`} ·{' '}
          {timestamp}
        </small>
        {content}
      </section>
    ) : (
      content
    )
  })
}
