import type { HistoryEvent, SessionEventData } from './schema'

export interface TranscriptRow {
  id: string
  data: SessionEventData
  firstCursor: number
  lastCursor: number
  timestamp: string
}

/** Coalesce display updates within a page without mixing runs, turns, or reasoning channels. */
export function transcriptRows(events: HistoryEvent[], history = false): TranscriptRow[] {
  const rows: TranscriptRow[] = []
  const positions = new Map<string, number>()
  for (const event of events) {
    const { data } = event
    if (data.kind === 'message.delta' || data.kind === 'tool.updated') {
      const id = JSON.stringify([
        event.runId,
        event.turnId,
        data.kind,
        data.kind === 'message.delta' ? data.messageId : data.toolCallId,
        data.kind === 'message.delta' ? data.channel : null,
      ])
      const previous = positions.get(id)
      if (previous !== undefined) {
        const row = rows[previous]!
        row.data =
          data.kind === 'message.delta' && row.data.kind === 'message.delta'
            ? { ...data, text: row.data.text + data.text }
            : data
        row.lastCursor = event.cursor
        continue
      }
      positions.set(id, rows.length)
      rows.push({
        id,
        data: { ...data },
        firstCursor: event.cursor,
        lastCursor: event.cursor,
        timestamp: event.timestamp,
      })
    } else if (history || ['turn.started', 'turn.finished', 'engine.notice'].includes(data.kind))
      rows.push({
        id: String(event.cursor),
        data,
        firstCursor: event.cursor,
        lastCursor: event.cursor,
        timestamp: event.timestamp,
      })
  }
  return rows
}
