import { z } from 'zod'

import { type ColumnOnly, clickhouseType, columnOnlyType, t } from './clickhouse-type.js'

/**
 * Type-only brand that carries a param's name. Zod methods return `this`, so
 * it survives `.min()` and `.refine()`, and wrappers like `.optional()` keep
 * it on their inner schema.
 */
export interface NamedParam<N extends string = string> {
  readonly '~param': N
}

/** What `p` requires of a column-only type, which it never has. */
export interface NotAParam {
  readonly '~error': 'Tuple, Nested, Variant, Dynamic and AggregateFunction are column-only types'
}

/** Rejects a schema that is, or holds, a column-only type. */
export type ParamSchema<S> = IsColumnOnly<S> extends true ? NotAParam : unknown

type IsColumnOnly<S> = S extends ColumnOnly
  ? true
  : S extends z.ZodArray<infer E>
    ? IsColumnOnly<E>
    : S extends z.ZodRecord<infer _K, infer V>
      ? IsColumnOnly<V>
      : S extends { readonly _zod: { readonly def: { readonly innerType: infer I } } }
        ? IsColumnOnly<I>
        : false

/**
 * Names a query param: `p('city', t.string())`, `p('city', events.column('city'))`
 * or any Zod schema. Shorthands name the common `t` types: `p.string('city')`.
 */
export const p = Object.assign(namedParam, {
  string: shorthand(t.string),
  bool: shorthand(t.bool),
  int8: shorthand(t.int8),
  int16: shorthand(t.int16),
  int32: shorthand(t.int32),
  int64: shorthand(t.int64),
  uint8: shorthand(t.uint8),
  uint16: shorthand(t.uint16),
  uint32: shorthand(t.uint32),
  uint64: shorthand(t.uint64),
  float32: shorthand(t.float32),
  float64: shorthand(t.float64),
  date: shorthand(t.date),
  dateTime: shorthand(t.dateTime),
  dateTime64: shorthand(t.dateTime64),
  uuid: shorthand(t.uuid),
  identifier: shorthand(() => z.string().meta({ clickhouse: 'Identifier' })),
})

/** The ClickHouse type of a param; throws for a type ClickHouse can't take as one. */
export function paramType(schema: z.core.$ZodType): string {
  const type = clickhouseType(schema)
  const columnOnly = columnOnlyType(type)
  if (columnOnly) throw new Error(`${type} can't be a query param: ${columnOnly} is a column-only type`)
  return type
}

/** The name `p` gave a schema, or the schema it wraps. */
export function paramName(schema: z.core.$ZodType): string | undefined {
  const own = z.globalRegistry.get(schema)?.param
  if (typeof own === 'string') return own
  const inner = innerSchema(schema)
  return inner && paramName(inner)
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

function namedParam<const N extends string, S extends z.ZodType>(name: N, schema: S & ParamSchema<S>): S & NamedParam<N> {
  try {
    paramType(schema)
  } catch (error) {
    throw new Error(`p("${name}"): ${error instanceof Error ? error.message : String(error)}`, { cause: error })
  }
  return schema.meta({ param: name }) as S & NamedParam<N>
}

function shorthand<A extends unknown[], S extends z.ZodType>(make: (...args: A) => S) {
  return <const N extends string>(name: N, ...args: A): S & NamedParam<N> =>
    namedParam(name, make(...args) as S & ParamSchema<S>)
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
