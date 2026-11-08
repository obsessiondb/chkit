import { z } from 'zod'

import { quoteIdentifier } from './identifier.js'
import { splitTopLevelComma } from './key-clause.js'
import type { DictionaryDefinition, MaterializedViewDefinition, TableDefinition, ViewDefinition } from './model-types.js'
import { type NamedParam, paramDefault, paramName, paramType } from './query-param.js'
import { tokenizeSQL } from './sql-lexer.js'

/** The part of a `@clickhouse/client` client that queries use. */
export interface QueryClient {
  query(params: {
    query: string
    format?: 'JSONEachRow'
    query_params?: Record<string, unknown>
    clickhouse_settings?: object
    query_id?: string
    abort_signal?: AbortSignal
  }): Promise<{ json(): Promise<unknown> }>
}

export interface QueryOptions<R extends z.ZodType | undefined = undefined> {
  /** Names the query in `system.query_log` through `log_comment`. */
  name?: string
  /** Defaults to 1. */
  version?: number
  /** Parses every row; the rows get its output type. */
  returns?: R
}

export interface QueryCallOptions {
  clickhouse_settings?: Record<string, unknown>
  query_id?: string
  abort_signal?: AbortSignal
  /** Runs the query on this client instead of the one bound with `createQuery`. */
  client?: QueryClient
}

/** A query definition. Interpolate it into another query to use it as a subquery. */
export interface QueryDefinition<S extends z.ZodRawShape = z.ZodRawShape> {
  readonly name: string | undefined
  readonly version: number
  /** The SQL sent to ClickHouse, with each param as a `{name:Type}` placeholder. */
  readonly sql: string
  /** A `z.object` of every param, including those of composed queries. */
  readonly params: z.ZodObject<S>
}

/** A query you call with its params; it validates them through `params` and returns the rows. */
export interface Query<S extends z.ZodRawShape = z.ZodRawShape, Row = Record<string, unknown>> extends QueryDefinition<S> {
  (...args: QueryArgs<S>): Promise<Row[]>
  /** Types the rows as `R` without parsing them. */
  returns<R>(): Query<S, R>
}

/** A chkit table, view, materialized view or dictionary. */
export type QueryObjectRef = Pick<
  TableDefinition | ViewDefinition | MaterializedViewDefinition | DictionaryDefinition,
  'kind' | 'database' | 'name'
>

/** What a query template accepts: named params, queries and chkit objects. */
export type QueryInterpolation = NamedSchema | QueryDefinition | QueryObjectRef

type QueryTemplate<Row> = <const V extends readonly QueryInterpolation[]>(
  strings: TemplateStringsArray,
  ...values: V
) => Query<ParamsShape<V>, Row>

export interface QueryTag extends QueryTemplate<Record<string, unknown>> {
  <R extends z.ZodType | undefined = undefined>(options: QueryOptions<R>): QueryTemplate<RowOf<R>>
}

type QueryArgs<S extends z.ZodRawShape> = Record<never, never> extends z.input<z.ZodObject<S>>
  ? [params?: z.input<z.ZodObject<S>>, options?: QueryCallOptions]
  : [params: z.input<z.ZodObject<S>>, options?: QueryCallOptions]
type RowOf<R> = R extends z.ZodType ? z.output<R> : Record<string, unknown>

interface Wrapping<T> {
  readonly _zod: { readonly def: { readonly innerType: T } }
}
type NamedSchema = z.ZodType & (NamedParam | Wrapping<NamedParam> | Wrapping<Wrapping<NamedParam>>)

type ParamNameOf<S> = S extends NamedParam<infer N>
  ? N
  : S extends Wrapping<infer I>
    ? ParamNameOf<I>
    : S extends z.ZodPipe<infer I, z.ZodType>
      ? ParamNameOf<I>
      : never
type ShapeOf<X> = X extends QueryDefinition<infer S>
  ? S
  : X extends z.ZodType
    ? { [K in ParamNameOf<X>]: X }
    : EmptyShape
type EmptyShape = Record<never, never>
type UnionToIntersection<U> = (U extends unknown ? (x: U) => void : never) extends (x: infer I) => void ? I : never
type Simplify<T> = { [K in keyof T]: T[K] } & {}
type AsShape<T> = T extends z.ZodRawShape ? T : never
type ParamsShape<V extends readonly unknown[]> = AsShape<Simplify<UnionToIntersection<ShapeOf<V[number]> | EmptyShape>>>

type ClientResolver = () => Promise<QueryClient>

interface ParamSpec {
  readonly schemas: readonly z.ZodType[]
  readonly clickhouseType: string
  readonly defaultValue: string | undefined
}

const PARAM_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/
const OBJECT_KINDS = new Set<unknown>(['table', 'view', 'materialized_view', 'dictionary'])
const paramSpecs = new WeakMap<object, ReadonlyMap<string, ParamSpec>>()

