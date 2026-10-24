import {
  CUTOVER_COPY_MODES,
  CUTOVER_OLD_TABLE_MODES,
  parseCutoverRequest,
  planCutover,
  type CutoverCopyMode,
  type CutoverOldTableMode,
  type CutoverRequest,
  type MigrationOperation,
  type MigrationPlan,
  type PlannedCutover,
  type RiskLevel,
  type SchemaDefinition,
  type TableDefinition,
} from '@chkit/core'

export interface CutoverFlags {
  cutover: string[]
  copy: string | undefined
  oldTable: string | undefined
  dropRetained: string[]
}

export interface ResolvedCutovers {
  requests: CutoverRequest[]
  copy: CutoverCopyMode
  oldTable: CutoverOldTableMode
}

/** What `generate` reports for each cutover, in JSON and text. */
export interface CutoverSummary {
  table: string
  key: string[]
  copy: CutoverCopyMode
  oldTable: CutoverOldTableMode
  shadow: string
  mirror: string
  snapshot: string
  columns: string[]
  retainedAs?: string
  nextSteps: string[]
}

/** Reads `--cutover`, `--cutover-copy` and `--cutover-old`; usage errors throw. */
export function resolveCutoverFlags(flags: CutoverFlags): ResolvedCutovers {
  const requests = flags.cutover.map(parseCutoverRequest)
  if (requests.length === 0 && (flags.copy !== undefined || flags.oldTable !== undefined)) {
    throw new Error('--cutover-copy and --cutover-old apply to a cutover: add --cutover <database>.<table>=<key columns>.')
  }
  const seen = new Set<string>()
  for (const request of requests) {
    const target = `${request.database}.${request.table}`
    if (seen.has(target)) throw new Error(`--cutover ${target} is given more than once.`)
    seen.add(target)
  }
  const copy = flags.copy ?? 'migration'
  if (!CUTOVER_COPY_MODES.includes(copy as CutoverCopyMode)) {
    throw new Error(`Invalid --cutover-copy "${copy}". Expected ${CUTOVER_COPY_MODES.join(' or ')}.`)
  }
  const oldTable = flags.oldTable ?? 'keep'
  if (!CUTOVER_OLD_TABLE_MODES.includes(oldTable as CutoverOldTableMode)) {
    throw new Error(`Invalid --cutover-old "${oldTable}". Expected ${CUTOVER_OLD_TABLE_MODES.join(' or ')}.`)
  }
  return { requests, copy: copy as CutoverCopyMode, oldTable: oldTable as CutoverOldTableMode }
}

/**
 * Tables a keep-mode cutover retained (`retainedBy` in the snapshot) stay
 * planned as they are, so they never read as a pending drop. `--drop-retained`
 * leaves one out, which plans its DROP like any removed table. A table the
 * schema declares again is planned from the schema.
 */
export function carryRetainedDefinitions(input: {
  previousDefinitions: SchemaDefinition[]
  definitions: SchemaDefinition[]
  dropRetained: string[]
}): SchemaDefinition[] {
  const retained = input.previousDefinitions.filter(
    (def): def is TableDefinition => def.kind === 'table' && def.retainedBy !== undefined
  )
  const retainedNames = new Set(retained.map((def) => `${def.database}.${def.name}`))
  for (const name of input.dropRetained) {
    if (!retainedNames.has(name)) {
      const known = [...retainedNames]
      throw new Error(
        `--drop-retained ${name}: no table retained by a cutover has that name${known.length > 0 ? ` (retained: ${known.join(', ')})` : ''}.`
      )
    }
  }
  const drop = new Set(input.dropRetained)
  const declared = new Set(input.definitions.map((def) => `${def.kind}:${def.database}.${def.name}`))
  const carried = retained.filter(
    (def) => !drop.has(`${def.database}.${def.name}`) && !declared.has(`table:${def.database}.${def.name}`)
  )
  return [...input.definitions, ...carried]
}

/**
 * Replaces the DROP + CREATE that `planDiff` emits for each cutover table with
 * the cutover's operations, at the CREATE's position (after the drops, before
 * objects created on top of the table).
 */
export function applyCutovers(input: {
  plan: MigrationPlan
  previousDefinitions: SchemaDefinition[]
  definitions: SchemaDefinition[]
  cutovers: ResolvedCutovers
  cluster: string | undefined
  stamp: string
}): { plan: MigrationPlan; cutovers: PlannedCutover[] } {
  const { cutovers } = input
  let operations = input.plan.operations
  const planned: PlannedCutover[] = []
  for (const request of cutovers.requests) {
    const target = `${request.database}.${request.table}`
    const key = `table:${target}`
    const dropIndex = operations.findIndex((op) => op.type === 'drop_table' && op.key === key)
    const createIndex = operations.findIndex((op) => op.type === 'create_table' && op.key === key)
    if (dropIndex === -1 || createIndex === -1) {
      throw new Error(
        `--cutover ${target}: the plan does not recreate ${target}. A cutover replaces the DROP TABLE and CREATE TABLE of a change to the engine, ORDER BY, PRIMARY KEY or PARTITION BY of an existing table${input.plan.operations.length === 0 ? '; the plan is empty' : ''}. Check the table name and the --table scope.`
      )
    }
    const oldDef = findTable(input.previousDefinitions, request)
    const newDef = findTable(input.definitions, request)
    if (!oldDef || !newDef) throw new Error(`--cutover ${target}: the table is missing from the snapshot or the schema.`)
    const cutover = planCutover({
      oldDef,
      newDef,
      request,
      options: { copy: cutovers.copy, oldTable: cutovers.oldTable, cluster: input.cluster, stamp: input.stamp },
      definitions: input.definitions,
    })
    planned.push(cutover)
    const drop = operations[dropIndex] as MigrationOperation
    const create = operations[createIndex] as MigrationOperation
    operations = operations.flatMap((op) => (op === create ? cutover.operations : op === drop ? [] : [op]))
  }
  return {
    plan: { ...input.plan, operations, riskSummary: summarizeRisk(operations) },
    cutovers: planned,
  }
}

export function summarizeCutover(cutover: PlannedCutover): CutoverSummary {
  const { request, options, names } = cutover
  const target = `${request.database}.${request.table}`
  const nextSteps =
    options.copy === 'backfill'
      ? [
          'chkit migrate --apply  (creates the shadow table and the mirror, then stops at the copy check)',
          `chkit plugin backfill plan --cutover ${target}  (then run or submit the plan)`,
          'chkit migrate --apply  (verifies the copy and swaps the tables)',
        ]
      : ['chkit migrate --apply']
  return {
    table: target,
    key: request.key,
    copy: options.copy,
    oldTable: options.oldTable,
    shadow: `${request.database}.${names.shadow}`,
    mirror: `${request.database}.${names.mirror}`,
    snapshot: `${request.database}.${names.snapshot}`,
    columns: cutover.columns,
    ...(cutover.retained ? { retainedAs: `${request.database}.${names.previous}` } : {}),
    nextSteps,
  }
}

function findTable(definitions: SchemaDefinition[], request: CutoverRequest): TableDefinition | undefined {
  return definitions.find(
    (def): def is TableDefinition => def.kind === 'table' && def.database === request.database && def.name === request.table
  )
}

function summarizeRisk(operations: MigrationOperation[]): Record<RiskLevel, number> {
  const riskSummary: Record<RiskLevel, number> = { safe: 0, caution: 0, danger: 0 }
  for (const operation of operations) riskSummary[operation.risk] += 1
  return riskSummary
}
