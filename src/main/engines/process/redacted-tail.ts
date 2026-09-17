import { StringDecoder } from 'node:string_decoder'

function trailingPrefix(text: string, secret: string): number {
  const prefix = new Int32Array(secret.length)
  for (let index = 1, length = 0; index < secret.length; index++) {
    while (length && secret[index] !== secret[length]) length = prefix[length - 1]!
    if (secret[index] === secret[length]) length++
    prefix[index] = length
  }
  let length = 0
  for (const character of text.slice(-Math.max(0, secret.length - 1)).split('')) {
    while (length && character !== secret[length]) length = prefix[length - 1]!
    if (character === secret[length]) length++
    if (length === secret.length) length = prefix[length - 1]!
  }
  return length
}

/** Bounded diagnostic tail; incomplete secret matches never become visible between chunks. */
export class RedactedTail {
  private readonly decoder = new StringDecoder('utf8')
  private readonly variants: string[]
  private readonly carry: number
  private pending = ''
  private output = ''
  private ended = false

  constructor(
    secrets: readonly string[],
    private readonly limit = 8192,
  ) {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 65_536)
      throw new Error('Invalid diagnostic limit')
    if (
      secrets.length > 256 ||
      secrets.some((secret) => secret.length > 65_536) ||
      secrets.reduce((total, secret) => total + secret.length, 0) > 1_048_576
    )
      throw new Error('Diagnostic redaction limit exceeded')
    this.variants = [
      ...new Set(
        secrets.filter(Boolean).flatMap((secret) => {
          const utf8 = Buffer.from(secret).toString('utf8')
          return [
            secret,
            utf8,
            JSON.stringify(secret).slice(1, -1),
            JSON.stringify(utf8).slice(1, -1),
            encodeURIComponent(utf8),
          ]
        }),
      ),
    ].sort((left, right) => right.length - left.length)
    this.carry = Math.max(0, ...this.variants.map((secret) => secret.length - 1))
  }
  private consume(final: boolean): void {
    let boundary = final ? this.pending.length : Math.max(0, this.pending.length - this.carry)
    if (final) {
      for (const secret of this.variants) {
        const count = secret.length > 1 ? trailingPrefix(this.pending, secret) : 0
        boundary = Math.min(boundary, this.pending.length - count)
      }
    }
    let cursor = 0
    const parts: string[] = []
    while (cursor < boundary) {
      let start = boundary
      let length = 0
      for (const secret of this.variants) {
        const index = this.pending.indexOf(secret, cursor)
        if (index >= 0 && index < start) {
          start = index
          length = secret.length
        }
      }
      parts.push(this.pending.slice(cursor, start))
      cursor = start
      if (length) {
        parts.push('[redacted]')
        cursor += length
      }
    }
    if (final && cursor < this.pending.length) {
      parts.push('[redacted]')
      cursor = this.pending.length
    }
    this.output = (this.output + parts.join('')).slice(-this.limit)
    this.pending = this.pending.slice(cursor)
  }
  push(bytes: Buffer): void {
    if (this.ended) return
    this.pending += this.decoder.write(bytes)
    this.consume(false)
  }
  finish(): void {
    if (this.ended) return
    this.ended = true
    this.pending += this.decoder.end()
    this.consume(true)
  }
  get text(): string {
    return this.output
  }
}
