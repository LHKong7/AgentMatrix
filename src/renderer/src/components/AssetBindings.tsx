import type { AgentProfile } from '../../../shared/engines/schema'
import type { PromptAsset, SkillAsset } from '../../../shared/engines/workspace'
import { useI18n } from '../i18n'
import { SelectField } from './ConfigurationFields'
import { buttonVariants } from './ui/button'
import { Badge } from './ui/badge'
import { Checkbox } from './ui/checkbox'

type Binding = AgentProfile['promptBindings'][number] | AgentProfile['skillBindings'][number]
export function AssetBindings<T extends Binding>({
  title,
  assets,
  bindings,
  onChange,
  prompts = false,
  hideTitle = false,
}: {
  title: string
  assets: (PromptAsset | SkillAsset)[]
  bindings: T[]
  onChange: (bindings: T[]) => void
  prompts?: boolean
  /** The surrounding panel already names this group. */
  hideTitle?: boolean
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
    <section className="mb-5 grid gap-2">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className={hideTitle ? 'sr-only' : undefined}>{title}</h3>
        <span className="text-[11px] text-muted-foreground">
          {t('picker.selected', { count: number(bindings.length) })}
        </span>
      </div>
      {!assets.length && (
        <p className="rounded-md border border-dashed border-border px-3 py-4 text-xs text-muted-foreground">
          {t('picker.empty', { resource: title })}
        </p>
      )}
      {ordered.map((asset) => {
        const binding = bindings.find((item) => item.assetId === asset.id)
        return (
          <div className="grid gap-2 border-b border-border pb-3" key={asset.id}>
            <label className="flex cursor-pointer items-start gap-3 rounded-md border border-border px-3 py-2 transition-colors hover:bg-accent/50">
              <Checkbox
                className="mt-0.5"
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
              <span className="grid min-w-0 flex-1 gap-0.5">
                <strong className="text-xs">{asset.name}</strong>
                <small>{asset.description || t('common.noDescription')}</small>
              </span>
              {!asset.enabled && <Badge variant="muted">{t('common.disabled')}</Badge>}
            </label>
            {binding && (
              <div className="grid gap-2 pl-6 sm:grid-cols-2">
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
                <div className="flex gap-1 pl-6">
                  {([-1, 1] as const).map((direction) => (
                    <button
                      key={direction}
                      type="button"
                      className={buttonVariants({ variant: 'ghost', size: 'icon' })}
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
