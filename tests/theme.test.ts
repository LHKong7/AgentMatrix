import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  appearanceBackgrounds,
  isThemePreference,
  resolveAppearance,
  themePreferences,
} from '../src/shared/theme'
import {
  getInitialTheme,
  persistTheme,
  prefersDark,
  themeStorageKey,
} from '../src/renderer/src/theme/preferences'

afterEach(() => vi.unstubAllGlobals())

describe('light and dark appearance', () => {
  it('offers light, dark, and an explicit system option', () => {
    expect(themePreferences).toEqual(['light', 'dark', 'system'])
    expect(isThemePreference('dark')).toBe(true)
    expect(isThemePreference('sepia')).toBe(false)
    expect(isThemePreference(null)).toBe(false)
  })
  it('follows the operating system only for the system preference', () => {
    expect(resolveAppearance('system', true)).toBe('dark')
    expect(resolveAppearance('system', false)).toBe('light')
    expect(resolveAppearance('light', true)).toBe('light')
    expect(resolveAppearance('dark', false)).toBe('dark')
  })
  it('keeps one pre-paint window background per appearance', () => {
    expect(Object.keys(appearanceBackgrounds)).toEqual(['light', 'dark'])
    for (const value of Object.values(appearanceBackgrounds))
      expect(value).toMatch(/^#[0-9a-f]{6}$/)
  })
  it('saves a choice, ignores an invalid value, and tolerates unavailable storage', () => {
    const getItem = vi.fn().mockReturnValue('dark')
    const setItem = vi.fn()
    vi.stubGlobal('localStorage', { getItem, setItem })
    expect(getInitialTheme()).toBe('dark')
    persistTheme('light')
    expect(setItem).toHaveBeenCalledWith(themeStorageKey, 'light')
    getItem.mockReturnValue('neon')
    expect(getInitialTheme()).toBe('system')
    getItem.mockImplementation(() => {
      throw new Error('Storage blocked')
    })
    setItem.mockImplementation(() => {
      throw new Error('Storage blocked')
    })
    expect(getInitialTheme()).toBe('system')
    expect(() => persistTheme('dark')).not.toThrow()
  })
  it('reads the system preference and treats an unavailable query as light', () => {
    vi.stubGlobal('window', { matchMedia: () => ({ matches: true }) })
    expect(prefersDark()).toBe(true)
    vi.stubGlobal('window', {
      matchMedia: () => {
        throw new Error('Unsupported')
      },
    })
    expect(prefersDark()).toBe(false)
  })
})
