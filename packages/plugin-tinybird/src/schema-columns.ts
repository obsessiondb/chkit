/**
 * The SCHEMA block of a datasource, parsed with the grammar of the Tinybird
 * CLI (`parse_table_structure` in `tinybird/datafile/common.py`):
 * `name [type] [`json:path`] [DEFAULT expr] [CODEC(...)]`, comma-separated.
 * Tinybird rejects MATERIALIZED, ALIAS, column TTL, NULL and NOT NULL, so a
 * project that builds has none of them.
 */

export interface TinybirdColumn {
  name: string
  /** The type as Tinybird sends it to ClickHouse (`wrap_nullable` applied). */
  type: string
  /** The DEFAULT expression, without the keyword. */
  default?: string
  /** The codec list, e.g. `ZSTD(3)` or `Delta(8), ZSTD(1)`, without `CODEC(...)`. */
  codec?: string
  jsonPath?: string
}

export class SchemaSyntaxError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'SchemaSyntaxError'
  }
}

const NAME_CHARS = /[A-Za-z0-9_]/
const LOOKAHEAD = {
  NULL: /^\s+NULL(?:[^a-z0-9_]|$)/i,
  NOTNULL: /^\s+NOT\s+NULL(?:[^a-z0-9_]|$)/i,
  DEFAULT: /^\s+DEFAULT(?:[^a-z0-9_]|$)/i,
  MATERIALIZED: /^\s+MATERIALIZED(?:[^a-z0-9_]|$)/i,
  ALIAS: /^\s+ALIAS(?:[^a-z0-9_]|$)/i,
  CODEC: /^\s+CODEC(?:[^a-z0-9_]|$)/i,
  TTL: /^\s+TTL(?:[^a-z0-9_]|$)/i,
  JSONPATH: /^\s+`json:/i,
  COMMA: /^,/,
} as const
type Lookahead = keyof typeof LOOKAHEAD
// What ends an expression, per attribute, as in the Tinybird parser: a DEFAULT may contain NULL.
const TYPE_STOPS: Lookahead[] = ['NULL', 'NOTNULL', 'DEFAULT', 'MATERIALIZED', 'ALIAS', 'CODEC', 'TTL', 'JSONPATH', 'COMMA']
const VALUE_STOPS: Lookahead[] = ['NOTNULL', 'DEFAULT', 'MATERIALIZED', 'ALIAS', 'CODEC', 'TTL', 'JSONPATH', 'COMMA']
const SIMPLE_AGGREGATE = /SimpleAggregateFunction\((\w+),\s*(?!(?:Nullable))([\w,.()]+)\)/

export function parseSchemaColumns(schema: string): TinybirdColumn[] {
  const columns: TinybirdColumn[] = []
  let i = 0
  let column: { name: string; type: string; default?: string; codec?: string; jsonPath?: string } | undefined

  const rest = () => schema.slice(i)
  const matches = (key: Lookahead) => LOOKAHEAD[key].exec(rest())
  const skipWhitespace = () => {
    while (i < schema.length && /\s/.test(schema[i] ?? '')) i++
  }
  const finish = () => {
    if (!column) return
    if (!column.name || !column.type) {
      throw new SchemaSyntaxError(`column "${column.name}" needs a type (a DEFAULT without a type is not supported)`)
    }
    columns.push(normalizeColumn(column))
    column = undefined
  }
  const expression = (attribute: string, stops: Lookahead[]): string => {
    const begin = i
    const stack: string[] = []
    while (i < schema.length) {
      const char = schema[i] ?? ''
      const context = stack.at(-1)
      if ((context === "'" && char === "'") || (context === '"' && char === '"') || (context === '(' && char === ')')) {
        stack.pop()
      } else if ((char === "'" || char === '"' || char === '(') && context !== "'" && context !== '"') {
        stack.push(char)
      } else if (context === undefined && stops.some((key) => matches(key))) {
        break
      }
      i++
    }
    if (stack.length > 0) throw new SchemaSyntaxError(`unclosed ${stack.at(-1)} in ${attribute}`)
    const value = schema.slice(begin, i).trim()
    if (!value) throw new SchemaSyntaxError(`missing value for ${attribute}`)
    return value
  }

  while (i < schema.length) {
    if (!column) {
      skipWhitespace()
      if (i >= schema.length) break
      column = { name: parseName(), type: '' }
      if (column.name === 'INDEX') throw new SchemaSyntaxError('INDEX belongs in the INDEXES block, not in SCHEMA')
      continue
    }
    if (/^\s*$/.test(rest())) break
    for (const forbidden of ['NULL', 'NOTNULL', 'MATERIALIZED', 'ALIAS', 'TTL'] as const) {
      if (matches(forbidden)) throw new SchemaSyntaxError(`${forbidden} is not supported in Tinybird schemas`)
    }
    const defaultMatch = matches('DEFAULT')
    if (defaultMatch) {
      i += defaultMatch[0].length - (/[^a-z0-9_]$/i.test(defaultMatch[0]) ? 1 : 0)
      column.default = expression('DEFAULT', VALUE_STOPS)
      continue
    }
    const codecMatch = matches('CODEC')
    if (codecMatch) {
      i += codecMatch[0].length - (/[^a-z0-9_]$/i.test(codecMatch[0]) ? 1 : 0)
      const codec = expression('CODEC', VALUE_STOPS)
      column.codec = codec.replace(/^\(\s*/, '').replace(/\s*\)$/, '')
      continue
    }
    const jsonMatch = matches('JSONPATH')
    if (jsonMatch) {
      i += jsonMatch[0].length
      const end = schema.indexOf('`', i)
      if (end < 0) throw new SchemaSyntaxError('expected a closing backtick after `json:')
      column.jsonPath = schema.slice(i, end)
      i = end + 1
      continue
    }
    if (matches('COMMA')) {
      i++
      finish()
      continue
    }
    skipWhitespace()
    column.type = expression('TYPE', TYPE_STOPS)
  }
  finish()
  return columns

  function parseName(): string {
    if (schema[i] === '`') {
      const end = schema.indexOf('`', i + 1)
      if (end < 0) throw new SchemaSyntaxError('expected a closing backtick')
      const name = schema.slice(i + 1, end)
      i = end + 1
      return name
    }
    const begin = i
    while (i < schema.length && !/\s/.test(schema[i] ?? '')) {
      if (!NAME_CHARS.test(schema[i] ?? '')) {
        throw new SchemaSyntaxError(`column name contains invalid character ${JSON.stringify(schema[i])}; use backticks`)
      }
      i++
    }
    return schema.slice(begin, i)
  }
}

/** Tinybird's column normalisation: `Nullable(...)` handling and `DEFAULT NULL` on nullable columns. */
function normalizeColumn(column: { name: string; type: string; default?: string; codec?: string; jsonPath?: string }): TinybirdColumn {
  const nullable = column.type.toLowerCase().startsWith('nullable')
  const inner = nullable ? column.type.slice('Nullable('.length, -1) : column.type
  const defaultValue = nullable && column.default?.toLowerCase() === 'null' ? undefined : column.default
  return {
    name: column.name,
    type: nullable ? wrapNullable(inner) : inner,
    ...(defaultValue !== undefined ? { default: defaultValue } : {}),
    ...(column.codec ? { codec: column.codec } : {}),
    ...(column.jsonPath ? { jsonPath: column.jsonPath } : {}),
  }
}

/** Tinybird's `wrap_nullable`, including its SimpleAggregateFunction workaround (ClickHouse#34407). */
function wrapNullable(type: string): string {
  const match = SIMPLE_AGGREGATE.exec(type)
  if (match && !(match[2] ?? '').includes('Nullable(')) return `SimpleAggregateFunction(${match[1]}, Nullable(${match[2]}))`
  return type.includes('Nullable(') ? type : `Nullable(${type})`
}
