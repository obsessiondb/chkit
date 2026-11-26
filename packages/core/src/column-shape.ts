import { literalDefaultFingerprint, parseColumnDefault, renderDefault } from './column-default.js'
import type { ColumnDefaultValue, ColumnDefinition } from './model.js'
import { columnCodecFingerprint, columnTypeFingerprint } from './sql.js'

export function normalizeColumn(
  column: ColumnDefinition
): Omit<ColumnDefinition, 'name' | 'renamedFrom' | 'nullable' | 'codec'> & { codec: string } {
  const { name: _name, renamedFrom: _renamedFrom, type: _type, nullable: _nullable, codec: _codec, ...rest } = column
  // Compare what the DSL renders: inline Nullable(T) and nullable: true are
  // equivalent, while an additional or differently placed wrapper is not.
  return {
    // ClickHouse stores `Decimal(10,2)` as `Decimal(10, 2)` (#466).
    type: columnTypeFingerprint(column),
    ...rest,
    ...(column.default === undefined ? {} : { default: defaultFingerprint(column.default) }),
    // Codecs compare in the form ClickHouse stores them, like drift (#465).
    codec: columnCodecFingerprint(column),
  }
}

// A literal compares by the SQL it renders, so the literal 7 and the
// expression '7' that pull reads back are the same default (#466). An
// expression keeps its comments, which the snapshot records as written.
function defaultFingerprint(value: ColumnDefaultValue): string {
  const parsed = parseColumnDefault(value)
  const sql = parsed.kind === 'expression' ? parsed.sql : renderDefault(value)
  return literalDefaultFingerprint(sql) ?? sql
}

export function shapeKey(value: unknown): string {
  return JSON.stringify(value, sortObjectKeys)
}

function sortObjectKeys(_key: string, value: unknown): unknown {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return value
  return Object.fromEntries(Object.entries(value).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
}