/**
 * Binds queries to a client: `createQuery(client)`, or a function returning
 * one, sync or async, which runs on the first call and is cached. A function
 * that throws runs again on the next call.
 */
export function createQuery(source: QueryClient | (() => QueryClient | Promise<QueryClient>)): QueryTag {
  let pending: Promise<QueryClient> | undefined
  return queryTag(() => {
    pending ??= Promise.resolve(typeof source === 'function' ? source() : source).catch((error: unknown) => {
      pending = undefined
      throw error
    })
    return pending
  })
}

/**
 * Defines a query from a tagged template, with options first when needed:
 * query({ name: 'top_cities' })`SELECT ...`. Params are named with `p`;
 * interpolated queries become subqueries and their params merge by name.
 * Queries from this unbound `query` run with `{ client }` in their call options.
 */
export const query = queryTag(undefined)

function queryTag(resolveClient: ClientResolver | undefined): QueryTag {
  return ((first: TemplateStringsArray | QueryOptions<z.ZodType | undefined>, ...values: unknown[]) => {
    if (isTemplate(first)) return defineQuery(first, values, {}, resolveClient)
    return (strings: TemplateStringsArray, ...templateValues: unknown[]) =>
      defineQuery(strings, templateValues, first, resolveClient)
  }) as QueryTag
}

function defineQuery(
  strings: TemplateStringsArray,
  values: readonly unknown[],
  options: QueryOptions<z.ZodType | undefined>,
  resolveClient: ClientResolver | undefined,
): Query {
  const label = options.name ? `query "${options.name}"` : 'query'
  const specs = new Map<string, ParamSpec>()
  const addParam = (name: string, spec: ParamSpec) => {
    const seen = specs.get(name)
    if (!seen) {
      specs.set(name, spec)
      return
    }
    if (seen.clickhouseType !== spec.clickhouseType) {
      throw new Error(`${label}: param "${name}" is ${seen.clickhouseType} in one part and ${spec.clickhouseType} in another`)
    }
    if (seen.defaultValue !== spec.defaultValue) {
      throw new Error(
        `${label}: param "${name}" has different defaults (${seen.defaultValue ?? 'none'} and ${spec.defaultValue ?? 'none'})`,
      )
    }
    specs.set(name, { ...seen, schemas: [...new Set([...seen.schemas, ...spec.schemas])] })
  }

  const typeOf = (name: string, schema: z.ZodType): string => {
    try {
      return paramType(schema)
    } catch (error) {
      throw new Error(`${label}: param "${name}": ${error instanceof Error ? error.message : String(error)}`, { cause: error })
    }
  }

  const render = (value: unknown): string => {
    const parts = (typeof value === 'object' || typeof value === 'function') && value !== null ? paramSpecs.get(value) : undefined
    if (parts) {
      for (const [name, spec] of parts) addParam(name, spec)
      const inner = (value as QueryDefinition).sql
      return tokenizeSQL(inner).at(-1)?.kind === 'line_comment' ? `(${inner}\n)` : `(${inner})`
    }
    if (isObjectRef(value)) return `${quoteIdentifier(value.database)}.${quoteIdentifier(value.name)}`
    if (value instanceof z.ZodType) {
      const name = paramName(value)
      if (!name) throw new Error(`${label}: a param needs a name, e.g. p.string('city') or p('tags', schema)`)
      if (!PARAM_NAME.test(name)) throw new Error(`${label}: param name "${name}" must match ${PARAM_NAME.source}`)
      const type = typeOf(name, value)
      addParam(name, { schemas: [value], clickhouseType: type, defaultValue: paramDefault(value) })
      return `{${name}:${type}}`
    }
    throw new Error(`${label}: only p params, queries and chkit tables, views and dictionaries can be interpolated`)
  }

  const sql = values
    .reduce<string>((text, value, i) => text + render(value) + templateText(strings, i + 1), templateText(strings, 0))
    .trim()
  const params = z.object(
    Object.fromEntries([...specs].map(([name, spec]) => [name, spec.schemas.reduce((all, schema) => z.intersection(all, schema))])),
  )
  const version = options.version ?? 1
  const logComment = options.name ? { log_comment: JSON.stringify({ query: options.name, version }) } : {}

  const run = async (input: unknown = {}, callOptions: QueryCallOptions = {}) => {
    const parsed = params.parse(input)
    const client = callOptions.client ?? (await resolveClient?.())
    if (!client) throw new Error(`${label}: no client; bind one with createQuery(client) or pass { client }`)
    const result = await client.query({
      query: sql,
      format: 'JSONEachRow',
      query_params: Object.fromEntries(
        [...specs].map(([name, spec]) => [name, serializeParam(parsed[name] ?? null, spec.clickhouseType)]),
      ),
      clickhouse_settings: { ...logComment, ...callOptions.clickhouse_settings },
      query_id: callOptions.query_id,
      abort_signal: callOptions.abort_signal,
    })
    const rows = await result.json()
    return options.returns ? z.array(options.returns).parse(rows) : rows
  }
  Object.defineProperties(run, {
    name: { value: options.name, enumerable: true },
    version: { value: version, enumerable: true },
    sql: { value: sql, enumerable: true },
    params: { value: params, enumerable: true },
    returns: { value: () => run },
  })
  paramSpecs.set(run, specs)
  return Object.freeze(run) as unknown as Query
}

