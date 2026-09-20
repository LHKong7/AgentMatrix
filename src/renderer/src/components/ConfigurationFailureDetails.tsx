import type { ConfigurationDiagnostic } from '../../../shared/engines/configuration-report'
import { useI18n } from '../i18n'

export function ConfigurationFailureDetails({
  diagnostic,
}: {
  diagnostic?: ConfigurationDiagnostic | null
}) {
  const { t } = useI18n()
  if (!diagnostic) return <p>{t('report.diagnosticMissing')}</p>
  return (
    <div data-configuration-check={diagnostic.check}>
      <p>
        <strong>{t(`report.diagnosticCheck.${diagnostic.check}`)}</strong>
      </p>
      <p>{t(`report.diagnosticReason.${diagnostic.reason}`)}</p>
      {diagnostic.fields.length ? (
        <ul>
          {diagnostic.fields.map((field) => (
            <li key={field}>{t(`report.field.${field}`)}</li>
          ))}
        </ul>
      ) : (
        <p>{t('report.diagnosticUnattributed')}</p>
      )}
      <p className="text-xs leading-relaxed text-muted-foreground">{t('report.diagnosticHint')}</p>
    </div>
  )
}
