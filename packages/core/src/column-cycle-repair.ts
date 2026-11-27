import {
  type ColumnRename,
  EXPRESSION_KEYWORDS,
  LITERAL_WORDS,
  columnKey,
  columnRenameKey,
  plainFacts,
  tableId,
} from './column-reads.js'
import { normalizeColumn, shapeKey } from './column-shape.js'
import { heapPop, heapPush, heapify } from './heap.js'
import type { ColumnDefinition, MigrationOperation, SchemaDefinition } from './model.js'
import { orderByDependencies, stronglyConnectedComponents, type DependencyGraph } from './object-dependencies.js'
import { compareCodePoints } from './order.js'

/** The schema before and after a plan, which the column statement order reads. */
export interface ColumnStatementDefinitions {
  previous: SchemaDefinition[]
  next: SchemaDefinition[]
}

/**
 * For each `modified` column K, the `modified` columns whose MODIFY must run
 * before the MODIFY that gives K its new expression (#769). ClickHouse
 * rejects an expression that closes a cycle. K's new expression closes one
 * through column P when it reads a column that leads to P, and P's old
 * expression reads a column that leads back to K, which P's new expression
 * no longer reads. "Leads to" follows reads that both the old and the new
 * expression of their column have, so the path exists in every intermediate
 * state and only P's MODIFY breaks it. On the way to P it also follows the
 * reads of `added` columns: the MODIFY runs after the ADD of every added
 * column its expression reads through them. Every such P is read by K's new
 * expression through the new schema, so these edges can't form a cycle unless
 * the new schema has one.
 *
 * Such a K, P and every column between them lie on a cycle of old and new
 * reads, so the search starts from the old reads that P drops and keeps to
 * the columns on such cycles (#789). Beyond work linear in the reads, it
 * searches those columns once for each old read that a P drops, and once
 * more for each such read and P when the first search finds a K: a deep
 * chain of defaults costs no more than a short one, unless many dropped
 * reads lead into the same long part of a cycle. Beyond the result, memory
 * stays linear in the reads.
 */
export function cycleReleases(
  reads: DependencyGraph,
  oldReads: DependencyGraph,
  added: ReadonlySet<string>,
  modified: ReadonlySet<string>
): Map<string, string[]> {
  const cyclic = onCycles(reads, oldReads)
  // Column → the columns that lead to it, the first step from K excluded.
  const leadsFrom = new Map<string, string[]>()
  for (const [column, columnReads] of reads) {
    if (!cyclic.has(column)) continue
    const follow = added.has(column)
    for (const read of columnReads) {
      if (cyclic.has(read) && (follow || oldReads.get(column)?.has(read))) {
        const from = leadsFrom.get(read)
        if (from === undefined) leadsFrom.set(read, [column])
        else from.push(column)
      }
    }
  }
  const closure = (from: string, next: (column: string) => Iterable<string>): Set<string> => {
    const seen = new Set([from])
    const pending = [from]
    for (let column = pending.pop(); column !== undefined; column = pending.pop()) {
      for (const other of next(column)) {
        if (cyclic.has(other) && !seen.has(other)) {
          seen.add(other)
          pending.push(other)
        }
      }
    }
    return seen
  }
  const stableReads = (column: string) =>
    [...(reads.get(column) ?? [])].filter((read) => oldReads.get(column)?.has(read))
  // Dropped read → the breakers that drop it. Each closure is searched,
  // used and let go, so the searches need memory linear in the reads.
  const droppedBy = new Map<string, string[]>()
  for (const breaker of [...modified].sort(compareCodePoints)) {
    if (!cyclic.has(breaker)) continue
    for (const dropped of oldReads.get(breaker) ?? []) {
      if (reads.get(breaker)?.has(dropped) || !cyclic.has(dropped)) continue
      const breakers = droppedBy.get(dropped)
      if (breakers === undefined) droppedBy.set(dropped, [breaker])
      else breakers.push(breaker)
    }
  }
  const released = new Map<string, Set<string>>()
  for (const [dropped, breakers] of droppedBy) {
    const back = closure(dropped, stableReads)
    for (const breaker of breakers) {
      let leadsToBreaker: Set<string> | undefined
      for (const key of back) {
        if (key === breaker || !modified.has(key)) continue
        leadsToBreaker ??= closure(breaker, (column) => leadsFrom.get(column) ?? [])
        const target = leadsToBreaker
        if ([...(reads.get(key) ?? [])].some((read) => target.has(read))) {
          released.set(key, (released.get(key) ?? new Set<string>()).add(breaker))
        }
      }
    }
  }
  return new Map([...released].map(([key, breakers]) => [key, [...breakers]]))
}

/**
 * The columns that lie on a cycle of `reads` and `oldReads` together, or on
 * a path between two such cycles: what is left after taking away, again and
 * again, every column that reads none of the rest or that none of the rest
 * reads.
 */
