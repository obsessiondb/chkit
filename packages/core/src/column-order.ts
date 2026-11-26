import { type ColumnStatementDefinitions, cycleReleases, repairedOrder } from './column-cycle-repair.js'
import {
  type ColumnRename,
  columnDefaultReads,
  columnKey,
  columnObjectId,
  columnRenameKey,
  renameObjectId,
  tableTtlReads,
  ttlObjectId,
} from './column-reads.js'
import { quoteIdentifier, renderQualifiedName } from './identifier.js'
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
  const reads = columnDefaultReads(definitions.next, false, columnObjectId)
  const oldReads = columnDefaultReads(definitions.previous, false, columnObjectId)
  // ALTER's check for cyclic defaults also reads lambda parameters (#799).
  const cycleReads = columnDefaultReads(definitions.next, true, columnObjectId)
  const oldCycleReads = columnDefaultReads(definitions.previous, true, columnObjectId)
  const ttlReads = tableTtlReads(definitions.next)
  const oldTtlReads = tableTtlReads(definitions.previous)
  const renamedTo = new Map(renames.map((rename) => [renameObjectId(rename), columnObjectId(rename.database, rename.table, rename.to)]))
  const statements = operations
    .filter(isColumnStatement)
    .sort((a, b) => compareCodePoints(a.key, b.key))
  const ids = statementObjectIds(statements, definitions, renames)
  // The statements of one object (`ids`) are next to each other in key order.
  const lastOf = new Map<string, number>()
  const previousOf = ids.map((id, index) => {
    const before = lastOf.get(id)
    lastOf.set(id, index)
    return before
  })

  const providers = new Map<string, number[]>()
  const releasers = new Map<string, number[]>()
  const modifies = new Map<string, number[]>()
  const append = (map: Map<string, number[]>, key: string, index: number) =>
    map.set(key, [...(map.get(key) ?? []), index])
  statements.forEach((op, index) => {
    const id = ids[index] ?? ''
    if (op.type === 'alter_table_add_column') append(providers, id, index)
    const renamed = renamedTo.get(id)
    if (op.type === 'alter_table_rename_column' && renamed !== undefined) append(providers, renamed, index)
    if (op.type === 'alter_table_modify_column') append(modifies, id, index)
    if (op.type === 'alter_table_modify_column' || op.type === 'alter_table_drop_column') {
      for (const read of oldReads.get(id) ?? []) append(releasers, read, index)
    }
    if (op.type === 'alter_table_modify_ttl') {
      for (const read of oldTtlReads.get(id) ?? []) append(releasers, read, index)
    }
  })

  const added = new Set(ids.filter((_, index) => statements[index]?.type === 'alter_table_add_column'))
  const releases = cycleReleases(cycleReads, oldCycleReads, added, new Set(modifies.keys()))
  const prerequisites = statements.map((op, index) => {
    const id = ids[index] ?? ''
    const found = new Set<number>()
    if (op.type === 'alter_table_add_column' || op.type === 'alter_table_modify_column') {
      for (const read of reads.get(id) ?? []) for (const other of providers.get(read) ?? []) found.add(other)
    }
    if (op.type === 'alter_table_modify_ttl') {
      for (const read of ttlReads.get(id) ?? []) for (const other of providers.get(read) ?? []) found.add(other)
    }
    if (op.type === 'alter_table_drop_column') {
      for (const other of releasers.get(id) ?? []) found.add(other)
    }
    // A column's last statement is the MODIFY COLUMN that sets its new expression.
    if (op.type === 'alter_table_modify_column' && lastOf.get(id) === index) {
      for (const column of releases.get(id) ?? []) {
        for (const other of modifies.get(column) ?? []) found.add(other)
      }
    }
    const before = previousOf[index]
    if (before !== undefined) found.add(before)
    found.delete(index)
    return [...found]
  })

  const ordered = repairedOrder(prerequisites, statements, definitions, renames)
  let next = 0
  return operations.map((op) => (isColumnStatement(op) ? (statements[ordered[next++] ?? -1] ?? op) : op))
}

/**
 * The id of the object each column statement changes (#801). A key that
 * names one object of `definitions` or `renames` is that object's. A key
 * that names several (keys of two tables can be the same) is the one whose
 * table the statement's SQL alters, and for a RENAME COLUMN whose SQL it
 * is. A statement that is still not one object's keeps its key as its id,
 * so it reads and provides nothing.
 */
function statementObjectIds(
  statements: MigrationOperation[],
  definitions: ColumnStatementDefinitions,
  renames: readonly ColumnRename[]
): string[] {
  type Candidate = { id: string; matches: (sql: string) => boolean }
  const candidates = new Map<string, Candidate[]>()
  const add = (kind: string, key: string, candidate: Candidate) => {
    const slot = JSON.stringify([kind, key])
    const list = candidates.get(slot) ?? []
    if (!list.some((other) => other.id === candidate.id)) list.push(candidate)
    candidates.set(slot, list)
  }
  for (const def of [...definitions.previous, ...definitions.next]) {
    if (def.kind !== 'table') continue
    const prefix = `ALTER TABLE ${renderQualifiedName(def.database, def.name)} `
    const matches = (sql: string) => sql.startsWith(prefix)
    for (const column of def.columns) {
      add('column', columnKey({ database: def.database, table: def.name }, column.name), {
        id: columnObjectId(def.database, def.name, column.name),
        matches,
      })
    }
    add('ttl', `table:${def.database}.${def.name}:ttl`, { id: ttlObjectId(def.database, def.name), matches })
  }
  for (const rename of renames) {
    const sql = `ALTER TABLE ${renderQualifiedName(rename.database, rename.table)} RENAME COLUMN IF EXISTS ${quoteIdentifier(rename.from)} TO ${quoteIdentifier(rename.to)};`
    add('rename', columnRenameKey(rename), { id: renameObjectId(rename), matches: (other) => other === sql })
  }
  const kindOf = (op: MigrationOperation) =>
    op.type === 'alter_table_modify_ttl' ? 'ttl' : op.type === 'alter_table_rename_column' ? 'rename' : 'column'
  return statements.map((op) => {
    const slot = JSON.stringify([kindOf(op), op.key])
    const found = candidates.get(slot) ?? []
    const matching = found.length === 1 ? found : found.filter((candidate) => candidate.matches(op.sql))
    return matching.length === 1 && matching[0] !== undefined ? matching[0].id : slot
  })
}
