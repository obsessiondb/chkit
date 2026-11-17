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
import { definitionKey } from './canonical.js'
import { quoteIdentifier, renderQualifiedName } from './identifier.js'
import type { MigrationOperation, SchemaDefinition, TableDefinition } from './model.js'
import { buildDependencyGraph, type DependencyGraph, orderByDependencies } from './object-dependencies.js'
import { compareCodePoints } from './order.js'
import { columnTypeFingerprint } from './sql.js'

// The table TTL statement (MODIFY or REMOVE TTL) sorts with the column
// statements: it reads columns that are added and dropped (#769).
const COLUMN_STATEMENTS: ReadonlySet<MigrationOperation['type']> = new Set([
  'alter_table_add_column',
  'alter_table_modify_column',
  'alter_table_drop_column',
  'alter_table_rename_column',
  'alter_table_modify_ttl',
  'alter_materialized_view_modify_query',
])

export function isColumnStatement(op: MigrationOperation): boolean {
  return COLUMN_STATEMENTS.has(op.type)
}

/**
 * Orders the column statements (ADD, MODIFY, DROP and RENAME COLUMN) and the
 * table TTL statement of every table, and the MODIFY QUERY of every
 * materialized view, in one dependency sort, from their key order (#681,
 * #745, #746, #758, #760, #769, #775):
 * - an ADD or MODIFY whose new DEFAULT, MATERIALIZED or ALIAS expression, or
 *   a table TTL that reads column X runs after the ADD of X or the RENAME to X;
 * - a DROP of X runs after the MODIFY or DROP of every column whose old
 *   expression reads X, and after the TTL change when the old TTL reads X,
 *   since ClickHouse refuses to drop a column something still reads. A RENAME
 *   away from X needs no such wait: ClickHouse rewrites the expressions and
 *   the TTL that read X to the new name;
 * - a MODIFY whose new expression would close a cycle with an old expression
 *   runs after the MODIFY that removes that old read (`cycleReleases`);
 * - a MODIFY that changes the type of X runs after the statements that stop
 *   reading X, and before those that start reading it (`addTypeChangeOrder`, #814);
 * - when the order still closes a cycle in a table whose reads are certain
 *   (`repairedOrder`), the first breaker in key order runs before the
 *   MODIFY that closes it (`breakClosedCycles`, #775);
 * - a MODIFY QUERY runs after the ADD, MODIFY and RENAME of every column of the
 *   tables its new query reads or writes, since ClickHouse analyzes the new
 *   query, and before the DROP of a column of a table its old query reads or
 *   writes, since ClickHouse refuses to drop a column a view still reads;
 * - statements of the same column keep their order.
 * Members of a cycle keep their key order. The statements fill the positions
 * the column statements had, so every other operation keeps its place, and a
 * table's statements move past another table's only through a MODIFY QUERY
 * that reads both (they share no other edge).
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
  const queryReads = materializedViewQueryReads(definitions.next)
  const oldQueryReads = materializedViewQueryReads(definitions.previous)
  const changesColumnOf = (op: MigrationOperation, tables: ReadonlySet<string> | undefined) =>
    [...(tables ?? [])].some((table) => op.key.startsWith(`${table}:column:`) || op.key.startsWith(`${table}:column_rename:`))
  const statements = operations
    .filter(isColumnStatement)
    .sort((a, b) => compareCodePoints(a.key, b.key))
  const queries = statements.flatMap((op, index) => (op.type === 'alter_materialized_view_modify_query' ? [index] : []))
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
      for (const query of queries) if (changesColumnOf(op, oldQueryReads.get(statements[query]?.key ?? ''))) found.add(query)
    }
    if (op.type === 'alter_materialized_view_modify_query') {
      statements.forEach((other, otherIndex) => {
        if (other.type !== 'alter_table_drop_column' && changesColumnOf(other, queryReads.get(op.key))) found.add(otherIndex)
      })
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
  addTypeChangeOrder(prerequisites, statements, ids, operations, modifies, definitions, renames, {
    reads,
    oldReads,
    ttlReads,
    oldTtlReads,
    cycleReads,
    oldCycleReads,
  })

  const ordered = repairedOrder(prerequisites, statements, definitions, renames)
  let next = 0
  return operations.map((op) => (isColumnStatement(op) ? (statements[ordered[next++] ?? -1] ?? op) : op))
}

/** MODIFY QUERY operation key → keys of the definitions the view reads, its target included. */
function materializedViewQueryReads(definitions: SchemaDefinition[]): DependencyGraph {
  const graph = buildDependencyGraph(definitions)
  return new Map(
    definitions
      .filter((def) => def.kind === 'materialized_view')
      .map((def) => [`${definitionKey(def)}:query`, graph.get(definitionKey(def)) ?? new Set<string>()])
  )
}