function onCycles(reads: DependencyGraph, oldReads: DependencyGraph): Set<string> {
  const readsOf = new Map<string, Set<string>>()
  const readBy = new Map<string, Set<string>>()
  const link = (map: Map<string, Set<string>>, from: string, to: string) =>
    map.set(from, (map.get(from) ?? new Set<string>()).add(to))
  for (const graph of [reads, oldReads]) {
    for (const [column, columnReads] of graph) {
      for (const read of columnReads) {
        link(readsOf, column, read)
        link(readBy, read, column)
      }
    }
  }
  const left = new Set([...readsOf.keys()].filter((column) => readBy.has(column)))
  const outs = new Map([...left].map((column) => [column, [...(readsOf.get(column) ?? [])].filter((read) => left.has(read)).length]))
  const ins = new Map([...left].map((column) => [column, [...(readBy.get(column) ?? [])].filter((other) => left.has(other)).length]))
  const pending = [...left].filter((column) => outs.get(column) === 0 || ins.get(column) === 0)
  for (let column = pending.pop(); column !== undefined; column = pending.pop()) {
    if (!left.delete(column)) continue
    for (const read of readsOf.get(column) ?? []) {
      const count = (ins.get(read) ?? 0) - 1
      ins.set(read, count)
      if (count === 0 && left.has(read)) pending.push(read)
    }
    for (const other of readBy.get(column) ?? []) {
      const count = (outs.get(other) ?? 0) - 1
      outs.set(other, count)
      if (count === 0 && left.has(other)) pending.push(other)
    }
  }
  return left
}

/**
 * The units of work the cycle repair did in the last `orderColumnStatements`,
 * the same in both ports, for tests that bound it.
 */
export const cycleRepairWork = { units: 0 }

/**
 * The sorted statement order, with the temporary default cycles it closes
 * broken where the reads are certain (#775). Each table is replayed on its
 * own, with its own work budget, and gives only edges that make a closing
 * statement wait for a breaker (`breakClosedCycles`); one more sort with
 * those edges gives the order. A RENAME COLUMN keeps its column on the
 * graph under the new name (`renamedColumns`). A table is left out, and
 * keeps its sorted order, when a rename in `renames` is one
 * `renamedColumns` does not model, when one of its expressions is not plain
 * (`plainReads`), when a
 * statement's key could be one of its columns or another table's, when a
 * prerequisite links its statements to another table's (keys of two tables
 * can be the same), when no statement can break its cycle, or when its
 * replay runs out of work. Only the columns that `cycleCandidates` finds
 * take part.
 */
export function repairedOrder(
  prerequisites: number[][],
  statements: MigrationOperation[],
  definitions: ColumnStatementDefinitions,
  renames: readonly ColumnRename[]
): number[] {
  cycleRepairWork.units = 0
  // Every search below walks prerequisites in index order, so the work it
  // does, and where the budget ends, is the same in both ports.
  prerequisites = prerequisites.map((before) => [...before].sort((a, b) => a - b))
  const sorted = orderByDependencies(
    prerequisites.map((_, index) => index),
    String,
    (key) => (prerequisites[Number(key)] ?? []).map(String)
  )
  const columns = statementColumns(statements, definitions)
  const excluded = new Set(columns.ambiguous)
  const renamed = renamedColumns(renames, definitions)
  for (const table of renamed.excluded) excluded.add(table)
  // Statements connected through prerequisites. A connection to another
  // table's statement, or to a statement of no known table, leaves the
  // tables out: the repair must not move a statement of a table that keeps
  // its sorted order.
  const component = connectedStatements(prerequisites)
  const owners = statementTables(statements, columns.of, definitions, renames)
  const tablesOf = new Map<number, Set<string | undefined>>()
  component.forEach((root, index) => {
    const tables = tablesOf.get(root)
    if (tables === undefined) tablesOf.set(root, new Set([owners[index]]))
    else tables.add(owners[index])
  })
  for (const tables of tablesOf.values()) {
    if (tables.size > 1) for (const table of tables) if (table !== undefined) excluded.add(table)
  }
  // Only a table with a column statement can close a cycle while the plan runs.
  const active = new Set<string>()
  for (const column of columns.of) {
    if (column !== undefined && !excluded.has(column.table)) active.add(column.table)
  }
  if (active.size === 0) return sorted
  const oldPlain = plainFacts(definitions.previous, active)
  const newPlain = plainFacts(definitions.next, active)
  for (const [table, graph] of oldPlain.plain) oldPlain.plain.set(table, renamedGraph(graph, renamed.ids))
  for (const table of [...oldPlain.uncertain, ...newPlain.uncertain]) active.delete(table)
  // Per table: the columns that may close a cycle, the size of its replay
  // (those columns and all their reads) and its old expressions.
  const candidates = new Map<string, Set<string>>()
  const size = new Map<string, number>()
  const initial = new Map<string, Array<[string, ReadonlySet<string>]>>()
  for (const table of active) {
    const graphs = [oldPlain.plain.get(table), newPlain.plain.get(table)].filter((graph) => graph !== undefined)
    const found = cycleCandidates(graphs)
    if (found.size === 0) continue
    candidates.set(table, found)
    let total = found.size
    for (const graph of graphs) {
      for (const [column, reads] of graph) if (found.has(column)) total += reads.size
    }
    size.set(table, total)
    initial.set(
      table,
      [...(oldPlain.plain.get(table) ?? [])].filter(([column]) => found.has(column))
    )
  }
  // The statements each table replays.
  const replayed = new Map<string, number[]>()
  const ids = columns.of.map((column) => column?.id)
  sorted.forEach((index) => {
    const column = columns.of[index]
    if (column === undefined || !candidates.get(column.table)?.has(column.id)) return
    const list = replayed.get(column.table)
    if (list === undefined) replayed.set(column.table, [index])
    else list.push(index)
  })
  if (replayed.size === 0) return sorted
  const changes = replayChanges(statements, columns.of, newPlain.plain)
  const groups = stronglyConnectedComponents(prerequisites).map((members) => [...members].sort((a, b) => a - b))
  const groupOf = new Array<number>(prerequisites.length).fill(0)
  groups.forEach((members, group) => {
    for (const member of members) groupOf[member] = group
  })
  const connected = new Map<number, number[]>()
  component.forEach((root, index) => {
    const list = connected.get(root)
    if (list === undefined) connected.set(root, [index])
    else list.push(index)
  })
  const added: Array<[number, number]> = []
  for (const [table, list] of replayed) {
    const roots = [...new Set(list.map((index) => component[index] ?? index))]
    const scheduled = roots.flatMap((root) => connected.get(root) ?? []).sort((a, b) => a - b)
    // The budget also covers the prerequisites the breaker checks walk.
    let total = size.get(table) ?? 0
    for (const index of scheduled) total += prerequisites[index]?.length ?? 0
    // The columns whose reads the replay changes: the others keep their old reads throughout.
    const changed = new Set<string>()
    for (const index of list) {
      if (changes.has(index) || statements[index]?.type === 'alter_table_drop_column') changed.add(ids[index] ?? '')
    }
    const replay = defaultReplay(initial.get(table) ?? [], 8 * total + 1024, changed)
    const edges = breakClosedCycles(scheduled, new Set(list), statements, prerequisites, groups, groupOf, ids, changes, replay)
    cycleRepairWork.units += replay.used()
    if (edges !== undefined) added.push(...edges)
  }
  if (added.length === 0) return sorted
  const extended = prerequisites.map((before) => [...before])
  for (const [target, breaker] of added) extended[target]?.push(breaker)
  return groupOrder(extended, groups, groupOf)
}

