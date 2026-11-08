import { parseIntegerLiteral } from './codec-integer.js'
import { splitTopLevelComma } from './key-clause.js'
import { tokenizeSQL } from './sql-lexer.js'

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
  | 'nullable'
  | 'dynamic'

/** A value type of a column. `width` is its size in bytes when known. */
export interface CodecValueType {
  type: string
  family: CodecTypeFamily
  width?: number
}

/**
 * The value types of a column type, or undefined when one of them is a type
 * chkit does not model (Variant, Nested, AggregateFunction, ...).
 */
export function codecValueTypes(columnType: string): CodecValueType[] | undefined {
  const type = tokenizeSQL(columnType).map((token) =>
    token.kind === 'line_comment' || token.kind === 'block_comment' ? ' ' : token.text
  ).join('').trim()
  const wrapper = type.match(/^(Nullable|Array|LowCardinality)\s*\(([\s\S]*)\)$/)
  if (wrapper?.[2] !== undefined) {
    if (wrapper[1] === 'LowCardinality' && /^Nullable\s*\(/.test(wrapper[2].trim())) {
      return [{ type: wrapper[2].trim(), family: 'nullable' }]
    }
    return codecValueTypes(wrapper[2])
  }
  const aggregate = type.match(/^SimpleAggregateFunction\s*\(([\s\S]*)\)$/)
  if (aggregate?.[1] !== undefined) {
    const args = splitTopLevelComma(aggregate[1])
    return args.length === 2 && args[1] !== undefined ? codecValueTypes(args[1]) : undefined
  }
  const tuple = type.match(/^Tuple\s*\(([\s\S]*)\)$/)
  if (tuple?.[1] !== undefined) return collect(splitTopLevelComma(tuple[1]).map(stripElementName))
  const map = type.match(/^Map\s*\(([\s\S]*)\)$/)
  if (map?.[1] !== undefined) return collect(splitTopLevelComma(map[1]))
  const leaf = leafType(type)
  return leaf ? [leaf] : undefined
}

/** Whether a float is reachable without entering Map or LowCardinality; unknown types stay unknown. */
export function codecHasReachableFloat(columnType: string): boolean | undefined {
  const type = tokenizeSQL(columnType).map((token) =>
    token.kind === 'line_comment' || token.kind === 'block_comment' ? ' ' : token.text
  ).join('').trim()
  if (/^(LowCardinality|Map)\s*\(/.test(type)) return false
  const wrapper = type.match(/^(Nullable|Array)\s*\(([\s\S]*)\)$/)
  if (wrapper?.[2] !== undefined) return codecHasReachableFloat(wrapper[2])
  const aggregate = type.match(/^SimpleAggregateFunction\s*\(([\s\S]*)\)$/)
  if (aggregate?.[1] !== undefined) {
    const args = splitTopLevelComma(aggregate[1])
    return args.length === 2 && args[1] !== undefined ? codecHasReachableFloat(args[1]) : undefined
  }
  const tuple = type.match(/^Tuple\s*\(([\s\S]*)\)$/)
  if (tuple?.[1] !== undefined) {
    const floats = splitTopLevelComma(tuple[1]).map((element) => codecHasReachableFloat(stripElementName(element)))
    if (floats.includes(true)) return true
    return floats.includes(undefined) ? undefined : false
  }
  const leaf = leafType(type)
  return leaf ? leaf.family === 'float' || leaf.family === 'bfloat16' : undefined
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
const DECIMAL_SIZED_TYPE = /^Decimal(32|64|128|256)\s*\(/
const DECIMAL_TYPE = /^Decimal\s*\(\s*([0-9]+)/

function leafType(type: string): CodecValueType | undefined {
  const integer = type.match(INTEGER_TYPE)
  if (integer?.[1]) return { type, family: 'int', width: Number(integer[1]) / 8 }
  const sizedDecimal = type.match(DECIMAL_SIZED_TYPE)
  if (sizedDecimal?.[1]) return { type, family: 'decimal', width: Number(sizedDecimal[1]) / 8 }
  const decimal = type.match(DECIMAL_TYPE)
  if (decimal?.[1]) return { type, family: 'decimal', width: decimalWidth(Number(decimal[1])) }
  const fixedString = type.match(/^FixedString\s*\(\s*([0-9]+)\s*\)$/)
  if (fixedString?.[1]) return { type, family: 'fixedstring', width: Number(fixedString[1]) }
  if (/^DateTime64\s*\(/.test(type)) return { type, family: 'date', width: 8 }
  if (/^DateTime(?:\s*\(|$)/.test(type)) return { type, family: 'date', width: 4 }
  if (/^Time64\s*\(/.test(type)) return { type, family: 'time', width: 8 }
  if (/^Enum8\s*\(/.test(type)) return { type, family: 'enum', width: 1 }
  if (/^Enum16\s*\(/.test(type)) return { type, family: 'enum', width: 2 }
  const enumeration = type.match(/^Enum\s*\(([\s\S]*)\)$/)
  if (enumeration?.[1] !== undefined) {
    const width = enumWidth(enumeration[1])
    return width === undefined ? undefined : { type, family: 'enum', width }
  }
  const simple = SIMPLE_TYPES[type]
  return simple ? { type, ...simple } : undefined
}

const SIMPLE_TYPES: Record<string, { family: CodecTypeFamily; width?: number }> = {
  Dynamic: { family: 'dynamic', width: 1 },
  JSON: { family: 'dynamic', width: 1 },
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

function enumWidth(argumentsText: string): number | undefined {
  let previous = 0n
  let fitsInt8 = true
  const entries = splitTopLevelComma(argumentsText)
  if (entries.length === 0) return undefined
  for (const entry of entries) {
    const match = entry.match(/^'(?:\\[\s\S]|''|[^'\\])*'(?:\s*=\s*([\s\S]+))?\s*$/)
    if (!match) return undefined
    const literal = match[1] === undefined ? previous + 1n : parseIntegerLiteral(match[1].trim().replace(/^([+-])\s+/, '$1'))
    if (literal === undefined) return undefined
    // ClickHouse's integer AST reads UInt64 literals as signed Enum values.
    const value = BigInt.asIntN(64, literal)
    fitsInt8 = fitsInt8 && value >= -128n && value <= 127n
    previous = value
  }
  return fitsInt8 ? 1 : 2
}

/** `a UInt8` or `` `a b` UInt8 `` in a named Tuple is the element type `UInt8`. */
function stripElementName(element: string): string {
  const named = element.trim().match(/^(?:`(?:\\[\s\S]|``|[^`\\])*`|"(?:\\[\s\S]|""|[^"\\])*"|[A-Za-z_][A-Za-z0-9_]*)\s+(\S[\s\S]*)$/)
  return named?.[1] && !named[1].startsWith('(') ? named[1] : element
}
