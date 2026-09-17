import { Languages } from 'lucide-react'
import { isLocale } from '../../../shared/i18n'
import { useI18n } from '../i18n'

export function LanguageSelect() {
  const { locale, setLocale, t } = useI18n()
  return (
    <label className="language-select">
      <Languages size={16} aria-hidden="true" />
      <select
        aria-label={t('settings.language')}
        value={locale}
        onChange={(event) => {
          if (isLocale(event.target.value)) setLocale(event.target.value)
        }}
      >
        <option value="en" lang="en">
          English
        </option>
        <option value="zh-CN" lang="zh-CN">
          简体中文
        </option>
      </select>
    </label>
  )
}