/**
 * How the cycle repair sees the `renames` (#827): ClickHouse rewrites every
 * DEFAULT, MATERIALIZED and ALIAS expression that reads a renamed column to
 * its new name, so a RENAME COLUMN releases the old name and provides the
 * new one, and the column keeps its reads and readers. `ids` maps each old
 * `columnId` to the new one, which the old expressions are read with. A
 * rename that this does not model leaves its table out (`excluded`): one
 * whose old name is still a column after the plan or whose new name was one
 * before it, a name in two renames of the table, a name with a `.`
 * (ClickHouse renames nested columns differently), or a keyword or literal
 * word (in any case: ClickHouse 26.3 rewrites a read of a column renamed to
 * `true` as the literal `true`, and one renamed to `not` as the operator).
 */
function renamedColumns(
  renames: readonly ColumnRename[],
  definitions: ColumnStatementDefinitions
): { ids: Map<string, string>; excluded: Set<string> } {
  const names = (defs: SchemaDefinition[]) => {
    const byTable = new Map<string, Set<string>>()
    for (const def of defs) {
      if (def.kind === 'table') byTable.set(tableId(def.database, def.name), new Set(def.columns.map((column) => column.name)))
    }
    return byTable
  }
  const before = names(definitions.previous)
  const after = names(definitions.next)
  const ids = new Map<string, string>()
  const excluded = new Set<string>()
  const seen = new Map<string, Set<string>>()
  const modelled = (name: string) => {
    const lower = name.toLowerCase()
    return !name.includes('.') && !LITERAL_WORDS.has(lower) && !EXPRESSION_KEYWORDS.has(lower)
  }
  for (const rename of renames) {
    const table = tableId(rename.database, rename.table)
    const used = seen.get(table) ?? new Set<string>()
    seen.set(table, used)
    const clean =
      modelled(rename.from) &&
      modelled(rename.to) &&
      before.get(table)?.has(rename.from) === true &&
      before.get(table)?.has(rename.to) === false &&
      after.get(table)?.has(rename.to) === true &&
      after.get(table)?.has(rename.from) === false &&
      !used.has(rename.from) &&
      !used.has(rename.to)
    used.add(rename.from)
    used.add(rename.to)
    if (!clean) excluded.add(table)
    ids.set(`${table}\u0000${rename.from}`, `${table}\u0000${rename.to}`)
  }
  return { ids, excluded }
}

/** `graph` (`columnId` → the `columnId`s it reads) with the columns `ids` renames under their new names. */
function renamedGraph(graph: Map<string, Set<string>>, ids: ReadonlyMap<string, string>): Map<string, Set<string>> {
  if (ids.size === 0) return graph
  const name = (column: string) => ids.get(column) ?? column
  return new Map([...graph].map(([column, reads]) => [name(column), new Set([...reads].map(name))]))
}

