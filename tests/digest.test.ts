import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { sha256Hex } from '../src/shared/digest'

const reference = (value: string) => createHash('sha256').update(value, 'utf8').digest('hex')

describe('SHA-256 for both processes', () => {
  it('matches node:crypto across block boundaries and multi-byte input', () => {
    const values = [
      '',
      'abc',
      'The quick brown fox jumps over the lazy dog',
      '连接统一管理',
      '🌐 emoji and \u0000 separators',
      ...[54, 55, 56, 57, 63, 64, 65, 119, 120, 121, 128, 1000].map((length) => 'a'.repeat(length)),
    ]
    for (const value of values) expect(sha256Hex(value)).toBe(reference(value))
  })

  it('produces the published vector for the empty string', () => {
    expect(sha256Hex('')).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855')
  })
})
