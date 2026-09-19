import type { InstructionSources as Sources } from '../../../shared/engines/run-inputs'
import { useI18n } from '../i18n'

export function InstructionSources({ sources }: { sources: Sources | null }) {
  const { t } = useI18n()
  return (
    <details data-testid="native-instruction-sources">
      <summary>{t('report.instructionSources')}</summary>
      <p className="hint">{t('report.instructionHint')}</p>
      {sources === null ? (
        <p>{t('report.instructionsNotCaptured')}</p>
      ) : (
        <>
          {!sources.patterns.length && <p>{t('report.instructionsEmpty')}</p>}
          <ul className="source-report-list">
            {sources.patterns.map((entry) => (
              <li key={`${entry.source}:${entry.index}`}>
                <details>
                  <summary>
                    <code>{entry.source}</code> · instructions[{entry.index}]
                  </summary>
                  <ul>
                    {entry.searches.map((search) => (
                      <li key={search.cwd + '/' + search.pattern}>
                        <code>{search.cwd}</code> · <code>{search.pattern}</code>
                      </li>
                    ))}
                  </ul>
                  {!entry.files.length && <p>{t('report.instructionsNoMatches')}</p>}
                  <ul>
                    {entry.files.map((file) => (
                      <li key={file.path}>
                        <code>{file.path}</code>
                        <small>{file.exists ? file.sha256 : t('report.sourceAbsent')}</small>
                        {file.exists && file.resolvedPath !== file.path && (
                          <small>
                            {t('report.resolvedPath')} <code>{file.resolvedPath}</code>
                          </small>
                        )}
                      </li>
                    ))}
                  </ul>
                </details>
              </li>
            ))}
            {sources.unobserved.map((entry) => (
              <li key={`${entry.source}:${entry.index}`} data-instruction-unobserved={entry.reason}>
                <code>{entry.source}</code>
                {entry.index !== null && ` · instructions[${entry.index}]`}
                <small>{t(`report.instructionUnknown.${entry.reason}`)}</small>
              </li>
            ))}
          </ul>
        </>
      )}
    </details>
  )
}