/**
 * The order `orderByDependencies` gives `prerequisites` whose cycles are
 * `groups`: the ready group whose first statement comes first runs next,
 * its members in key order. A heap of ready groups keeps it near linear.
 */
function groupOrder(prerequisites: number[][], groups: number[][], groupOf: number[]): number[] {
  const remaining = groups.map(() => 0)
  const dependents = prerequisites.map((): number[] => [])
  prerequisites.forEach((before, index) => {
    for (const other of before) {
      const group = groupOf[index] ?? 0
      if (groupOf[other] === group) continue
      remaining[group] = (remaining[group] ?? 0) + 1
      dependents[other]?.push(index)
    }
  })
  const groupAt = new Map(groups.map((members, group) => [members[0] ?? 0, group]))
  const ready = groups.flatMap((members, group) => (remaining[group] === 0 ? [members[0] ?? 0] : [])).sort((a, b) => a - b)
  const order: number[] = []
  heapify(ready)
  for (let first = heapPop(ready); first !== undefined; first = heapPop(ready)) {
    const members = groups[groupAt.get(first) ?? 0] ?? []
    order.push(...members)
    for (const member of members) {
      for (const other of dependents[member] ?? []) {
        const waiting = groupOf[other] ?? 0
        remaining[waiting] = (remaining[waiting] ?? 0) - 1
        const firstOf = groups[waiting]?.[0] ?? 0
        if (remaining[waiting] === 0) heapPush(ready, firstOf)
      }
    }
  }
  return order
}

/**
 * The edges that make each statement of `scheduled` that would close a
 * cycle wait for a breaker (#775), or none when that fails. `cycleReleases`
 * adds an edge only when one MODIFY must break the cycle in every order.
 * When several could, or the cycle closes through two new expressions, this
 * sorts `scheduled` (whole groups of connected statements) like
 * `orderByDependencies` while replaying the `replayed` ones: the ready group
 * with the lowest key order runs next, a group being one statement or the
 * members of a cycle among the prerequisites, in key order. A statement that
 * would close a cycle makes its group wait for the breaker with the lowest
 * key order: a later statement of a column on the cycle whose change removes
 * a read on it, and the group's statements are replayed back. A breaker that
 * already waits for the statement is skipped, so the edges never form a new
 * cycle. The groups before it keep their places, so this is the order that
 * adding the edge and sorting again would give. With no breaker, or when
 * the replay runs out of work, it returns none.
 */
function breakClosedCycles(
  scheduled: number[],
  replayed: ReadonlySet<number>,
  statements: MigrationOperation[],
  prerequisites: number[][],
  groups: number[][],
  groupOf: number[],
  columns: ReadonlyArray<string | undefined>,
  changes: ReadonlyMap<number, ReadonlySet<string>>,
  replay: DefaultReplay
): Array<[number, number]> | undefined {
  const added: Array<[number, number]> = []
  const extra = new Map<number, number[]>()
  // The statements that change each column's expression, in key order.
  const changing = new Map<string, number[]>()
  for (const index of scheduled) {
    const column = columns[index]
    if (column === undefined || !replayed.has(index) || !changes.has(index)) continue
    const list = changing.get(column)
    if (list === undefined) changing.set(column, [index])
    else list.push(index)
  }
  // A group runs once every prerequisite of its members outside it has run.
  const remaining = new Map<number, number>()
  const dependents = new Map<number, number[]>()
  const wait = (index: number, other: number) => {
    const group = groupOf[index] ?? 0
    if (groupOf[other] === group) return
    remaining.set(group, (remaining.get(group) ?? 0) + 1)
    const list = dependents.get(other)
    if (list === undefined) dependents.set(other, [index])
    else list.push(index)
  }
  const ownGroups = new Set<number>()
  for (const index of scheduled) {
    ownGroups.add(groupOf[index] ?? 0)
    for (const other of prerequisites[index] ?? []) wait(index, other)
  }
  const placed = new Set<number>()
  // Ready groups by their first statement, which is unique to each group.
  const groupAt = new Map([...ownGroups].map((group) => [groups[group]?.[0] ?? 0, group]))
  const ready = [...ownGroups]
    .filter((group) => (remaining.get(group) ?? 0) === 0)
    .map((group) => groups[group]?.[0] ?? 0)
    .sort((a, b) => a - b)
  heapify(ready)
  for (let first = heapPop(ready); first !== undefined; first = heapPop(ready)) {
    const group = groupAt.get(first) ?? 0
    const members = groups[group] ?? []
    // A group is looked at again each time a breaker blocks it.
    if (!replay.spend(members.length)) return undefined
    const undo: Array<[string, readonly string[] | undefined]> = []
    let blocked = false
    for (const target of members) {
      const column = columns[target]
      if (column === undefined || !replayed.has(target)) continue
      const change = changes.get(target)
      const cycle = change === undefined ? NO_CYCLE : replay.closedCycle(column, change)
      if (cycle === undefined) return undefined
      if (cycle.columns.length > 0) {
        const candidates = cycle.columns
          .filter((other) => other !== column)
          .flatMap((other) => changing.get(other) ?? [])
          .filter((j) => !placed.has(j) && groupOf[j] !== group)
          .sort((a, b) => a - b)
        if (!replay.spend(cycle.columns.length + candidates.length)) return undefined
        let breaker: number | undefined
        for (const j of candidates) {
          const after = changes.get(j) ?? new Set<string>()
          if (!(replay.reads(columns[j] ?? '') ?? []).some((read) => cycle.has(read) && !after.has(read))) continue
          const waits = waitsFor({ prerequisites, extra, dependents, groups, groupOf }, j, target, placed, replay)
          if (waits === undefined) return undefined
          if (!waits) {
            breaker = j
            break
          }
        }
        if (breaker === undefined) return undefined
        for (const [undone, reads] of undo.reverse()) replay.assign(undone, reads)
        if (replay.exhausted()) return undefined
        added.push([target, breaker])
        const list = extra.get(target)
        if (list === undefined) extra.set(target, [breaker])
        else list.push(breaker)
        wait(target, breaker)
        blocked = true
        break
      }
      undo.push([column, replay.reads(column)])
      // A DROP removes its column; a change sets its reads.
      if (statements[target]?.type === 'alter_table_drop_column') replay.assign(column, undefined)
      if (change !== undefined) replay.assign(column, change)
      if (replay.exhausted()) return undefined
    }
    if (blocked) continue
    for (const member of members) placed.add(member)
    for (const member of members) {
      for (const other of dependents.get(member) ?? []) {
        const waiting = groupOf[other] ?? 0
        const left = (remaining.get(waiting) ?? 0) - 1
        remaining.set(waiting, left)
        const firstOf = groups[waiting]?.[0] ?? 0
        if (left === 0) heapPush(ready, firstOf)
      }
    }
  }
  return added
}

