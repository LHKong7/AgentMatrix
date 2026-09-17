import { useI18n } from '../i18n'
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
    <section className="resource-picker">
      <div className="section-heading">
        <h3>{title}</h3>
        <span>{t('picker.selected', { count: number(selected.length) })}</span>
      </div>
      {items.length === 0 ? (
        <p className="field-empty">{t('picker.empty', { resource: title })}</p>
      ) : (
        items.map((item) => (
          <label className="selection-row" key={item.id}>
            <input
              type="checkbox"
              checked={selected.includes(item.id)}
              onChange={(event) =>
                onChange(
                  event.target.checked
                    ? [...selected, item.id]
                    : selected.filter((id) => id !== item.id),
                )
              }
            />
            <span>
              <strong>{item.name}</strong>
              <small>{item.description || t('common.noDescription')}</small>
            </span>
            {!item.enabled && <span className="tag">{t('common.disabled')}</span>}
          </label>
        ))
      )}
    </section>
  )
}
