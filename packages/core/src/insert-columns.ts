import { renderIdentifier, unescapeQuoted } from './identifier.js'
import { findQuoteEnd } from './sql-scan.js'
import { splitTopLevelComma } from './key-clause.js'
import type { TableDefinition } from './model-types.js'

/**
 * The INSERT column list for `INSERT ... FORMAT JSONEachRow`, or `undefined`
 * for a table without EPHEMERAL columns. Without a list ClickHouse treats
 * EPHEMERAL keys as unknown fields and drops them, so the list names every
 * insertable column. Omitted keys still receive their defaults.
 *
 * A `Nested(...)` column is listed by its `name.field` subcolumns: with the
 * default `flatten_nested = 1` those are the table's real columns, and the
 * Nested name itself is rejected as an unknown column.
 */
export function insertColumnList(table: TableDefinition): string[] | undefined {
  if (!table.columns.some((column) => column.defaultKind === 'EPHEMERAL')) return undefined
  return table.columns
    .filter((column) => column.defaultKind !== 'MATERIALIZED' && column.defaultKind !== 'ALIAS')
    .flatMap((column) => {
      const fields = nestedFieldNames(column.type)
      return fields ? fields.map((field) => `${column.name}.${field}`) : [column.name]
    })
    .map(renderIdentifier)
}

function nestedFieldNames(type: string): string[] | undefined {
  const fields = /^Nested\s*\((.*)\)$/s.exec(type.trim())?.[1]
  return fields === undefined ? undefined : splitTopLevelComma(fields).map(nestedFieldName)
}

/** The leading name of a `name Type` field, unquoting a backticked or double-quoted name. */
function nestedFieldName(field: string): string {
  const quote = field.charAt(0)
  if (quote !== '`' && quote !== '"') return field.split(/\s/, 1)[0] ?? field
  return unescapeQuoted(field.slice(1, findQuoteEnd(field, 0, quote)), quote)
}
