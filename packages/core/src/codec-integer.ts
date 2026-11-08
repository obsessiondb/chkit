const UINT64_SIGN = 9223372036854775808n
const UINT64_RANGE = 18446744073709551616n
const MAX_SAFE = BigInt(Number.MAX_SAFE_INTEGER)

/**
 * The integer literals ClickHouse takes as a codec argument; a float such as
 * `1.0` is not one. Beyond ±(2^53 - 1) a JS number is not exact, so chkit-py
 * leaves such an argument unparsed too.
 */
const INTEGER_ARG = /^[+-]?(?:0[xX][0-9a-fA-F]+(?:_[0-9a-fA-F]+)*|0b[01]+(?:_[01]+)*|\d+(?:_\d+)*)$/

/**
 * An integer codec argument as ClickHouse reads it: decimal (`1_0` is 10),
 * `0x` hex or `0b` binary, optionally signed. ClickHouse prints a negative
 * level unsigned: `ZSTD(-1)` reads back as `ZSTD(18446744073709551615)`.
 */
export function parseIntegerArg(raw: string): number | undefined {
  const signed = parseIntegerLiteral(raw)
  if (signed === undefined) return undefined
  const value = signed >= UINT64_SIGN ? signed - UINT64_RANGE : signed
  return value >= -MAX_SAFE && value <= MAX_SAFE ? Number(value) : undefined
}

/** An exact integer literal, before codec argument wrapping and JS number bounds. */
export function parseIntegerLiteral(raw: string): bigint | undefined {
  if (!INTEGER_ARG.test(raw)) return undefined
  const magnitude = BigInt(raw.replace(/^[+-]/, '').replaceAll('_', ''))
  if (magnitude >= UINT64_RANGE) return undefined
  return raw.startsWith('-') ? -magnitude : magnitude
}