/**
 * Formats a param value for its ClickHouse type, because ClickHouse rejects a
 * trailing `Z` in a DateTime64 param and a fractional epoch in a DateTime one,
 * and @clickhouse/client's own Date formatting fails inside arrays and maps.
 * Dates and ISO strings become epoch seconds; an ISO string keeps all its
 * fraction digits, but a DateTime64 less than a second before the epoch throws,
 * because ClickHouse drops its sign. Array elements and Map values follow their
 * own type, and numeric Map keys stay unquoted. JSON values are sent as JSON text.
 */
function serializeParam(value: unknown, type: string): unknown {
  const wrapped =
    /^(?:Nullable|LowCardinality)\((.*)\)$/.exec(type)?.[1] ?? /^SimpleAggregateFunction\([^,]+,\s*(.*)\)$/.exec(type)?.[1]
  if (wrapped) return serializeParam(value, wrapped)
  if (type.startsWith('JSON')) return typeof value === 'string' ? value : JSON.stringify(value)
  if (Array.isArray(value)) return value.map((item) => serializeParam(item, /^Array\((.*)\)$/.exec(type)?.[1] ?? type))
  if (typeof value === 'object' && value !== null && !(value instanceof Date)) {
    const [keyType = '', valueType = type] = splitTopLevelComma(/^Map\((.*)\)$/.exec(type)?.[1] ?? '').map((part) => part.trim())
    const numeric = /^(?:LowCardinality\()?(U?Int|Float|Decimal)/.exec(keyType)?.[1]
    const key = (name: string) =>
      numeric === 'Float' ? Number(name) : numeric === 'Decimal' ? decimalKey(name) : numeric ? BigInt(name) : name
    return new Map(Object.entries(value).map(([name, item]) => [key(name), serializeParam(item, valueType)]))
  }
  if (!type.startsWith('DateTime')) return value instanceof Date ? value.toISOString().slice(0, 10) : value
  const time = epochParts(value)
  if (!time) return value
  if (!type.startsWith('DateTime64') || !time.fraction) return String(time.seconds)
  const scale = time.fraction.length
  const units = BigInt(time.seconds) * 10n ** BigInt(scale) + BigInt(time.fraction)
  if (units < 0n && units > -(10n ** BigInt(scale))) {
    throw new Error('ClickHouse reads a DateTime64 param less than a second before 1970-01-01 as after it')
  }
  const digits = (units < 0n ? -units : units).toString().padStart(scale + 1, '0')
  return `${units < 0n ? '-' : ''}${digits.slice(0, -scale)}.${digits.slice(-scale)}`
}

/**
 * A Decimal Map key as a number, which @clickhouse/client sends unquoted, as
 * long as the number keeps every digit; a quoted key fails to parse.
 */
function decimalKey(text: string): number {
  const value = Number(text)
  const plain = (digits: string) =>
    digits.replace(/^(-?)0+(?=\d)/, '$1').replace(/(\.\d*?)0+$/, '$1').replace(/\.$/, '').replace(/^-0$/, '0')
  if (plain(String(value)) !== plain(text)) throw new Error(`Decimal Map key ${text} can't be sent without losing digits`)
  return value
}

/** Whole epoch seconds and the fraction digits of a Date or an ISO datetime string. */
function epochParts(value: unknown): { seconds: number; fraction: string } | undefined {
  if (value instanceof Date) {
    const ms = value.getTime()
    return { seconds: Math.floor(ms / 1000), fraction: String(ms - Math.floor(ms / 1000) * 1000).padStart(3, '0') }
  }
  if (typeof value !== 'string' || !value.includes('T')) return undefined
  return { seconds: Date.parse(value.replace(/\.\d+/, '')) / 1000, fraction: /\.(\d+)/.exec(value)?.[1] ?? '' }
}

function isTemplate(value: TemplateStringsArray | QueryOptions<z.ZodType | undefined>): value is TemplateStringsArray {
  return Array.isArray(value) && 'raw' in value
}

function isObjectRef(value: unknown): value is QueryObjectRef {
  if (typeof value !== 'object' || value === null) return false
  const ref = value as Partial<QueryObjectRef>
  return OBJECT_KINDS.has(ref.kind) && typeof ref.database === 'string' && typeof ref.name === 'string'
}

/** Cooked template text, or the raw text where an invalid escape such as \d leaves it undefined. */
function templateText(strings: TemplateStringsArray, index: number): string {
  return strings[index] ?? strings.raw[index] ?? ''
}
