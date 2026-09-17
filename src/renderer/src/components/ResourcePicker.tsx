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
  return (
    <section className="resource-picker">
      <div className="section-heading">
        <h3>{title}</h3>
        <span>{selected.length} 个已选择</span>
      </div>
      {items.length === 0 ? (
        <p className="field-empty">资源库中还没有 {title}，可以先保存，再前往对应页面添加。</p>
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
              <small>{item.description || '未填写描述'}</small>
            </span>
            {!item.enabled && <span className="tag">已停用</span>}
          </label>
        ))
      )}
    </section>
  )
}
