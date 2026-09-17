import { afterEach, describe, expect, it, vi } from 'vitest'
import { catalogs, resolveLocale, translate } from '../src/shared/i18n'
import { appError, formatError } from '../src/shared/errors'
import { createAgent, createWorkspace, workspaceSchema } from '../src/shared/workspace'
import {
  getInitialLocale,
  persistLocale,
  localeStorageKey,
} from '../src/renderer/src/i18n/preferences'

const placeholders = (value: string) =>
  [...value.matchAll(/\{(\w+)\}/g)].map((match) => match[1]).sort()
afterEach(() => vi.unstubAllGlobals())

describe('language catalogs and resolution', () => {
  it('has matching, nonempty entries and interpolation parameters in both languages', () => {
    expect(Object.keys(catalogs.en).sort()).toEqual(Object.keys(catalogs['zh-CN']).sort())
    for (const key of Object.keys(catalogs.en) as (keyof typeof catalogs.en)[]) {
      expect(catalogs.en[key].trim()).not.toBe('')
      expect(catalogs['zh-CN'][key].trim()).not.toBe('')
      expect(placeholders(catalogs.en[key]), key).toEqual(placeholders(catalogs['zh-CN'][key]))
    }
  })
  it.each([
    [['zh-TW', 'en-US'], 'zh-CN'],
    [['en-GB', 'zh-CN'], 'en'],
    [['ko-KR', 'zh_Hans'], 'zh-CN'],
    [['fr-FR'], 'en'],
    [[], 'en'],
  ] as const)('resolves the first supported preference in %j', (languages, expected) => {
    expect(resolveLocale(languages)).toBe(expected)
  })
  it('interpolates user text without treating it as more translation placeholders', () => {
    expect(translate('en', 'common.editNamed', { name: '助手 {count}' })).toBe('Edit 助手 {count}')
    expect(translate('zh-CN', 'agents.enabledCount', { count: 0 })).toBe('0 个配置已启用')
  })
  it('uses a saved preference, ignores invalid values, and tolerates unavailable storage', () => {
    vi.stubGlobal('navigator', { languages: ['zh-CN'], language: 'zh-CN' })
    const getItem = vi.fn().mockReturnValue('en')
    const setItem = vi.fn()
    vi.stubGlobal('localStorage', { getItem, setItem })
    expect(getInitialLocale()).toBe('en')
    persistLocale('zh-CN')
    expect(setItem).toHaveBeenCalledWith(localeStorageKey, 'zh-CN')
    getItem.mockReturnValue('unknown')
    expect(getInitialLocale()).toBe('zh-CN')
    getItem.mockImplementation(() => {
      throw new Error('Storage blocked')
    })
    setItem.mockImplementation(() => {
      throw new Error('Storage blocked')
    })
    expect(getInitialLocale()).toBe('zh-CN')
    expect(() => persistLocale('en')).not.toThrow()
  })
})

describe('localized configuration boundaries', () => {
  it('localizes only newly created content, leaving existing workspace values intact', () => {
    const workspace = createWorkspace('zh-CN')
    const original = structuredClone(workspace)
    expect(createAgent('new', 'en').name).toBe('New Agent')
    expect(createAgent('new', 'zh-CN').name).toBe('新 Agent')
    expect(workspaceSchema.parse(workspace)).toEqual(original)
    expect(workspace.agents[0]!.systemPrompt).toContain('你是一位')
  })
  it('renders the same validation failure in either language', () => {
    const workspace = createWorkspace()
    workspace.agents[0]!.name = ''
    const result = workspaceSchema.safeParse(workspace)
    expect(result.success).toBe(false)
    if (result.success) throw new Error('Expected invalid data')
    expect(formatError(result.error, 'en')).toContain('Name is required.')
    expect(formatError(result.error, 'zh-CN')).toContain('名称不能为空')
  })
  it('localizes error codes after Electron wraps them and preserves technical context', () => {
    const failure = appError('error.unreadable', { path: '/tmp/测试/workspace.json' })
    const ipcError = new Error(
      `Error invoking remote method 'workspace:load': Error: ${failure.message}`,
    )
    expect(formatError(ipcError, 'en')).toContain('original file was preserved')
    expect(formatError(ipcError, 'zh-CN')).toContain('原文件已保留')
    expect(formatError(ipcError, 'en')).toContain('/tmp/测试/workspace.json')
    expect(formatError(appError('error.conflict'), 'en')).toContain('Reload before saving')
  })
  it('localizes malformed JSON and unknown failures without hiding native diagnostics', () => {
    expect(formatError(new SyntaxError('bad JSON'), 'zh-CN')).toContain('有效的 JSON')
    expect(formatError(null, 'en')).toBe('The operation failed. Please try again.')
    expect(formatError(new Error('EACCES: /tmp/file'), 'zh-CN')).toBe('EACCES: /tmp/file')
  })
})