/** The statement graph `waitsFor` searches. */
interface WaitGraph {
  prerequisites: number[][]
  extra: ReadonlyMap<number, number[]>
  /** The statements that wait for each one, across groups (`extra` included). */
  dependents: ReadonlyMap<number, number[]>
  groups: number[][]
  groupOf: number[]
}

/**
 * Whether statement `from` runs after statement `target` through
 * `prerequisites` and `extra`, or undefined when `replay` runs out of work.
 * A `placed` statement has run, so it does not wait for `target`, which has
 * not. `target` is ready to run, so every statement that waits for it is
 * still to run. The search runs from both ends, widening the smaller
 * frontier (in turns on a tie): down the prerequisites of `from`, and up
 * the statements that wait for `target`, where the members of a group wait
 * for each other. Many breakers can wait for one long chain of statements
 * that does not reach `target`; the other end then stops it early. Each
 * prerequisite, dependent or group member it looks at uses one unit of the
 * replay's work.
 */
function waitsFor(
  graph: WaitGraph,
  from: number,
  target: number,
  placed: ReadonlySet<number>,
  replay: DefaultReplay
): boolean | undefined {
  const down = new Set([from])
  const up = new Set([target])
  const upGroups = new Set<number>()
  let downFront = [from]
  let upFront = [target]
  let widenDown = false
  while (downFront.length > 0 && upFront.length > 0) {
    widenDown = downFront.length === upFront.length ? !widenDown : downFront.length < upFront.length
    const front: number[] = []
    if (widenDown) {
      for (const index of downFront) {
        for (const list of [graph.prerequisites[index], graph.extra.get(index)]) {
          for (const other of list ?? []) {
            if (!replay.spend()) return undefined
            if (up.has(other)) return true
            if (placed.has(other) || down.has(other)) continue
            down.add(other)
            front.push(other)
          }
        }
      }
      downFront = front
    } else {
      for (const index of upFront) {
        const group = graph.groupOf[index] ?? 0
        const members = upGroups.has(group) ? [] : (graph.groups[group] ?? [])
        upGroups.add(group)
        for (const list of [members, graph.dependents.get(index)]) {
          for (const other of list ?? []) {
            if (!replay.spend()) return undefined
            if (down.has(other)) return true
            if (up.has(other)) continue
            up.add(other)
            front.push(other)
          }
        }
      }
      upFront = front
    }
  }
  return false
}

/** Statement index → a statement it is connected to through `prerequisites`, the same for all of them. */
function connectedStatements(prerequisites: number[][]): number[] {
  const parent = prerequisites.map((_, index) => index)
  const find = (index: number): number => {
    let root = index
    while (parent[root] !== root) root = parent[root] ?? root
    for (let at = index; parent[at] !== root; ) {
      const next = parent[at] ?? root
      parent[at] = root
      at = next
    }
    return root
  }
  prerequisites.forEach((before, index) => {
    for (const other of before) {
      const a = find(index)
      const b = find(other)
      if (a !== b) parent[Math.max(a, b)] = Math.min(a, b)
    }
  })
  return parent.map((_, index) => find(index))
}

/**
 * The `tableId` of each statement: its column's table (`statementColumns`),
 * the table of a table TTL statement or of a RENAME COLUMN in `renames`, or
 * none when no single table owns its key.
 */
