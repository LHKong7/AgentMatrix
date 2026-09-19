import type { ConfigurationReport } from '../../../shared/engines/configuration-report'
import { useI18n } from '../i18n'

export function PluginDependencySources({
  bindings,
}: {
  bindings: ConfigurationReport['pluginDependencies']
}) {
  const { t } = useI18n()
  return (
    <details data-testid="plugin-dependency-sources">
      <summary>{t('report.pluginDependencies')}</summary>
      <p className="hint">{t('report.pluginDependencyScope')}</p>
      {bindings === null ? (
        <p>{t('report.pluginDependenciesLegacy')}</p>
      ) : (
        <ul className="source-report-list">
          {bindings.map((binding) => (
            <li key={binding.pluginId}>
              <details data-plugin-dependency-binding={binding.pluginId}>
                <summary>
                  {binding.name} · {t('report.resourceFiles', { count: binding.files.length })}
                </summary>
                <ul>
                  {binding.files.map((file) => (
                    <li key={file.path}>
                      <code>{file.path}</code>
                      <small>{file.exists ? file.sha256 : t('report.sourceAbsent')}</small>
                      {file.exists && file.path !== file.resolvedPath && (
                        <small>
                          {t('report.resolvedPath')} <code>{file.resolvedPath}</code>
                        </small>
                      )}
                    </li>
                  ))}
                </ul>
                <ul>
                  {binding.unobserved.map((item) => (
                    <li
                      key={`${item.source}:${item.reason}`}
                      data-plugin-dependency-unobserved={item.reason}
                    >
                      <code>{item.source}</code>
                      <small>
                        {t(`report.pluginDependencyUnknown.${item.reason}`)} · {item.count}
                      </small>
                    </li>
                  ))}
                </ul>
              </details>
            </li>
          ))}
        </ul>
      )}
    </details>
  )
}
