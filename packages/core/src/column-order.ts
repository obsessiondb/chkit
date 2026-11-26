import { type ColumnStatementDefinitions, cycleReleases, repairedOrder } from './column-cycle-repair.js'
import { type ColumnRename, columnDefaultReads, columnKey, columnRenameKey, tableTtlReads } from './column-reads.js'
import type { MigrationOperation } from './model.js'
import { compareCodePoints } from './order.js'

// The table TTL statement (MODIFY or REMOVE TTL) sorts with the column
// statements: it reads columns that are added and dropped (#769).
const COLUMN_STATEMENTS: ReadonlySet<MigrationOperation['type']> = new Set([
  'alter_table_add_column',
  'alter_table_modify_column',
  'alter_table_drop_column',
  'alter_table_rename_column',
  'alter_table_modify_ttl',
])

export function isColumnStatement(op: MigrationOperation): boolean {
  return COLUMN_STATEMENTS.has(op.type)
}

/**
 * Orders the column statements (ADD, MODIFY, DROP and RENAME COLUMN) and the
 * table TTL statement of every table in one dependency sort, from their key
 * order (#681, #745, #746, #758, #769, #775):
 * - an ADD or MODIFY whose new DEFAULT, MATERIALIZED or ALIAS expression, or
 *   a table TTL that reads column X runs after the ADD of X or the RENAME to X;
 * - a DROP of X runs after the MODIFY or DROP of every column whose old
 *   expression reads X, and after the TTL change when the old TTL reads X,
 *   since ClickHouse refuses to drop a column something still reads. A RENAME
 *   away from X needs no such wait: ClickHouse rewrites the expressions and
 *   the TTL that read X to the new name;
 * - a MODIFY whose new expression would close a cycle with an old expression
 *   runs after the MODIFY that removes that old read (`cycleReleases`);
 * - when the order still closes a cycle in a table whose reads are certain
 *   (`repairedOrder`), the first breaker in key order runs before the
 *   MODIFY that closes it (`breakClosedCycles`, #775);
 * - statements of the same column keep their order.
 * Members of a cycle keep their key order. The statements fill the positions
 * the column statements had, so every other operation keeps its place, and a
 * table's statements never move past another table's (they share no edge).
 * `renames` names the columns of each RENAME COLUMN in `operations`.
 */
export function orderColumnStatements(
  operations: MigrationOperation[],
  definitions: ColumnStatementDefinitions,
  renames: readonly ColumnRename[]
): MigrationOperation[] {
  const reads = columnDefaultReads(definitions.next)
  const oldReads = columnDefaultReads(definitions.previous)
  // ALTER's check for cyclic defaults also reads lambda parameters (#799).
  const cycleReads = columnDefaultReads(definitions.next, true)
  const oldCycleReads = columnDefaultReads(definitions.previous, true)
  const ttlReads = tableTtlReads(definitions.next)
  const oldTtlReads = tableTtlReads(definitions.previous)
  const renamedTo = new Map(renames.map((rename) => [columnRenameKey(rename), columnKey(rename, rename.to)]))
  const statements = operations
    .filter(isColumnStatement)
    .sort((a, b) => compareCodePoints(a.key, b.key))

  const providers = new Map<string, number[]>()
  const releasers = new Map<string, number[]>()
  const modifies = new Map<string, number[]>()
  const append = (map: Map<string, number[]>, key: string, index: number) =>
    map.set(key, [...(map.get(key) ?? []), index])
  statements.forEach((op, index) => {
    if (op.type === 'alter_table_add_column') append(providers, op.key, index)
    const renamed = renamedTo.get(op.key)
    if (op.type === 'alter_table_rename_column' && renamed !== undefined) append(providers, renamed, index)
    if (op.type === 'alter_table_modify_column') append(modifies, op.key, index)
    if (op.type === 'alter_table_modify_column' || op.type === 'alter_table_drop_column') {
      for (const read of oldReads.get(op.key) ?? []) append(releasers, read, index)
    }
    if (op.type === 'alter_table_modify_ttl') {
      for (const read of oldTtlReads.get(op.key) ?? []) append(releasers, read, index)
    }
  })

  const added = new Set(statements.filter((op) => op.type === 'alter_table_add_column').map((op) => op.key))
  const releases = cycleReleases(cycleReads, oldCycleReads, added, new Set(modifies.keys()))
  const prerequisites = statements.map((op, index) => {
    const found = new Set<number>()
    if (op.type === 'alter_table_add_column' || op.type === 'alter_table_modify_column') {
      for (const read of reads.get(op.key) ?? []) for (const other of providers.get(read) ?? []) found.add(other)
    }
    if (op.type === 'alter_table_modify_ttl') {
      for (const read of ttlReads.get(op.key) ?? []) for (const other of providers.get(read) ?? []) found.add(other)
    }
    if (op.type === 'alter_table_drop_column') {
      for (const other of releasers.get(op.key) ?? []) found.add(other)
    }
    // A column's last statement is the MODIFY COLUMN that sets its new expression.
    if (op.type === 'alter_table_modify_column' && statements[index + 1]?.key !== op.key) {
      for (const column of releases.get(op.key) ?? []) {
        for (const other of modifies.get(column) ?? []) found.add(other)
      }
    }
    if (index > 0 && statements[index - 1]?.key === op.key) found.add(index - 1)
    found.delete(index)
    return [...found]
  })

  const ordered = repairedOrder(prerequisites, statements, definitions, renames)
  let next = 0
  return operations.map((op) => (isColumnStatement(op) ? (statements[ordered[next++] ?? -1] ?? op) : op))
}