function statementTables(
  statements: MigrationOperation[],
  columns: ReadonlyArray<StatementColumn | undefined>,
  definitions: ColumnStatementDefinitions,
  renames: readonly ColumnRename[]
): Array<string | undefined> {
  const owners = new Map<string, string | undefined>()
  const own = (key: string, table: string) => owners.set(key, owners.has(key) && owners.get(key) !== table ? undefined : table)
  for (const def of [...definitions.previous, ...definitions.next]) {
    if (def.kind === 'table') own(`table:${def.database}.${def.name}:ttl`, tableId(def.database, def.name))
  }
  for (const rename of renames) own(columnRenameKey(rename), tableId(rename.database, rename.table))
  return statements.map((op, index) => columns[index]?.table ?? owners.get(op.key))
}

/** The column a statement changes, as it was and as it will be. */
interface StatementColumn {
  id: string
  table: string
  before?: ColumnDefinition
  after?: ColumnDefinition
}

/**
 * The column (`columnId`) of each ADD, MODIFY and DROP COLUMN statement. A
 * key can name the columns of two tables (table `t:column:x` and column
 * `x:column:a` of `t` give the same key); the statement then belongs to the
 * one whose column it changes: added, dropped or changed. When that is
 * still more than one, the tables are `ambiguous` and the repair leaves
 * them out.
 */
function statementColumns(
  statements: MigrationOperation[],
  definitions: ColumnStatementDefinitions
): { of: Array<StatementColumn | undefined>; ambiguous: Set<string> } {
  // Only the keys of the statements matter.
  const keys = new Set(statements.map((op) => op.key))
  const byKey = new Map<string, StatementColumn | StatementColumn[]>()
  const record = (defs: SchemaDefinition[], side: 'before' | 'after') => {
    for (const def of defs) {
      if (def.kind !== 'table') continue
      const table = tableId(def.database, def.name)
      const prefix = columnKey({ database: def.database, table: def.name }, '')
      for (const column of def.columns) {
        const key = prefix + column.name
        if (!keys.has(key)) continue
        const id = `${table}\u0000${column.name}`
        const found = byKey.get(key)
        if (found === undefined) byKey.set(key, { id, table, [side]: column })
        else if (!Array.isArray(found) && found.id === id) found[side] = column
        else {
          const list = Array.isArray(found) ? found : [found]
          const same = list.find((entry) => entry.id === id)
          if (same !== undefined) same[side] = column
          else list.push({ id, table, [side]: column })
          byKey.set(key, list)
        }
      }
    }
  }
  record(definitions.previous, 'before')
  record(definitions.next, 'after')
  const ambiguous = new Set<string>()
  const of = statements.map((op) => {
    const type = op.type
    if (type !== 'alter_table_add_column' && type !== 'alter_table_modify_column' && type !== 'alter_table_drop_column') {
      return undefined
    }
    const found = byKey.get(op.key)
    // A key that names one column is that column's.
    if (found === undefined || !Array.isArray(found)) return found
    const matching = found.filter(({ before, after }) => {
      if (type === 'alter_table_add_column') return before === undefined && after !== undefined
      if (type === 'alter_table_drop_column') return before !== undefined && after === undefined
      return before !== undefined && after !== undefined && shapeKey(normalizeColumn(before)) !== shapeKey(normalizeColumn(after))
    })
    if (matching.length === 1) return matching[0]
    for (const entry of found) ambiguous.add(entry.table)
    return undefined
  })
  return { of, ambiguous }
}

/**
 * Statement index → the plain reads (`columnId`s) its column's expression
 * has after it runs, for the statements that set an expression: an ADD, a
 * column's last MODIFY (which sets the new expression or keeps none), and
 * the REMOVE DEFAULT, MATERIALIZED or ALIAS that runs first when the new
 * column has no expression (`renderAlterRemoveColumnExpression`). The other
 * statements (REMOVE COMMENT, REMOVE CODEC) keep it.
 */
function replayChanges(
  statements: MigrationOperation[],
  columns: ReadonlyArray<StatementColumn | undefined>,
  plain: ReadonlyMap<string, ReadonlyMap<string, ReadonlySet<string>>>
): Map<number, ReadonlySet<string>> {
  const changes = new Map<number, ReadonlySet<string>>()
  statements.forEach((op, index) => {
    const column = columns[index]
    if (column === undefined) return
    const first = columns[index - 1]?.id !== column.id
    const last = columns[index + 1]?.id !== column.id
    const isModify = op.type === 'alter_table_modify_column'
    const { before, after } = column
    const removed = before?.default !== undefined && after !== undefined && after.default === undefined && after.defaultKind !== 'EPHEMERAL'
    if (op.type === 'alter_table_add_column' || (isModify && last)) changes.set(index, plain.get(column.table)?.get(column.id) ?? new Set())
    else if (isModify && first && removed) changes.set(index, new Set())
  })
  return changes
}

