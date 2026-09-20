/** Appearance preference. `system` follows the operating system, it is not a third palette. */
export const themePreferences = ['light', 'dark', 'system'] as const
export type ThemePreference = (typeof themePreferences)[number]
export type Appearance = 'light' | 'dark'

export function isThemePreference(value: unknown): value is ThemePreference {
  return themePreferences.includes(value as ThemePreference)
}

export function resolveAppearance(preference: ThemePreference, systemDark: boolean): Appearance {
  if (preference === 'system') return systemDark ? 'dark' : 'light'
  return preference
}

/** Keep the document class, the color scheme, and the native window background in one place. */
export const darkClassName = 'dark'
export const appearanceBackgrounds = { light: '#f7faf8', dark: '#171d1a' } as const
