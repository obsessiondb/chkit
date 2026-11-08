/** A run of 16 digits and points: a number a double may round has one. */
const SIXTEEN_DIGITS_RE = /[\d.]{16}/

/** Parses a `JSONEachRow` body, every nonempty line as `parseJsonEachRowLine`. */
export function parseJsonEachRow<T>(body: string): T[] {
  return body
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line) => parseJsonEachRowLine<T>(line))
}

/**
 * Parses one `JSONEachRow` line without rounding (#415). A number whose
 * double does not print back to the digits ClickHouse wrote (a 64-bit or
 * wider integer beyond 2^53, a Decimal with more than 15 significant digits)
 * becomes a string of those digits. Every other number, Float64 included, stays a
 * number. This needs no column types: values that read correctly keep their type.
 */
export function parseJsonEachRowLine<T>(line: string): T {
  // The reviver makes JSON.parse several times slower. A number with more
  // than 15 digits needs a run of 16 digits and points, so a line without
  // one has nothing to restore.
  if (!SIXTEEN_DIGITS_RE.test(line)) return JSON.parse(line)
  return JSON.parse(line, (_key, value: unknown, context?: { source?: string }) =>
    typeof value === 'number' ? roundTripNumber(context?.source, value) : value,
  )
}

/** The number, or the digits ClickHouse wrote when its double prints other digits. */
export function roundTripNumber(source: string | undefined, value: number): number | string {
  // Up to 15 significant digits always survive a double (DBL_DIG), and
  // Node 20 gives the reviver no source text: both keep the number.
  if (source === undefined || source.length <= 15) return value
  return canonicalDecimal(source) === canonicalDecimal(String(value)) ? value : source
}

/**
 * A JSON number's value as `<sign><significant digits>e<exponent>`, so that
 * `100000000000000000000` and `1e+20`, or `0.10` and `0.1`, compare equal.
 */
function canonicalDecimal(text: string): string {
  const match = /^(-?)(\d*)(?:\.(\d*))?(?:[eE]([+-]?\d+))?$/.exec(text)
  if (!match) return text
  const [, sign = '', integer = '', fraction = '', exponent = '0'] = match
  const digits = integer + fraction
  const first = digits.search(/[1-9]/)
  if (first === -1) return '0'
  return `${sign}${digits.slice(first).replace(/0+$/, '')}e${integer.length - first + Number(exponent)}`
}