/** The reads of every column's expression while a plan runs, starting from the old expressions. */
interface DefaultReplay {
  /** The columns `column` reads, in code point order. */
  reads: (column: string) => readonly string[] | undefined
  /**
   * The cycle through `column` that giving it `reads` would close, or none
   * (no columns). It changes nothing. It returns undefined when the replay
   * has used up its work.
   */
  closedCycle: (column: string, reads: ReadonlySet<string>) => ClosedCycle | undefined
  /** Gives `column` the `reads` (none removes it); they must close no cycle. */
  assign: (column: string, reads: Iterable<string> | undefined) => void
  /** Uses `units` (one by default) of work; false once the work has run out. */
  spend: (units?: number) => boolean
  /** Whether the work has run out. */
  exhausted: () => boolean
  /** The units of work used so far. */
  used: () => number
}

/**
 * A cycle `closedCycle` found. `columns` holds `column` and every column on
 * the cycle that a statement changes, among others; it leaves out the links
 * of a chain of unchanged columns that each read one column.
 */
interface ClosedCycle {
  columns: readonly string[]
  /** Whether a read of a column of `columns` (other than `column`) is on the cycle. */
  has: (read: string) => boolean
}

const NO_CYCLE: ClosedCycle = { columns: [], has: () => false }

/**
 * The replay of one table, from its `initial` (old) expressions. Its state
 * never holds a cycle, so a new read Y of column X closes one exactly when
 * Y reaches X. That search runs from both ends at once, widening the smaller
 * frontier (in turns on a tie), so it stops early when either side runs
 * out. Columns are numbered in the order the replay first meets them (each
 * set in code point order); reads are kept in that order and readers in the
 * order they were added, so every search does the same work in both ports.
 * Each read a search, an update or a copy looks at uses one unit of the
 * `budget`.
 *
 * Only the `changed` columns are assigned new reads; the others keep their
 * old reads. A walk down the reads skips a chain of unchanged columns that
 * each read one column (`land`) and remembers where it ends, which never
 * changes. Many cycles can run through one long chain (#829); each cycle
 * then costs the columns around the chain, not its length.
 */
function defaultReplay(
  initial: ReadonlyArray<[string, ReadonlySet<string>]>,
  budget: number,
  changed: ReadonlySet<string>
): DefaultReplay {
  const number = new Map<string, number>()
  const names: string[] = []
  const reads: Array<number[] | undefined> = []
  const readers: Array<Set<number>> = []
  const fixed: boolean[] = []
  // Where a walk that reads a column lands (`land`), or -1 until it is known.
  const landing: number[] = []
  // Marks with an epoch per search, instead of a set per search.
  const down: number[] = []
  const up: number[] = []
  const seen: number[] = []
  const inside: number[] = []
  let epoch = 0
  let gather = 0
  let left = budget
  const of = (column: string): number => {
    const known = number.get(column)
    if (known !== undefined) return known
    const id = names.length
    number.set(column, id)
    names.push(column)
    reads.push(undefined)
    readers.push(new Set())
    fixed.push(!changed.has(column))
    landing.push(-1)
    down.push(0)
    up.push(0)
    seen.push(0)
    inside.push(0)
    return id
  }
  // Every read a step looks at uses one unit of the budget.
  const assignNumbers = (column: number, next: number[] | undefined) => {
    const old = reads[column] ?? []
    left -= old.length
    for (const read of old) readers[read]?.delete(column)
    reads[column] = next
    for (const read of next ?? []) readers[read]?.add(column)
  }
  // Columns are numbered in code point order within each set, so both ports number them alike.
  const numbered = (columns: Iterable<string>) => {
    const sorted = [...columns].sort(compareCodePoints)
    left -= sorted.length
    return sorted.map(of).sort((a, b) => a - b)
  }
  const assign = (column: string, next: Iterable<string> | undefined) => {
    const id = of(column)
    assignNumbers(id, next === undefined ? undefined : numbered(next))
  }
  for (const [column, columnReads] of initial) assign(column, columnReads)
  // The column a walk that reads `column` lands on: `column` itself, or,
  // when no statement changes it and it reads one column, where that read
  // lands. Those reads never change, so the answer is kept. Each link it
  // follows the first time uses one unit; the caller checks the budget. A
  // cycle among those reads (an old schema ClickHouse refuses) uses up the
  // work, so the table keeps its sorted order.
  const land = (column: number): number => {
    const path: number[] = []
    let at = column
    for (;;) {
      const known = landing[at] ?? -1
      if (known >= 0) {
        at = known
        break
      }
      if (known === -2) {
        for (const link of path) landing[link] = -1
        left = -1
        return at
      }
      const next = reads[at]
      if (!fixed[at] || next?.length !== 1 || left < 0) {
        landing[at] = at
        break
      }
      path.push(at)
      landing[at] = -2
      left -= 1
      at = next[0] ?? at
    }
    for (const link of path) landing[link] = at
    return at
  }
  // Whether `from` reaches `to` through reads, or undefined when the work runs out.
  const reaches = (from: number, to: number): boolean | undefined => {
    epoch += 1
    down[from] = epoch
    up[to] = epoch
    let downFront = [from]
    let upFront = [to]
    let widenDown = false
    while (downFront.length > 0 && upFront.length > 0) {
      // The smaller frontier widens; on a tie, the sides take turns.
      widenDown = downFront.length === upFront.length ? !widenDown : downFront.length < upFront.length
      const front: number[] = []
      if (widenDown) {
        for (const column of downFront) {
          for (const read of reads[column] ?? []) {
            left -= 1
            const reached = land(read)
            if (left < 0) return undefined
            if (up[reached] === epoch) return true
            if (down[reached] !== epoch) {
              down[reached] = epoch
              front.push(reached)
            }
          }
        }
        downFront = front
      } else {
        for (const column of upFront) {
          for (const reached of readers[column] ?? []) {
            left -= 1
            if (left < 0) return undefined
            if (down[reached] === epoch) return true
            if (up[reached] !== epoch) {
              up[reached] = epoch
              front.push(reached)
            }
          }
        }
        upFront = front
      }
    }
    return false
  }
  return {
    reads: (column) => {
      const id = number.get(column)
      const columnReads = id === undefined ? undefined : reads[id]
      left -= columnReads?.length ?? 0
      return columnReads?.map((read) => names[read] ?? '')
    },
    closedCycle: (column, next) => {
      const target = of(column)
      const current = new Set(reads[target] ?? [])
      left -= current.size
      const numberedNext = numbered(next)
      if (left < 0) return undefined
      gather += 1
      const mark = gather
      const columns: string[] = []
      for (const read of numberedNext) {
        if (current.has(read)) continue
        const hit = reaches(read, target)
        if (hit === undefined) return undefined
        if (!hit) continue
        if (columns.length === 0) {
          seen[target] = mark
          inside[target] = mark
          columns.push(column)
        }
        // The columns this read reaches (`seen`), walked depth first; one is
        // on the cycle (`inside`) when one of its reads lands on the cycle.
        // A column still on the walk is marked `-mark`: meeting it again means
        // the state holds a cycle (an old schema ClickHouse refuses), so the
        // table keeps its sorted order.
        const start = land(read)
        if (left < 0) return undefined
        if (seen[start] === mark) continue
        seen[start] = mark
        inside[start] = -mark
        const stack = [start]
        const position = [0]
        const onCycle = [false]
        for (let top = stack.length - 1; top >= 0; top = stack.length - 1) {
          const at = stack[top] ?? 0
          const list = reads[at] ?? []
          const index = position[top] ?? 0
          if (index < list.length) {
            position[top] = index + 1
            left -= 1
            const reached = land(list[index] ?? 0)
            if (left < 0) return undefined
            if (seen[reached] !== mark) {
              seen[reached] = mark
              inside[reached] = -mark
              stack.push(reached)
              position.push(0)
              onCycle.push(false)
            } else if (inside[reached] === mark) onCycle[top] = true
            else if (inside[reached] === -mark) {
              left = -1
              return undefined
            }
            continue
          }
          stack.pop()
          position.pop()
          inside[at] = 0
          if (!onCycle.pop()) continue
          inside[at] = mark
          columns.push(names[at] ?? '')
          if (top > 0) onCycle[top - 1] = true
        }
      }
      return {
        columns,
        // A read of a column on the cycle is on it when it lands on the cycle.
        has: (read) => {
          const id = number.get(read)
          return id !== undefined && inside[land(id)] === mark
        },
      }
    },
    assign,
    spend: (units = 1) => {
      left -= units
      return left >= 0
    },
    exhausted: () => left < 0,
    used: () => budget - Math.max(left, 0),
  }
}