/**
 * Adds the prerequisites that order the MODIFY changing the type of a column
 * X against the statements whose expressions read X (#814). ClickHouse checks
 * every expression of the table against the new type, and a new expression
 * against the current one (code 43): `MODIFY COLUMN a UInt64` fails while
 * `b DEFAULT length(a)` stands, and `b DEFAULT a + 1` fails while `a` is
 * still a String. So the MODIFY of X runs after the ADD, MODIFY or DROP of
 * every column, and the TTL change, whose old expression reads X and whose
 * new one doesn't, and before every statement whose new expression reads X
 * and whose old one doesn't. They can't tell which types an expression
 * accepts, so the rest keeps the order of the sort without them (`base`): a
 * statement whose old and new expressions both read X keeps its side of the
 * MODIFY of X (no order helps when both need their own type of X), and the
 * type changes keep their order among themselves (a third expression can read
 * two of them). A prerequisite that would close a cycle is left out, and
 * those the base order satisfies go in first, so a conflict keeps that order.
 * None are added when the base order already satisfies them all, when their
 * order moves a statement past an operation of `operations` that is not a
 * column statement, changes the order of the ADD and DROP COLUMNs among
 * themselves or of the type changes, or closes a cycle of column expressions
 * at some statement (`closesExpressionCycle`), when an ADD or MODIFY COLUMN
 * is not one column's (`ids`, #801), or when a table has a RENAME COLUMN in
 * `renames`. Statements, reads and type changes are matched by object id, so
 * two tables whose operation keys are the same keep their own. The cycle repair
 * (`repairedOrder`) runs after this, and its breaker edges come on top of
 * these prerequisites, so they hold in its order too. A temporary cycle the
 * repair would break also closes in the order with them, in any table, so in
 * practice that plan keeps none of them.
 */
