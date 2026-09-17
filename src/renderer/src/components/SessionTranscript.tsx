import { useMemo } from 'react'
import type { HistoryEvent } from '../../../shared/sessions/schema'
import { transcriptRows } from '../../../shared/sessions/transcript'
import { useI18n } from '../i18n'

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
          <article className="message" key={id}>
            <strong>{t(`sessions.notice.${data.code}`)}</strong>
            {data.text && <pre>{data.text}</pre>}
          </article>
        )
      if (data.kind === 'turn.started' || data.kind === 'message.delta') {
        const channel = data.kind === 'turn.started' ? 'user' : data.channel
        return (
          <article className={`message ${channel}`} key={id}>
            <strong>{t(`sessions.${channel}`)}</strong>
            <pre>{data.text}</pre>
          </article>
        )
      }
      if (data.kind === 'tool.updated')
        return (
          <details className="tool-event" key={id}>
            <summary>
              {data.title} <span>{t(`sessions.tool.${data.status}`)}</span>
            </summary>
            {data.content && <pre>{data.content}</pre>}
            {data.contentTruncated && <small>{t('sessions.truncated')}</small>}
          </details>
        )
      if (data.kind === 'turn.finished')
        return (
          <div className="turn-result" key={id}>
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
          <article className="history-lifecycle">
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
              <p>{t(`sessions.failure.${data.failure.code}`)}</p>
            )}
          </article>
        )
      return null
    })()
    return history ? (
      <section key={id} className="history-entry" data-history-cursor={firstCursor}>
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
