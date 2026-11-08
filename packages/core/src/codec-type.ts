/**
 * The value types a column codec sees. ClickHouse applies a codec to each data
 * stream of a column: the values inside Nullable, Array and LowCardinality, and
 * each element of a Tuple or Map. Array sizes and null maps are not codec input.
 */

export type CodecTypeFamily =
  | 'int'
  | 'bool'
  | 'float'
  | 'bfloat16'
  | 'decimal'
  | 'date'
  | 'time'
  | 'enum'
  | 'ipv4'
  | 'ipv6'
  | 'uuid'
  | 'string'
  | 'fixedstring'

/** A value type of a column. `width` is its size in bytes when known. */
export interface CodecValueType {
  type: string
  family: CodecTypeFamily
  width?: number
}

/**
 * The value types of a column type, or undefined when one of them is a type
 * chkit does not model (JSON, Dynamic, Variant, Nested, AggregateFunction, ...).
 */
export function codecValueTypes(columnType: string): CodecValueType[] | undefined {
  const type = columnType.trim()
  const wrapper = type.match(/^(Nullable|Array|LowCardinality)\(([\s\S]*)\)$/)
  if (wrapper?.[2] !== undefined) return codecValueTypes(wrapper[2])
  const aggregate = type.match(/^SimpleAggregateFunction\(([\s\S]*)\)$/)
  if (aggregate?.[1] !== undefined) {
    const args = splitTypeArguments(aggregate[1])
    return args.length === 2 && args[1] !== undefined ? codecValueTypes(args[1]) : undefined
  }
  const tuple = type.match(/^Tuple\(([\s\S]*)\)$/)
  if (tuple?.[1] !== undefined) return collect(splitTypeArguments(tuple[1]).map(stripElementName))
  const map = type.match(/^Map\(([\s\S]*)\)$/)
  if (map?.[1] !== undefined) return collect(splitTypeArguments(map[1]))
  const leaf = leafType(type)
  return leaf ? [leaf] : undefined
}

/**
 * The byte width ClickHouse fills in for a bare `Delta` or `Gorilla`: the width
 * of the column's values, or undefined (the codec stays bare) when they differ,
 * as in `Tuple(UInt8, UInt64)`, or are unknown.
 */
export function codecValueWidth(columnType: string): number | undefined {
  const widths = new Set(codecValueTypes(columnType)?.map((value) => value.width))
  if (widths.size !== 1) return undefined
  const [width] = widths
  return width
}

function collect(types: string[]): CodecValueType[] | undefined {
  const out: CodecValueType[] = []
  for (const type of types) {
    const values = codecValueTypes(type)
    if (!values) return undefined
    out.push(...values)
  }
  return out
}

const INTEGER_TYPE = /^U?Int(8|16|32|64|128|256)$/
const DECIMAL_SIZED_TYPE = /^Decimal(32|64|128|256)\(/
const DECIMAL_TYPE = /^Decimal\(\s*(\d+)/

function leafType(type: string): CodecValueType | undefined {
  const integer = type.match(INTEGER_TYPE)
  if (integer?.[1]) return { type, family: 'int', width: Number(integer[1]) / 8 }
  const sizedDecimal = type.match(DECIMAL_SIZED_TYPE)
  if (sizedDecimal?.[1]) return { type, family: 'decimal', width: Number(sizedDecimal[1]) / 8 }
  const decimal = type.match(DECIMAL_TYPE)
  if (decimal?.[1]) return { type, family: 'decimal', width: decimalWidth(Number(decimal[1])) }
  const fixedString = type.match(/^FixedString\(\s*(\d+)\s*\)$/)
  if (fixedString?.[1]) return { type, family: 'fixedstring', width: Number(fixedString[1]) }
  if (/^DateTime64\(/.test(type)) return { type, family: 'date', width: 8 }
  if (/^DateTime(\(|$)/.test(type)) return { type, family: 'date', width: 4 }
  if (/^Time64\(/.test(type)) return { type, family: 'time', width: 8 }
  if (/^Enum8\(/.test(type)) return { type, family: 'enum', width: 1 }
  if (/^Enum16\(/.test(type)) return { type, family: 'enum', width: 2 }
  const enumeration = type.match(/^Enum\(([\s\S]*)\)$/)
  if (enumeration?.[1] !== undefined) {
    const values = splitTypeArguments(enumeration[1]).map((entry) => {
      const value = entry.match(/=\s*([+-]?[0-9]+)\s*$/)?.[1]
      return value === undefined ? undefined : Number(value)
    })
    if (values.some((value) => value === undefined)) return { type, family: 'enum' }
    return { type, family: 'enum', width: values.every((value) => value !== undefined && value >= -128 && value <= 127) ? 1 : 2 }
  }
  const simple = SIMPLE_TYPES[type]
  return simple ? { type, ...simple } : undefined
}

const SIMPLE_TYPES: Record<string, { family: CodecTypeFamily; width?: number }> = {
  Bool: { family: 'bool', width: 1 },
  Boolean: { family: 'bool', width: 1 },
  Float32: { family: 'float', width: 4 },
  Float64: { family: 'float', width: 8 },
  BFloat16: { family: 'bfloat16', width: 2 },
  Date: { family: 'date', width: 2 },
  Date32: { family: 'date', width: 4 },
  Time: { family: 'time', width: 4 },
  IPv4: { family: 'ipv4', width: 4 },
  IPv6: { family: 'ipv6', width: 16 },
  UUID: { family: 'uuid', width: 16 },
  String: { family: 'string' },
}

function decimalWidth(precision: number): number {
  if (precision <= 9) return 4
  if (precision <= 18) return 8
  if (precision <= 38) return 16
  return 32
}

/** `a UInt8` or `` `a b` UInt8 `` in a named Tuple is the element type `UInt8`. */
function stripElementName(element: string): string {
  const named = element.trim().match(/^(?:`[^`]*`|"[^"]*"|[A-Za-z_][A-Za-z0-9_]*)\s+(\S[\s\S]*)$/)
  return named?.[1] ?? element
}

/** Splits type arguments on top-level commas, outside parentheses and quotes. */
function splitTypeArguments(input: string): string[] {
  const out: string[] = []
  let depth = 0
  let quote: string | undefined
  let current = ''
  let escaped = false
  for (const ch of input) {
    if (quote) {
      if (escaped) escaped = false
      else if (ch === '\\') escaped = true
      else if (ch === quote) quote = undefined
    } else if (ch === "'" || ch === '`' || ch === '"') {
      quote = ch
    } else if (ch === '(') {
      depth += 1
    } else if (ch === ')') {
      depth -= 1
    } else if (ch === ',' && depth === 0) {
      out.push(current.trim())
      current = ''
      continue
    }
    current += ch
  }
  out.push(current.trim())
  return out
}