function addTypeChangeOrder(
  prerequisites: number[][],
  statements: MigrationOperation[],
  ids: readonly string[],
  operations: MigrationOperation[],
  modifies: ReadonlyMap<string, number[]>,
  definitions: ColumnStatementDefinitions,
  renames: readonly ColumnRename[],
  graphs: {
    reads: DependencyGraph
    oldReads: DependencyGraph
    ttlReads: DependencyGraph
    oldTtlReads: DependencyGraph
    cycleReads: DependencyGraph
    oldCycleReads: DependencyGraph
  }
): void {
  const changes = new Map<string, number>()
  // The type changes of each table, in key order.
  const tables = typeChangedColumns(definitions, renames).map((columns) =>
    columns.flatMap((id) => {
      const change = modifies.get(id)?.at(-1)
      if (change !== undefined) changes.set(id, change)
      return change ?? []
    })
  )
  if (changes.size === 0 || hasUnresolvedColumnStatement(statements, ids, definitions)) return
  // [statement, prerequisite] pairs, and the [statement, MODIFY] pairs that read X before and after.
  const edges: Array<[number, number]> = []
  const kept: Array<[number, number]> = []
  statements.forEach((op, index) => {
    if (op.type === 'alter_table_rename_column') return
    const ttl = op.type === 'alter_table_modify_ttl'
    const id = ids[index] ?? ''
    const before = (ttl ? graphs.oldTtlReads : graphs.oldReads).get(id) ?? new Set<string>()
    const after = (ttl ? graphs.ttlReads : graphs.reads).get(id) ?? new Set<string>()
    for (const read of new Set([...before, ...after])) {
      const change = changes.get(read)
      if (change === undefined) continue
      if (before.has(read) && after.has(read)) kept.push([index, change])
      else edges.push(before.has(read) ? [change, index] : [index, change])
    }
  })
  const sortAll = () =>
    orderByDependencies(
      prerequisites.map((_, index) => index),
      String,
      (key) => (prerequisites[Number(key)] ?? []).map(String)
    )
  const base = sortAll()
  const position = new Map(base.map((index, at) => [index, at]))
  const at = (index: number) => position.get(index) ?? 0
  const satisfied = (edge: [number, number]) => at(edge[1]) < at(edge[0])
  if (edges.every(satisfied)) return
  const lengths = prerequisites.map((before) => before.length)
  // The base order satisfies these, so they close no cycle.
  for (const [one, other] of kept) {
    const [first, second] = at(one) < at(other) ? [one, other] : [other, one]
    if (first !== second) prerequisites[second]?.push(first)
  }
  // Waits on `target` through prerequisites, searched without recursion.
  const waitsOn = (from: number, target: number): boolean => {
    const seen = new Set([from])
    const pending = [from]
    for (let index = pending.pop(); index !== undefined; index = pending.pop()) {
      if (index === target) return true
      for (const other of prerequisites[index] ?? []) {
        if (!seen.has(other)) {
          seen.add(other)
          pending.push(other)
        }
      }
    }
    return false
  }
  // A prerequisite that comes first in `sorted`, a topological order of the
  // prerequisites so far, closes no cycle and keeps that order valid. A sort
  // with a cycle is no such order.
  const topological = (list: number[]): Map<number, number> | undefined => {
    const at = new Map(list.map((index, at) => [index, at]))
    const valid = prerequisites.every((before, index) => before.every((other) => (at.get(other) ?? 0) < (at.get(index) ?? 0)))
    return valid ? at : undefined
  }
  let sorted = topological(base)
  const add = ([index, other]: [number, number]) => {
    const certain = sorted !== undefined && (sorted.get(other) ?? 0) < (sorted.get(index) ?? 0)
    if (!certain && waitsOn(other, index)) return
    prerequisites[index]?.push(other)
    if (!certain) sorted = undefined
  }
  edges.sort((a, b) => Number(satisfied(b)) - Number(satisfied(a)) || a[0] - b[0] || a[1] - b[1])
  for (const edge of edges) add(edge)
  // Last, each table's type changes keep their base order where the edges allow.
  sorted = topological(sortAll())
  for (const table of tables) {
    const changed = [...table].sort((a, b) => at(a) - at(b))
    for (let i = 1; i < changed.length; i += 1) add([changed[i] ?? 0, changed[i - 1] ?? 0])
  }
  const order = sortAll()
  // An ADD COLUMN appends the column, a DROP can remove the column an ADD
  // replaces (the last physical one, or `k.x` before `k`), and a third
  // expression can read two changed columns: so the ADDs and DROPs, and the
  // type changes, keep their order.
  const types = new Set(changes.values())
  const addOrDrop = (index: number) =>
    statements[index]?.type === 'alter_table_add_column' || statements[index]?.type === 'alter_table_drop_column'
  const fixed = (list: number[]) =>
    [list.filter(addOrDrop).join(), list.filter((index) => types.has(index)).join()].join(';')
  // The statements fill the column statement slots of `operations` in order:
  // each must stay in the run of slots between the same other operations.
  const runs: number[] = []
  let run = 0
  let previousIsColumn = false
  for (const op of operations) {
    if (isColumnStatement(op)) runs.push(run)
    else if (previousIsColumn) run += 1
    previousIsColumn = isColumnStatement(op)
  }
  const moved = order.some((index, slot) => runs[slot] !== runs[at(index)])
  // ALTER's check for cyclic defaults also reads lambda parameters (#799).
  const cycles = { reads: graphs.cycleReads, oldReads: graphs.oldCycleReads }
  if (moved || fixed(order) !== fixed(base) || closesExpressionCycle(order, statements, ids, cycles)) {
    prerequisites.forEach((before, index) => {
      before.length = lengths[index] ?? before.length
    })
  }
}

