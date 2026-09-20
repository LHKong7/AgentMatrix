import type { McpReport } from '../../../shared/engines/mcp-observation'
import { useI18n } from '../i18n'
import { Table } from './ui/table'

export function McpConnections({ report, current }: { report: McpReport; current: boolean }) {
  const { t, locale } = useI18n()
  return (
    <section className="grid gap-2">
      <h3>{t('report.mcpTitle')}</h3>
      <p className="text-xs leading-relaxed text-muted-foreground">{t('report.mcpHint')}</p>
      <p className="text-xs leading-relaxed text-muted-foreground" data-mcp-source={report.source}>
        {t(`report.mcpScope.${report.source}`)}
      </p>
      {report.checkedAt ? (
        <p data-testid="mcp-observation">
          {new Date(report.checkedAt).toLocaleString(locale)} ·{' '}
          {t(current ? 'report.currentObservation' : 'report.historicalObservation')}
        </p>
      ) : (
        <p>{t('report.mcpUnobserved')}</p>
      )}
      {report.entries.length === 0 ? (
        <p>{t('report.mcpEmpty')}</p>
      ) : (
        <Table aria-label={t('report.mcpTitle')}>
          <thead>
            <tr>
              <th>{t('report.mcpServer')}</th>
              <th>{t('report.mcpTransport')}</th>
              <th>{t('report.mcpStatus')}</th>
            </tr>
          </thead>
          <tbody>
            {report.entries.map((entry) => (
              <tr key={entry.slot} data-mcp-slot={entry.slot} data-mcp-status={entry.status}>
                <th scope="row">{entry.name}</th>
                <td>{entry.transport}</td>
                <td>{t(`report.mcpStatus.${entry.status}`)}</td>
              </tr>
            ))}
          </tbody>
        </Table>
      )}
    </section>
  )
}
