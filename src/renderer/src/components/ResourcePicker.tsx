import { useI18n } from '../i18n'
import { Badge } from './ui/badge'
import { Checkbox } from './ui/checkbox'

export function ResourcePicker({
  title,
  items,
  selected,
  onChange,
}: {
  title: string
  items: { id: string; name: string; description: string; enabled: boolean }[]
  selected: string[]
  onChange: (ids: string[]) => void
}) {
  const { t, number } = useI18n()
  return (
    <section className="mb-5 grid gap-2">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3>{title}</h3>
        <span className="text-[11px] text-muted-foreground">
          {t('picker.selected', { count: number(selected.length) })}
        </span>
      </div>
      {items.length === 0 ? (
        <p className="rounded-md border border-dashed border-border px-3 py-4 text-xs text-muted-foreground">
          {t('picker.empty', { resource: title })}
        </p>
      ) : (
        items.map((item) => (
          <label
            className="flex cursor-pointer items-start gap-3 rounded-md border border-border px-3 py-2 transition-colors hover:bg-accent/50"
            key={item.id}
          >
            <Checkbox
              className="mt-0.5"
              checked={selected.includes(item.id)}
              onChange={(event) =>
                onChange(
                  event.target.checked
                    ? [...selected, item.id]
                    : selected.filter((id) => id !== item.id),
                )
              }
            />
            <span className="grid min-w-0 flex-1 gap-0.5">
              <strong className="text-xs">{item.name}</strong>
              <small>{item.description || t('common.noDescription')}</small>
            </span>
            {!item.enabled && <Badge variant="muted">{t('common.disabled')}</Badge>}
          </label>
        ))
      )}
    </section>
  )
}