/**
 * Whether an ADD or MODIFY COLUMN has no column's id (`statementObjectIds`
 * left its key, #801): its new expression would not be replayed in
 * `closesExpressionCycle`, which then could see fewer reads than ClickHouse.
 */
function hasUnresolvedColumnStatement(
  statements: MigrationOperation[],
  ids: readonly string[],
  definitions: ColumnStatementDefinitions
): boolean {
  const columns = new Set<string>()
  for (const def of [...definitions.previous, ...definitions.next]) {
    if (def.kind !== 'table') continue
    for (const column of def.columns) columns.add(columnObjectId(def.database, def.name, column.name))
  }
  return statements.some(
    (op, index) =>
      (op.type === 'alter_table_add_column' || op.type === 'alter_table_modify_column') && !columns.has(ids[index] ?? '')
  )
}

/**
 * Whether running the column statements in `order` gives some column an
 * expression that reads itself through the others at that point, which
 * ClickHouse rejects (`Cyclic alias detected`). It starts from the old
 * expressions, takes a column's new expression at its last statement and
 * drops a column at its DROP. A REMOVE before the last statement is not
 * replayed, so this sees more reads than ClickHouse, never fewer.
 */
function closesExpressionCycle(
  order: number[],
  statements: MigrationOperation[],
  ids: readonly string[],
  graphs: { reads: DependencyGraph; oldReads: DependencyGraph }
): boolean {
  const current = new Map<string, ReadonlySet<string>>(graphs.oldReads)
  const last = new Map(ids.map((id, index) => [id, index]))
  for (const index of order) {
    const op = statements[index]
    const id = ids[index]
    if (op === undefined || id === undefined) continue
    if (op.type === 'alter_table_drop_column') current.delete(id)
    if (op.type !== 'alter_table_add_column' && op.type !== 'alter_table_modify_column') continue
    // An object's new expression is set at its last statement.
    if (last.get(id) !== index) continue
    current.set(id, graphs.reads.get(id) ?? new Set<string>())
    const seen = new Set<string>()
    const pending = [...(current.get(id) ?? [])]
    for (let column = pending.pop(); column !== undefined; column = pending.pop()) {
      if (column === id) return true
      if (seen.has(column)) continue
      seen.add(column)
      pending.push(...(current.get(column) ?? []))
    }
  }
  return false
}

/** Ids of the columns whose type `definitions` changes, per table with no rename in `renames`. */
function typeChangedColumns(definitions: ColumnStatementDefinitions, renames: readonly ColumnRename[]): string[][] {
  const tableId = (database: string, name: string) => JSON.stringify([database, name])
  const renamed = new Set(renames.map((rename) => tableId(rename.database, rename.table)))
  const previous = new Map<string, TableDefinition>()
  for (const def of definitions.previous) if (def.kind === 'table') previous.set(tableId(def.database, def.name), def)
  const changed: string[][] = []
  for (const def of definitions.next) {
    if (def.kind !== 'table' || renamed.has(tableId(def.database, def.name))) continue
    const keys: string[] = []
    changed.push(keys)
    const oldColumns = new Map((previous.get(tableId(def.database, def.name))?.columns ?? []).map((column) => [column.name, column]))
    for (const column of def.columns) {
      const oldColumn = oldColumns.get(column.name)
      if (oldColumn !== undefined && columnTypeFingerprint(oldColumn) !== columnTypeFingerprint(column)) {
        keys.push(columnObjectId(def.database, def.name, column.name))
      }
    }
  }
  return changed
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
