import { z } from 'zod'

/**
 * Type-only brand that carries a param's name. Zod methods return `this`, so
 * it survives `.min()` and `.refine()`, and wrappers like `.optional()` keep
 * it on their inner schema.
 */
export interface NamedParam<N extends string = string> {
  readonly '~param': N
}

export interface ParamHelper<S extends z.ZodType> {
  (): S
  <const N extends string>(name: N): S & NamedParam<N>
}

export interface DateTime64Helper {
  (precision?: number): DateTimeValue
  <const N extends string>(name: N, precision?: number): DateTimeValue & NamedParam<N>
}

type DateTimeValue = z.ZodUnion<[z.ZodDate, z.ZodISODateTime]>

const STRING_TYPES: Record<string, string> = { uuid: 'UUID', date: 'Date', datetime: 'DateTime64(3)' }
const NUMBER_TYPES: Record<string, string> = {
  safeint: 'Int64',
  int32: 'Int32',
  uint32: 'UInt32',
  float32: 'Float32',
  float64: 'Float64',
}
const BIGINT_TYPES: Record<string, string> = { int64: 'Int64', uint64: 'UInt64' }

/**
 * Names a query param. `p(name, schema)` names any Zod schema; the helpers
 * return plain Zod tagged with their ClickHouse type, e.g. `p.string('city')`.
 * Called without a name, a helper returns an element type such as
 * `z.array(p.date())`.
 */
export const p = Object.assign(namedParam, {
  string: paramHelper(() => z.string(), 'String'),
  bool: paramHelper(() => z.boolean(), 'Bool'),
  int8: paramHelper(() => z.int().min(-128).max(127), 'Int8'),
  int16: paramHelper(() => z.int().min(-32768).max(32767), 'Int16'),
  int32: paramHelper(() => z.int32(), 'Int32'),
  int64: paramHelper(() => z.union([z.int64(), z.int()]), 'Int64'),
  uint8: paramHelper(() => z.int().min(0).max(255), 'UInt8'),
  uint16: paramHelper(() => z.int().min(0).max(65535), 'UInt16'),
  uint32: paramHelper(() => z.uint32(), 'UInt32'),
  uint64: paramHelper(() => z.union([z.uint64(), z.int().min(0)]), 'UInt64'),
  float32: paramHelper(() => z.float32(), 'Float32'),
  float64: paramHelper(() => z.number(), 'Float64'),
  date: paramHelper(() => z.union([z.date(), z.iso.date()]), 'Date'),
  dateTime: paramHelper(dateTimeValue, 'DateTime'),
  dateTime64: dateTime64Helper(),
  uuid: paramHelper(() => z.uuid(), 'UUID'),
  identifier: paramHelper(() => z.string(), 'Identifier'),
})

/** The name `p` gave a schema, or the schema it wraps. */
export function paramName(schema: z.core.$ZodType): string | undefined {
  const own = metaString(schema, 'param')
  if (own) return own
  const inner = innerSchema(schema)
  return inner && paramName(inner)
}

/**
 * The ClickHouse type of a param: the type `p` tagged or set with
 * `.meta({ clickhouse })`, otherwise mapped from the Zod schema.
 */
export function clickhouseType(schema: z.core.$ZodType): string {
  const explicit = metaString(schema, 'clickhouse')
  if (explicit) return explicit
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
  }
  throw new Error(`No ClickHouse type for Zod "${def.type}"; set one with p(name, schema.meta({ clickhouse: '...' }))`)
}

/** The param's default as JSON, so two parts can compare their defaults. */
export function paramDefault(schema: z.core.$ZodType): string | undefined {
  const def = (schema as z.core.$ZodTypes)._zod.def
  if (def.type === 'default' || def.type === 'prefault') {
    return JSON.stringify(def.defaultValue, (_key, value) => (typeof value === 'bigint' ? value.toString() : value))
  }
  const inner = innerSchema(schema)
  return inner && paramDefault(inner)
}

function namedParam<const N extends string, S extends z.ZodType>(name: N, schema: S): S & NamedParam<N> {
  return schema.meta({ param: name }) as S & NamedParam<N>
}

function paramHelper<S extends z.ZodType>(make: () => S, clickhouse: string): ParamHelper<S> {
  return ((name?: string) => make().meta(name ? { clickhouse, param: name } : { clickhouse })) as ParamHelper<S>
}

function dateTime64Helper(): DateTime64Helper {
  return ((nameOrPrecision?: string | number, precision = 3) => {
    const name = typeof nameOrPrecision === 'string' ? nameOrPrecision : undefined
    const scale = typeof nameOrPrecision === 'number' ? nameOrPrecision : precision
    const clickhouse = `DateTime64(${scale})`
    return dateTimeValue().meta(name ? { clickhouse, param: name } : { clickhouse })
  }) as DateTime64Helper
}

function dateTimeValue(): DateTimeValue {
  return z.union([z.date(), z.iso.datetime()])
}

function innerSchema(schema: z.core.$ZodType): z.core.$ZodType | undefined {
  const def = (schema as z.core.$ZodTypes)._zod.def
  switch (def.type) {
    case 'optional':
    case 'nullable':
    case 'default':
    case 'prefault':
      return def.innerType
    case 'pipe':
      return def.in
  }
  return undefined
}

function metaString(schema: z.core.$ZodType, key: 'clickhouse' | 'param'): string | undefined {
  const value = z.globalRegistry.get(schema)?.[key]
  return typeof value === 'string' ? value : undefined
}

function nullable(type: string): string {
  return type.startsWith('Nullable(') ? type : `Nullable(${type})`
}
