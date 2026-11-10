import { z } from 'zod'

import { nullableColumnType } from './column-default.js'

/** Type-only brand of a type ClickHouse can't take as a query param, such as a Tuple. */
export interface ColumnOnly {
  readonly '~columnOnly': true
}

type DateValue = z.ZodUnion<[z.ZodDate, z.ZodISODate]>
type DateTimeValue = z.ZodUnion<[z.ZodDate, z.ZodISODateTime]>
type BigIntValue = z.ZodUnion<[z.ZodBigInt, z.ZodNumber]>
type EnumValues = Record<string, number>
type EnumOf<E extends EnumValues> = z.ZodEnum<{ [K in keyof E & string]: K }>
type TupleItems = readonly [z.ZodType, ...z.ZodType[]]

const STRING_TYPES: Record<string, string> = {
  uuid: 'UUID',
  ipv4: 'IPv4',
  ipv6: 'IPv6',
  date: 'Date',
  datetime: 'DateTime64(3)',
}
const NUMBER_TYPES: Record<string, string> = {
  safeint: 'Int64',
  int32: 'Int32',
  uint32: 'UInt32',
  float32: 'Float32',
  float64: 'Float64',
}
const BIGINT_TYPES: Record<string, string> = { int64: 'Int64', uint64: 'UInt64' }
const NOT_NULLABLE = /^(Array|Map|Tuple|Nested|JSON|Variant|Dynamic)\b/
const LOW_CARDINALITY = /^\s*LowCardinality\s*\(/
const LOW_CARDINALITY_NULLABLE = /^\s*LowCardinality\s*\(\s*Nullable\s*\(/
const COLUMN_ONLY = /(?:^|[(,]\s*)(Tuple|Nested|Variant|Dynamic|AggregateFunction)\b/
const DECIMAL = /^-?\d+(\.\d+)?$/

/**
 * ClickHouse types for columns and query params. Each is a Zod schema of the
 * values a param accepts, tagged with its ClickHouse type:
 * `{ name: 'city', type: t.lowCardinality(t.string()) }` or
 * `p('tags', t.array(t.string()))`. Tuple, Nested, Variant, Dynamic and
 * AggregateFunction are column-only.
 */
export const t = {
  string: () => typed(z.string(), 'String'),
  /** At most `length` bytes. */
  fixedString: (length: number) =>
    typed(
      z.string().refine((value) => new TextEncoder().encode(value).length <= length, `At most ${length} bytes`),
      `FixedString(${length})`,
    ),
  bool: () => typed(z.boolean(), 'Bool'),
  int8: () => typed(z.int().min(-128).max(127), 'Int8'),
  int16: () => typed(z.int().min(-32768).max(32767), 'Int16'),
  int32: () => typed(z.int32(), 'Int32'),
  int64: () => typed(z.union([z.int64(), z.int()]), 'Int64'),
  int128: () => typed(bigInteger(-(2n ** 127n), 2n ** 127n - 1n), 'Int128'),
  int256: () => typed(bigInteger(-(2n ** 255n), 2n ** 255n - 1n), 'Int256'),
  uint8: () => typed(z.int().min(0).max(255), 'UInt8'),
  uint16: () => typed(z.int().min(0).max(65535), 'UInt16'),
  uint32: () => typed(z.uint32(), 'UInt32'),
  uint64: () => typed(z.union([z.uint64(), z.int().min(0)]), 'UInt64'),
  uint128: () => typed(bigInteger(0n, 2n ** 128n - 1n), 'UInt128'),
  uint256: () => typed(bigInteger(0n, 2n ** 256n - 1n), 'UInt256'),
  float32: () => typed(z.float32(), 'Float32'),
  float64: () => typed(z.number(), 'Float64'),
  /** A number, or a decimal string to keep every digit. */
  decimal: (precision: number, scale: number) =>
    typed(z.union([z.number(), z.string().regex(DECIMAL)]), `Decimal(${precision}, ${scale})`),
  date: () => typed(dateValue(), 'Date'),
  date32: () => typed(dateValue(), 'Date32'),
  dateTime: (timezone?: string) => typed(dateTimeValue(), timezone ? `DateTime(${quote(timezone)})` : 'DateTime'),
  /** Defaults to millisecond precision. */
  dateTime64: (precision = 3, timezone?: string) =>
    typed(dateTimeValue(), `DateTime64(${precision}${timezone ? `, ${quote(timezone)}` : ''})`),
  uuid: () => typed(z.uuid(), 'UUID'),
  ipv4: () => typed(z.ipv4(), 'IPv4'),
  ipv6: () => typed(z.ipv6(), 'IPv6'),
  /** Names and their values: `t.enum8({ view: 1, click: 2 })`. */
  enum8: <const E extends EnumValues>(values: E) => enumType('Enum8', values),
  enum16: <const E extends EnumValues>(values: E) => enumType('Enum16', values),
  json: () => typed(z.json(), 'JSON'),
  array: <T extends z.ZodType>(element: T) => z.array(element),
  /** Keys are string or number types. */
  map: <K extends z.core.$ZodRecordKey, V extends z.ZodType>(key: K, value: V) => z.record(key, value),
  nullable: <T extends z.ZodType>(type: T) => type.nullable(),
  lowCardinality: <T extends z.ZodType>(type: T): T => typed(type, `LowCardinality(${clickhouseType(type)})`),
  /** Unnamed `t.tuple([t.string(), t.uint8()])` or named `t.tuple({ name: t.string() })`. */
  tuple: tupleType,
  nested: <S extends z.ZodRawShape>(shape: S) =>
    typed(z.array(z.object(shape)), `Nested(${fields(shape)})`) as z.ZodArray<z.ZodObject<S>> & ColumnOnly,
  variant: <const T extends TupleItems>(...types: T) =>
    typed(z.union(types), `Variant(${types.map(clickhouseType).sort().join(', ')})`) as z.ZodUnion<T> & ColumnOnly,
  dynamic: () => typed(z.unknown(), 'Dynamic') as z.ZodUnknown & ColumnOnly,
  /** `t.aggregateFunction('uniq', t.string())`; a parametric function as `'quantiles(0.5, 0.9)'`. */
  aggregateFunction: (fn: string, ...args: z.ZodType[]) =>
    typed(z.unknown(), `AggregateFunction(${[fn, ...args.map(clickhouseType)].join(', ')})`) as z.ZodUnknown & ColumnOnly,
  simpleAggregateFunction: <T extends z.ZodType>(fn: string, type: T): T =>
    typed(type, `SimpleAggregateFunction(${fn}, ${clickhouseType(type)})`),
}

/**
 * The ClickHouse type of a `t` type or a schema with `.meta({ clickhouse })`,
 * otherwise mapped from the Zod schema.
 */
export function clickhouseType(schema: z.core.$ZodType): string {
  const explicit = z.globalRegistry.get(schema)?.clickhouse
  if (typeof explicit === 'string') return explicit
  const def = (schema as z.core.$ZodTypes)._zod.def
  const format = schema._zod.bag.format
  const formatType = (types: Record<string, string>) => (typeof format === 'string' ? types[format] : undefined)
  switch (def.type) {
    case 'optional':
    case 'nullable':
      return nullable(clickhouseType(def.innerType))
    case 'default':
    case 'prefault':
      return clickhouseType(def.innerType)
    case 'pipe':
      return clickhouseType(def.in)
    case 'string':
      return formatType(STRING_TYPES) ?? 'String'
    case 'number':
      return formatType(NUMBER_TYPES) ?? 'Float64'
    case 'bigint':
      return formatType(BIGINT_TYPES) ?? 'Int64'
    case 'boolean':
      return 'Bool'
    case 'date':
      return 'DateTime64(3)'
    case 'enum':
      return 'String'
    case 'array':
      return `Array(${clickhouseType(def.element)})`
    case 'record':
      return `Map(${clickhouseType(def.keyType)}, ${clickhouseType(def.valueType)})`
  }
  throw new Error(`No ClickHouse type for Zod "${def.type}"; use a t type or set one with .meta({ clickhouse: '...' })`)
}

/** The column-only type that a ClickHouse type is or contains. */
export function columnOnlyType(type: string): string | undefined {
  return COLUMN_ONLY.exec(type)?.[1]
}

function typed<S extends z.ZodType>(schema: S, clickhouse: string): S {
  return schema.meta({ clickhouse })
}

function bigInteger(min: bigint, max: bigint): BigIntValue {
  return z.union([z.bigint().min(min).max(max), min < 0n ? z.int() : z.int().min(0)])
}

function enumType<E extends EnumValues>(kind: 'Enum8' | 'Enum16', values: E): EnumOf<E> {
  const entries = Object.entries(values).map(([name, value]) => `${quote(name)} = ${value}`)
  return typed(z.enum(Object.keys(values) as Array<keyof E & string>), `${kind}(${entries.join(', ')})`) as EnumOf<E>
}

function tupleType<const T extends TupleItems>(items: T): z.ZodTuple<T, null> & ColumnOnly
function tupleType<S extends z.ZodRawShape>(shape: S): z.ZodObject<S> & ColumnOnly
function tupleType(items: TupleItems | z.ZodRawShape): z.ZodType {
  if (Array.isArray(items)) return typed(z.tuple(items as TupleItems), `Tuple(${items.map(clickhouseType).join(', ')})`)
  return typed(z.object(items as z.ZodRawShape), `Tuple(${fields(items as z.ZodRawShape)})`)
}

function fields(shape: z.ZodRawShape): string {
  return Object.entries(shape)
    .map(([name, type]) => `${name} ${clickhouseType(type)}`)
    .join(', ')
}

function dateValue(): DateValue {
  return z.union([z.date(), z.iso.date()])
}

function dateTimeValue(): DateTimeValue {
  return z.union([z.date(), z.iso.datetime()])
}

function quote(value: string): string {
  return `'${value.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`
}

/** ClickHouse has no Nullable(LowCardinality(T)), so a nullable LowCardinality(T) is LowCardinality(Nullable(T)). */
function nullable(type: string): string {
  if (type.startsWith('Nullable(') || LOW_CARDINALITY_NULLABLE.test(type)) return type
  if (LOW_CARDINALITY.test(type)) return nullableColumnType(type.trim())
  if (NOT_NULLABLE.test(type)) {
    throw new Error(`ClickHouse has no Nullable(${type}); use .default() instead of .optional() or .nullable()`)
  }
  return `Nullable(${type})`
}
