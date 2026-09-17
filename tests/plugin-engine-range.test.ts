import { expect, it } from 'vitest'
import { pluginEngineRangeStatus } from '../src/main/engines/plugin-engine-range'

const probedAt = '2026-09-18T00:00:00Z'
it.each([
  ['^1.18.0', '1.18.16', 'matched'],
  ['>=1.18.0 <1.19.0 || ^2.0.0', '1.18.16', 'matched'],
  ['1.18.x', '1.18.16', 'matched'],
  ['1.18.16 - 1.19.0', '1.18.16', 'matched'],
  ['>=999.0.0', '1.18.16', 'mismatched'],
  ['<1.18.16', '1.18.16', 'mismatched'],
  ['^1.18.0', '2.0.0', 'mismatched'],
  ['^1.18.0', '1.19.0-beta.1', 'mismatched'],
  ['>=1.19.0-beta.0 <1.19.0', '1.19.0-beta.1', 'matched'],
  ['banana', '1.18.16', 'invalid-range'],
  ['>=1.18.0', 'development-build', 'invalid-version'],
  [null, '1.18.16', 'undeclared'],
] as const)('evaluates %s against saved version %s as %s', (range, version, status) => {
  expect(pluginEngineRangeStatus(range, { version, probedAt })).toBe(status)
})

it('does not infer a version or treat missing probe metadata as verification', () => {
  expect(pluginEngineRangeStatus('*', { version: null, probedAt: null })).toBe('engine-unverified')
  expect(pluginEngineRangeStatus('*', { version: '1.18.16', probedAt: null })).toBe(
    'engine-unverified',
  )
  expect(pluginEngineRangeStatus(null, { version: null, probedAt: null })).toBe('undeclared')
  expect(pluginEngineRangeStatus('bad', { version: null, probedAt: null })).toBe('invalid-range')
})