/**
 * The columns that may lie on a cycle of the union of one table's `graphs`:
 * what is left after removing, again and again, the columns that read
 * nothing or that nothing reads among the columns left. With no cycle
 * nothing is left, so a table whose old and new reads form no cycle is not
 * replayed at all. A read in both graphs counts twice, on both ends.
 */
function cycleCandidates(graphs: ReadonlyArray<ReadonlyMap<string, ReadonlySet<string>>>): Set<string> {
  const out = new Map<string, string[]>()
  const into = new Map<string, string[]>()
  for (const graph of graphs) {
    for (const [column, reads] of graph) {
      if (reads.size === 0) continue
      const list = out.get(column)
      if (list === undefined) out.set(column, [...reads])
      else list.push(...reads)
      for (const read of reads) {
        const readers = into.get(read)
        if (readers === undefined) into.set(read, [column])
        else readers.push(column)
      }
    }
  }
  const outDegree = new Map<string, number>()
  const inDegree = new Map<string, number>()
  const pending: string[] = []
  for (const column of new Set([...out.keys(), ...into.keys()])) {
    const reads = out.get(column)?.length ?? 0
    const readers = into.get(column)?.length ?? 0
    outDegree.set(column, reads)
    inDegree.set(column, readers)
    if (reads === 0 || readers === 0) pending.push(column)
  }
  const removed = new Set(pending)
  const lower = (degree: Map<string, number>, column: string) => {
    if (removed.has(column)) return
    const left = (degree.get(column) ?? 0) - 1
    degree.set(column, left)
    if (left > 0) return
    removed.add(column)
    pending.push(column)
  }
  for (let column = pending.pop(); column !== undefined; column = pending.pop()) {
    for (const read of out.get(column) ?? []) lower(inDegree, read)
    for (const reader of into.get(column) ?? []) lower(outDegree, reader)
  }
  return new Set([...outDegree.keys()].filter((column) => !removed.has(column)))
}
