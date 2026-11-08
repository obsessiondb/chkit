import { z } from 'zod'

import { quoteIdentifier } from './identifier.js'
import type { DictionaryDefinition, MaterializedViewDefinition, TableDefinition, ViewDefinition } from './model-types.js'
import { clickhouseType, type NamedParam, paramDefault, paramName } from './query-param.js'

export interface QueryOptions {
  /** Names the query in `system.query_log` through `log_comment`. */
  name?: string
  /** Defaults to 1. */
  version?: number
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

/** A chkit table, view, materialized view or dictionary. */
export type QueryObjectRef = Pick<
  TableDefinition | ViewDefinition | MaterializedViewDefinition | DictionaryDefinition,
  'kind' | 'database' | 'name'
>

/** What a query template accepts: named params, queries and chkit objects. */
export type QueryInterpolation = NamedSchema | QueryDefinition | QueryObjectRef

type QueryTemplate = <const V extends readonly QueryInterpolation[]>(
  strings: TemplateStringsArray,
  ...values: V
) => QueryDefinition<ParamsShape<V>>

export interface QueryTag extends QueryTemplate {
  (options: QueryOptions): QueryTemplate
}

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

interface ParamSpec {
  readonly schemas: readonly z.ZodType[]
  readonly clickhouseType: string
  readonly defaultValue: string | undefined
}

const PARAM_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/
const OBJECT_KINDS = new Set<unknown>(['table', 'view', 'materialized_view', 'dictionary'])
const paramSpecs = new WeakMap<object, ReadonlyMap<string, ParamSpec>>()

/**
 * Defines a query from a tagged template, with options first when needed:
 * query({ name: 'top_cities' })`SELECT ...`. Params are named with `p`;
 * interpolated queries become subqueries and their params merge by name.
 */
export const query = ((first: TemplateStringsArray | QueryOptions, ...values: unknown[]) => {
  if (isTemplate(first)) return defineQuery(first, values, {})
  return (strings: TemplateStringsArray, ...templateValues: unknown[]) => defineQuery(strings, templateValues, first)
}) as QueryTag

function defineQuery(strings: TemplateStringsArray, values: readonly unknown[], options: QueryOptions): QueryDefinition {
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

  const render = (value: unknown): string => {
    const parts = typeof value === 'object' && value !== null ? paramSpecs.get(value) : undefined
    if (parts) {
      for (const [name, spec] of parts) addParam(name, spec)
      return `(${(value as QueryDefinition).sql})`
    }
    if (isObjectRef(value)) return `${quoteIdentifier(value.database)}.${quoteIdentifier(value.name)}`
    if (value instanceof z.ZodType) {
      const name = paramName(value)
      if (!name) throw new Error(`${label}: a param needs a name, e.g. p.string('city') or p('tags', schema)`)
      if (!PARAM_NAME.test(name)) throw new Error(`${label}: param name "${name}" must match ${PARAM_NAME.source}`)
      const type = clickhouseType(value)
      addParam(name, { schemas: [value], clickhouseType: type, defaultValue: paramDefault(value) })
      return `{${name}:${type}}`
    }
    throw new Error(`${label}: only p params, queries and chkit tables, views and dictionaries can be interpolated`)
  }

  const sql = values
    .reduce<string>((text, value, i) => text + render(value) + templateText(strings, i + 1), templateText(strings, 0))
    .trim()
  const params = z.object(
    Object.fromEntries(
      [...specs].map(([name, spec]) => [name, spec.schemas.reduce((all, schema) => z.intersection(all, schema))]),
    ),
  )
  const definition: QueryDefinition = Object.freeze({ name: options.name, version: options.version ?? 1, sql, params })
  paramSpecs.set(definition, specs)
  return definition
}

function isTemplate(value: TemplateStringsArray | QueryOptions): value is TemplateStringsArray {
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
