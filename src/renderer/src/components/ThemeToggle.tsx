import { Monitor, Moon, Sun } from 'lucide-react'
import { themePreferences, type ThemePreference } from '../../../shared/theme'
import { useI18n } from '../i18n'
import { useTheme } from '../theme'
import { Button } from './ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from './ui/dropdown-menu'

const icons = { light: Sun, dark: Moon, system: Monitor } as const
const labels = { light: 'theme.light', dark: 'theme.dark', system: 'theme.system' } as const

export function ThemeToggle({ compact = true }: { compact?: boolean }) {
  const { t } = useI18n()
  const { theme, appearance, setTheme } = useTheme()
  const Icon = icons[appearance]
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="outline"
          size={compact ? 'icon' : 'sm'}
          aria-label={t('theme.label')}
          title={`${t('theme.label')}: ${t(labels[theme])}`}
          data-testid="theme-toggle"
        >
          <Icon aria-hidden="true" />
          {!compact && <span>{t(labels[theme])}</span>}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuLabel>{t('theme.label')}</DropdownMenuLabel>
        <DropdownMenuRadioGroup
          value={theme}
          onValueChange={(value) => setTheme(value as ThemePreference)}
        >
          {themePreferences.map((preference) => {
            const Option = icons[preference]
            return (
              <DropdownMenuRadioItem key={preference} value={preference}>
                <Option aria-hidden="true" />
                {t(labels[preference])}
              </DropdownMenuRadioItem>
            )
          })}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
