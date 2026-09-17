import type { AgentProfile } from '../../../shared/engines/schema'
import type { PromptAsset, SkillAsset } from '../../../shared/engines/workspace'
import { useI18n } from '../i18n'
import { SelectField } from './ConfigurationFields'

type Binding = AgentProfile['promptBindings'][number] | AgentProfile['skillBindings'][number]
export function AssetBindings<T extends Binding>({
  title,
  assets,
  bindings,
  onChange,
  prompts = false,
}: {
  title: string
  assets: (PromptAsset | SkillAsset)[]
  bindings: T[]
  onChange: (bindings: T[]) => void
  prompts?: boolean
}) {
  const { t, number } = useI18n()
  const ordered = [
    ...bindings
      .map((binding) => assets.find((asset) => asset.id === binding.assetId))
      .filter((asset): asset is PromptAsset | SkillAsset => Boolean(asset)),
    ...assets.filter((asset) => !bindings.some((binding) => binding.assetId === asset.id)),
  ]
  const replace = (id: string, patch: Partial<Binding>) =>
    onChange(
      bindings.map((binding) => (binding.assetId === id ? { ...binding, ...patch } : binding)),
    )
  return (
    <section className="resource-picker">
      <div className="section-heading">
        <h3>{title}</h3>
        <span>{t('picker.selected', { count: number(bindings.length) })}</span>
      </div>
      {!assets.length && <p className="field-empty">{t('picker.empty', { resource: title })}</p>}
      {ordered.map((asset) => {
        const binding = bindings.find((item) => item.assetId === asset.id)
        return (
          <div className="asset-binding" key={asset.id}>
            <label className="selection-row">
              <input
                type="checkbox"
                checked={Boolean(binding)}
                onChange={(event) => {
                  if (!event.target.checked)
                    onChange(bindings.filter((item) => item.assetId !== asset.id))
                  else
                    onChange([
                      ...bindings,
                      {
                        assetId: asset.id,
                        selection: { follow: 'latest' },
                        ...(prompts ? { mode: null } : {}),
                      } as T,
                    ])
                }}
              />
              <span>
                <strong>{asset.name}</strong>
                <small>{asset.description || t('common.noDescription')}</small>
              </span>
              {!asset.enabled && <span className="tag">{t('common.disabled')}</span>}
            </label>
            {binding && (
              <div className="binding-fields">
                <SelectField
                  label={`${t('config.follow')} · ${asset.name}`}
                  value={
                    binding.selection.follow === 'latest'
                      ? 'latest'
                      : String(binding.selection.version)
                  }
                  onChange={(value) =>
                    replace(asset.id, {
                      selection:
                        value === 'latest'
                          ? { follow: 'latest' }
                          : { follow: 'pinned', version: Number(value) },
                    })
                  }
                >
                  <option value="latest">{t('config.latest')}</option>
                  {asset.versions.map((version) => (
                    <option key={version.version} value={version.version}>
                      {t('config.revision', { version: version.version })}
                    </option>
                  ))}
                </SelectField>
                {prompts && 'mode' in binding && (
                  <SelectField
                    label={`${t('config.bindingMode')} · ${asset.name}`}
                    value={binding.mode ?? ''}
                    onChange={(value) =>
                      replace(asset.id, {
                        mode: (value || null) as AgentProfile['promptBindings'][number]['mode'],
                      })
                    }
                  >
                    <option value="">{t('config.choose')}</option>
                    {(['append', 'replace', 'project-rule'] as const).map((mode) => (
                      <option key={mode} value={mode}>
                        {t(`config.mode.${mode}`)}
                      </option>
                    ))}
                  </SelectField>
                )}
                <div className="binding-order">
                  {([-1, 1] as const).map((direction) => (
                    <button
                      key={direction}
                      type="button"
                      className="icon-button"
                      aria-label={t(direction === -1 ? 'config.moveUp' : 'config.moveDown', {
                        name: asset.name,
                      })}
                      disabled={
                        bindings.indexOf(binding) + direction < 0 ||
                        bindings.indexOf(binding) + direction >= bindings.length
                      }
                      onClick={() => {
                        const items = [...bindings]
                        const index = items.indexOf(binding)
                        ;[items[index], items[index + direction]] = [
                          items[index + direction]!,
                          items[index]!,
                        ]
                        onChange(items)
                      }}
                    >
                      {direction === -1 ? '↑' : '↓'}
                    </button>
                  ))}
                </div>
              </div>
            )}
          </div>
        )
      })}
    </section>
  )
}
