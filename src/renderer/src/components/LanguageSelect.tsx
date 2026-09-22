import { Languages } from 'lucide-react'
import { isLocale } from '../../../shared/i18n'
import { useI18n } from '../i18n'
import { Select } from './ui/input'

export function LanguageSelect() {
  const { locale, setLocale, t } = useI18n()
  return (
    <label className="language-select inline-flex items-center gap-2 text-muted-foreground">
      <Languages size={16} aria-hidden="true" />
      <Select
        className="h-8 max-w-40 text-xs"
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
      </Select>
    </label>
  )
}
