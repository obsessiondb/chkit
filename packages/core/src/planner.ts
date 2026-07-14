import { canonicalizeDefinitions, definitionKey } from './canonical.js'
import { diffByName, diffClauses, diffSettings } from './diff-primitives.js'
import type {
  ColumnDefinition,
  ColumnRenameSuggestion,
  DictionaryDefinition,
  MaterializedViewDefinition,
  MaterializedViewRefresh,
  MigrationOperation,
  MigrationPlan,
  RiskLevel,
  SchemaDefinition,
  TableDefinition,
} from './model.js'
import {
  renderAlterAddColumn,
  renderAlterAddIndex,
  renderAlterAddProjection,
  renderAlterDropColumn,
  renderAlterDropIndex,
  renderAlterDropProjection,
  renderAlterModifyColumn,
  renderAlterModifyRefresh,
  renderAlterModifySetting,
  renderAlterModifyTTL,
  renderAlterRemoveCodec,
  renderAlterResetSetting,
  renderDictionarySQL,
  toCreateSQL,
} from './sql.js'
import { assertValidDefinitions } from './validate.js'

function createMap(definitions: SchemaDefinition[]): Map<string, SchemaDefinition> {
  return new Map(definitions.map((def) => [definitionKey(def), def]))
}

function pushDropOperation(
  operations: MigrationOperation[],
  def: SchemaDefinition,
  risk: RiskLevel = 'danger'
): void {
  if (def.kind === 'table') {
    operations.push( {
      type: 'drop_table',
      key: definitionKey(def),
      risk,
      sql: `DROP TABLE IF EXISTS ${def.database}.${def.name};`,
    })
    return
  }
  if (def.kind === 'view') {
    operations.push( {
      type: 'drop_view',
      key: definitionKey(def),
      risk,
      sql: `DROP VIEW IF EXISTS ${def.database}.${def.name};`,
    })
    return
  }
  if (def.kind === 'dictionary') {
    operations.push( {
      type: 'drop_dictionary',
      key: definitionKey(def),
      risk,
      sql: `DROP DICTIONARY IF EXISTS ${def.database}.${def.name};`,
    })
    return
  }
  operations.push( {
    type: 'drop_materialized_view',
    key: definitionKey(def),
    risk,
    sql: `DROP TABLE IF EXISTS ${def.database}.${def.name} SYNC;`,
  })
}

function pushCreateOperation(
  operations: MigrationOperation[],
  def: SchemaDefinition,
  risk: RiskLevel = 'safe'
): void {
  if (def.kind === 'table') {
    operations.push( {
      type: 'create_table',
      key: definitionKey(def),
      risk,
      sql: toCreateSQL(def),
    })
    return
  }
  if (def.kind === 'view') {
    operations.push( {
      type: 'create_view',
      key: definitionKey(def),
      risk,
      sql: toCreateSQL(def),
    })
    return
  }
  if (def.kind === 'dictionary') {
    operations.push( {
      type: 'create_dictionary',
      key: definitionKey(def),
      risk,
      sql: toCreateSQL(def),
    })
    return
  }
  operations.push( {
    type: 'create_materialized_view',
    key: definitionKey(def),
    risk,
    sql: toCreateSQL(def),
  })
}

function pushCreateDatabaseOperation(
  operations: MigrationOperation[],
  database: string,
  risk: RiskLevel = 'safe'
): void {
  operations.push( {
    type: 'create_database',
    key: `database:${database}`,
    risk,
    sql: `CREATE DATABASE IF NOT EXISTS ${database};`,
  })
}

// Whitespace and identifier backtick-quoting carry no meaning in a key clause,
// and ClickHouse normalizes both when it stores the key: `toStartOfHour( ts )`
// comes back as `toStartOfHour(ts)`, and a column written bare as `user-id` in
// config is stored/introspected quoted as `` `user-id` ``. Drop insignificant
// whitespace and identifier backticks (but preserve single/double-quoted string
// literals, which are semantic) so a config clause and the introspected clause
// compare equal, avoiding a phantom table recreate. Comparison-only — never
// used to render DDL, so keyword expressions like `INTERVAL 1 HOUR` and real
// identifier quoting keep their form when emitted.
function stripInsignificantFormatting(token: string): string {
  let out = ''
  let quote: "'" | '"' | null = null
  for (let i = 0; i < token.length; i += 1) {
    const char = token[i] ?? ''
    if (quote) {
      out += char
      if (char === quote && token[i - 1] !== '\\') quote = null
      continue
    }
    if (char === "'" || char === '"') {
      quote = char
      out += char
      continue
    }
    if (char === '`') continue
    if (/\s/.test(char)) continue
    out += char
  }
  return out
}

function normalizeClauseList(value: string[] | undefined): string {
  return (value ?? []).map(stripInsignificantFormatting).join(',')
}

function requiresTableRecreate(oldDef: TableDefinition, newDef: TableDefinition): boolean {
  return diffClauses([
    { oldValue: oldDef.engine, newValue: newDef.engine },
    {
      oldValue: normalizeClauseList(oldDef.primaryKey),
      newValue: normalizeClauseList(newDef.primaryKey),
    },
    {
      oldValue: normalizeClauseList(oldDef.orderBy),
      newValue: normalizeClauseList(newDef.orderBy),
    },
    { oldValue: oldDef.partitionBy ?? '', newValue: newDef.partitionBy ?? '' },
    {
      oldValue: normalizeClauseList(oldDef.uniqueKey),
      newValue: normalizeClauseList(newDef.uniqueKey),
    },
  ])
}

interface TableDiffResult {
  operations: MigrationOperation[]
  renameSuggestions: ColumnRenameSuggestion[]
}

function normalizeColumn(column: ColumnDefinition): Omit<ColumnDefinition, 'name' | 'renamedFrom'> {
  const { name: _name, renamedFrom: _renamedFrom, ...rest } = column
  return rest
}

function normalizeColumnWithoutCodec(
  column: ColumnDefinition
): Omit<ColumnDefinition, 'name' | 'renamedFrom' | 'codec'> {
  const { codec: _codec, ...rest } = normalizeColumn(column)
  return rest
}

function isCodecRemoval(oldCol: ColumnDefinition, newCol: ColumnDefinition): boolean {
  if (!oldCol.codec || newCol.codec) return false
  return (
    JSON.stringify(normalizeColumnWithoutCodec(oldCol)) ===
    JSON.stringify(normalizeColumnWithoutCodec(newCol))
  )
}

function renderRenameColumnSuggestionSQL(table: TableDefinition, from: string, to: string): string {
  // IF EXISTS makes the rename idempotent: once it has run (the `from` column is
  // gone), a replay after a partial migration failure is a safe no-op rather
  // than an "unknown identifier" brick. ClickHouse supports the clause.
  return `ALTER TABLE ${table.database}.${table.name} RENAME COLUMN IF EXISTS \`${from}\` TO \`${to}\`;`
}

function inferColumnRenameSuggestions(
  table: TableDefinition,
  addedColumns: ColumnDefinition[],
  droppedColumns: ColumnDefinition[]
): ColumnRenameSuggestion[] {
  if (addedColumns.length === 0 || droppedColumns.length === 0) return []

  const addedBySignature = new Map<string, ColumnDefinition[]>()
  for (const column of addedColumns) {
    const signature = JSON.stringify(normalizeColumn(column))
    const existing = addedBySignature.get(signature) ?? []
    existing.push(column)
    addedBySignature.set(signature, existing)
  }

  const suggestions: ColumnRenameSuggestion[] = []
  for (const oldColumn of droppedColumns) {
    const signature = JSON.stringify(normalizeColumn(oldColumn))
    const candidates = addedBySignature.get(signature)
    if (!candidates || candidates.length !== 1) continue
    const [candidate] = candidates
    if (!candidate) continue
    addedBySignature.delete(signature)

    suggestions.push({
      kind: 'column',
      database: table.database,
      table: table.name,
      from: oldColumn.name,
      to: candidate.name,
      confidence: 'high',
      reason:
        'Dropped and added columns have an identical non-name definition (type, nullability, default, comment).',
      dropOperationKey: `table:${table.database}.${table.name}:column:${oldColumn.name}`,
      addOperationKey: `table:${table.database}.${table.name}:column:${candidate.name}`,
      confirmationSQL: renderRenameColumnSuggestionSQL(table, oldColumn.name, candidate.name),
    })
  }

  return suggestions.sort((a, b) => {
    const tableOrder = `${a.database}.${a.table}`.localeCompare(`${b.database}.${b.table}`)
    if (tableOrder !== 0) return tableOrder
    const fromOrder = a.from.localeCompare(b.from)
    if (fromOrder !== 0) return fromOrder
    return a.to.localeCompare(b.to)
  })
}

function refreshEqual(
  oldRefresh: MaterializedViewRefresh | undefined,
  newRefresh: MaterializedViewRefresh | undefined
): boolean {
  return JSON.stringify(oldRefresh ?? null) === JSON.stringify(newRefresh ?? null)
}

function diffMaterializedView(
  oldDef: MaterializedViewDefinition,
  newDef: MaterializedViewDefinition
): MigrationOperation[] {
  const oldAppend = oldDef.refresh?.append === true
  const newAppend = newDef.refresh?.append === true
  const hasOldRefresh = oldDef.refresh !== undefined
  const hasNewRefresh = newDef.refresh !== undefined

  const structuralChange =
    newDef.as !== oldDef.as ||
    newDef.comment !== oldDef.comment ||
    newDef.to.database !== oldDef.to.database ||
    newDef.to.name !== oldDef.to.name ||
    hasOldRefresh !== hasNewRefresh ||
    oldAppend !== newAppend

  if (structuralChange) {
    return [
      {
        type: 'drop_materialized_view',
        key: definitionKey(newDef),
        risk: 'caution',
        sql: `DROP TABLE IF EXISTS ${newDef.database}.${newDef.name} SYNC;`,
      },
      {
        type: 'create_materialized_view',
        key: definitionKey(newDef),
        risk: 'caution',
        sql: toCreateSQL(newDef),
      },
    ]
  }

  if (hasNewRefresh && !refreshEqual(oldDef.refresh, newDef.refresh)) {
    return [
      {
        type: 'alter_materialized_view_modify_refresh',
        key: `materialized_view:${newDef.database}.${newDef.name}:refresh`,
        risk: 'caution',
        sql: renderAlterModifyRefresh(newDef),
      },
    ]
  }

  return []
}

// Redacts inline SOURCE() credentials for comparison only, mirroring what
// ClickHouse itself does on introspection (`[HIDDEN]`). A definition whose
// only difference is the password must not diff every run — never used to
// render DDL, so the real secret still reaches ClickHouse.
function maskDictionarySecrets(source: string): string {
  return source.replace(/password\s+'(?:[^'\\]|\\.)*'/gi, "password '[HIDDEN]'")
}

function dictionaryComparisonShape(def: DictionaryDefinition) {
  const { source, ...rest } = def
  return { ...rest, source: maskDictionarySecrets(source) }
}

function diffDictionary(
  oldDef: DictionaryDefinition,
  newDef: DictionaryDefinition
): MigrationOperation[] {
  const unchanged =
    JSON.stringify(dictionaryComparisonShape(oldDef)) ===
    JSON.stringify(dictionaryComparisonShape(newDef))
  if (unchanged) return []

  return [
    {
      type: 'create_dictionary',
      key: definitionKey(newDef),
      risk: 'caution',
      sql: renderDictionarySQL(newDef, true),
    },
  ]
}

function diffTables(oldDef: TableDefinition, newDef: TableDefinition): TableDiffResult {
  if (requiresTableRecreate(oldDef, newDef)) {
    return {
      operations: [
        {
          type: 'drop_table',
          key: definitionKey(newDef),
          risk: 'danger',
          sql: `DROP TABLE IF EXISTS ${newDef.database}.${newDef.name};`,
        },
        {
          type: 'create_table',
          key: definitionKey(newDef),
          risk: 'safe',
          sql: toCreateSQL(newDef),
        },
      ],
      renameSuggestions: [],
    }
  }

  const ops: MigrationOperation[] = []
  const columnDiff = diffByName(
    oldDef.columns,
    newDef.columns,
    (column) => column.name,
    (left, right) => JSON.stringify(normalizeColumn(left)) === JSON.stringify(normalizeColumn(right))
  )
  const addedColumns = columnDiff.added
  const droppedColumns = columnDiff.removed
  for (const column of columnDiff.added) {
    ops.push( {
      type: 'alter_table_add_column',
      key: `table:${newDef.database}.${newDef.name}:column:${column.name}`,
      risk: 'safe',
      sql: renderAlterAddColumn(newDef, column),
    })
  }
  for (const { name, oldItem, newItem } of columnDiff.changed) {
    const sql = isCodecRemoval(oldItem, newItem)
      ? renderAlterRemoveCodec(newDef, name)
      : renderAlterModifyColumn(newDef, newItem)
    ops.push( {
      type: 'alter_table_modify_column',
      key: `table:${newDef.database}.${newDef.name}:column:${name}`,
      risk: 'caution',
      sql,
    })
  }
  for (const column of columnDiff.removed) {
    ops.push( {
      type: 'alter_table_drop_column',
      key: `table:${newDef.database}.${newDef.name}:column:${column.name}`,
      risk: 'danger',
      sql: renderAlterDropColumn(newDef, column.name),
    })
  }

  const indexDiff = diffByName(
    oldDef.indexes ?? [],
    newDef.indexes ?? [],
    (index) => index.name,
    (left, right) => JSON.stringify(left) === JSON.stringify(right)
  )
  for (const index of indexDiff.added) {
    ops.push( {
      type: 'alter_table_add_index',
      key: `table:${newDef.database}.${newDef.name}:index:${index.name}`,
      risk: 'caution',
      sql: renderAlterAddIndex(newDef, index),
    })
  }
  for (const { name, newItem } of indexDiff.changed) {
    ops.push( {
      type: 'alter_table_drop_index',
      key: `table:${newDef.database}.${newDef.name}:index:${name}`,
      risk: 'caution',
      sql: renderAlterDropIndex(newDef, name),
    })
    ops.push( {
      type: 'alter_table_add_index',
      key: `table:${newDef.database}.${newDef.name}:index:${name}`,
      risk: 'caution',
      sql: renderAlterAddIndex(newDef, newItem),
    })
  }
  for (const index of indexDiff.removed) {
    ops.push( {
      type: 'alter_table_drop_index',
      key: `table:${newDef.database}.${newDef.name}:index:${index.name}`,
      risk: 'caution',
      sql: renderAlterDropIndex(newDef, index.name),
    })
  }

  const projectionDiff = diffByName(
    oldDef.projections ?? [],
    newDef.projections ?? [],
    (projection) => projection.name,
    (left, right) => JSON.stringify(left) === JSON.stringify(right)
  )
  for (const projection of projectionDiff.added) {
    ops.push( {
      type: 'alter_table_add_projection',
      key: `table:${newDef.database}.${newDef.name}:projection:${projection.name}`,
      risk: 'caution',
      sql: renderAlterAddProjection(newDef, projection),
    })
  }
  for (const { name, newItem } of projectionDiff.changed) {
    ops.push( {
      type: 'alter_table_drop_projection',
      key: `table:${newDef.database}.${newDef.name}:projection:${name}`,
      risk: 'caution',
      sql: renderAlterDropProjection(newDef, name),
    })
    ops.push( {
      type: 'alter_table_add_projection',
      key: `table:${newDef.database}.${newDef.name}:projection:${name}`,
      risk: 'caution',
      sql: renderAlterAddProjection(newDef, newItem),
    })
  }
  for (const projection of projectionDiff.removed) {
    ops.push( {
      type: 'alter_table_drop_projection',
      key: `table:${newDef.database}.${newDef.name}:projection:${projection.name}`,
      risk: 'caution',
      sql: renderAlterDropProjection(newDef, projection.name),
    })
  }

  const settingDiff = diffSettings(oldDef.settings ?? {}, newDef.settings ?? {})
  for (const change of settingDiff.changes) {
    if (change.kind === 'reset') {
      ops.push( {
        type: 'alter_table_reset_setting',
        key: `table:${newDef.database}.${newDef.name}:setting:${change.key}`,
        risk: 'caution',
        sql: renderAlterResetSetting(newDef, change.key),
      })
      continue
    }
    ops.push( {
      type: 'alter_table_modify_setting',
      key: `table:${newDef.database}.${newDef.name}:setting:${change.key}`,
      risk: 'caution',
      sql: renderAlterModifySetting(newDef, change.key, change.value),
    })
  }

  if ((oldDef.ttl ?? '') !== (newDef.ttl ?? '')) {
    ops.push( {
      type: 'alter_table_modify_ttl',
      key: `table:${newDef.database}.${newDef.name}:ttl`,
      risk: 'caution',
      sql: renderAlterModifyTTL(newDef, newDef.ttl),
    })
  }

  return {
    operations: ops,
    renameSuggestions: inferColumnRenameSuggestions(newDef, addedColumns, droppedColumns),
  }
}

/**
 * Creation depth of each refreshable materialized view, derived from its
 * `refresh.dependsOn` edges (#41). A view declared `DEPENDS ON other_mv` must
 * be created AFTER `other_mv` exists, so ordering create operations by
 * ascending depth puts every dependency before the views that depend on it.
 * Names alone are unsafe: a dependent MV whose name sorts first would otherwise
 * be created first and fail.
 */
function materializedViewCreationDepth(
  definitions: SchemaDefinition[],
  byKey: Map<string, SchemaDefinition>
): Map<string, number> {
  const depth = new Map<string, number>()
  const visiting = new Set<string>()

  const compute = (key: string): number => {
    const cached = depth.get(key)
    if (cached !== undefined) return cached
    // A dependency cycle has no valid creation order; stop recursing and let
    // the alphabetical tiebreak apply rather than looping forever.
    if (visiting.has(key)) return 0
    const def = byKey.get(key)
    if (!def || def.kind !== 'materialized_view') {
      depth.set(key, 0)
      return 0
    }
    visiting.add(key)
    let result = 0
    for (const dep of def.refresh?.dependsOn ?? []) {
      const depKey = `materialized_view:${dep.database}.${dep.name}`
      if (byKey.has(depKey)) result = Math.max(result, 1 + compute(depKey))
    }
    visiting.delete(key)
    depth.set(key, result)
    return result
  }

  for (const def of definitions) {
    if (def.kind === 'materialized_view') compute(definitionKey(def))
  }
  return depth
}

export function planDiff(oldDefinitions: SchemaDefinition[], newDefinitions: SchemaDefinition[]): MigrationPlan {
  const oldCanonical = canonicalizeDefinitions(oldDefinitions)
  const newCanonical = canonicalizeDefinitions(newDefinitions)
  assertValidDefinitions(newCanonical)
  const oldMap = createMap(oldCanonical)
  const newMap = createMap(newCanonical)
  const operations: MigrationOperation[] = []
  const renameSuggestions: ColumnRenameSuggestion[] = []
  const databasesToCreate = new Set<string>()

  for (const oldDef of oldCanonical) {
    if (newMap.has(definitionKey(oldDef))) continue
    pushDropOperation(operations, oldDef, 'danger')
  }

  for (const newDef of newCanonical) {
    const key = definitionKey(newDef)
    const oldDef = oldMap.get(key)
    if (!oldDef) continue

    if (newDef.kind === 'table' && oldDef.kind === 'table') {
      const diffResult = diffTables(oldDef, newDef)
      operations.push(...diffResult.operations)
      renameSuggestions.push(...diffResult.renameSuggestions)
      continue
    }

    if (newDef.kind === oldDef.kind && newDef.kind === 'view' && oldDef.kind === 'view') {
      if (newDef.as !== oldDef.as || newDef.comment !== oldDef.comment) {
        pushDropOperation(operations, oldDef, 'caution')
        pushCreateOperation(operations, newDef, 'caution')
      }
      continue
    }

    if (
      newDef.kind === oldDef.kind &&
      newDef.kind === 'materialized_view' &&
      oldDef.kind === 'materialized_view'
    ) {
      const mvOps = diffMaterializedView(oldDef, newDef)
      operations.push(...mvOps)
      continue
    }

    if (newDef.kind === oldDef.kind && newDef.kind === 'dictionary' && oldDef.kind === 'dictionary') {
      operations.push(...diffDictionary(oldDef, newDef))
      continue
    }

    if (newDef.kind !== oldDef.kind) {
      pushDropOperation(operations, oldDef, 'danger')
    }
  }

  for (const newDef of newCanonical) {
    const key = definitionKey(newDef)
    const oldDef = oldMap.get(key)
    if (oldDef && oldDef.kind === newDef.kind) continue

    databasesToCreate.add(newDef.database)
    pushCreateOperation(operations, newDef, 'safe')
  }

  for (const database of [...databasesToCreate].sort((a, b) => a.localeCompare(b))) {
    pushCreateDatabaseOperation(operations, database, 'safe')
  }

  const mvCreationDepth = materializedViewCreationDepth(newCanonical, newMap)
  operations.sort((a, b) => {
    const rank = (op: MigrationOperation): number => {
      if (op.type.startsWith('drop_')) return 0
      if (op.type === 'alter_materialized_view_modify_refresh') return 1
      if (op.type.startsWith('alter_')) return 1
      if (op.type === 'create_database') return 2
      if (op.type === 'create_table') return 3
      if (op.type === 'create_view') return 4
      return 5
    }
    const rankOrder = rank(a) - rank(b)
    if (rankOrder !== 0) return rankOrder
    // Within materialized-view creates, order a DEPENDS ON target before the
    // view that depends on it (#41), then fall back to a stable name order.
    if (a.type === 'create_materialized_view' && b.type === 'create_materialized_view') {
      const depthOrder = (mvCreationDepth.get(a.key) ?? 0) - (mvCreationDepth.get(b.key) ?? 0)
      if (depthOrder !== 0) return depthOrder
    }
    return a.key.localeCompare(b.key)
  })

  const riskSummary: Record<RiskLevel, number> = { safe: 0, caution: 0, danger: 0 }
  for (const operation of operations) {
    riskSummary[operation.risk] = (riskSummary[operation.risk] ?? 0) + 1
  }

  return {
    operations,
    riskSummary,
    renameSuggestions: renameSuggestions.sort((a, b) => {
      const tableOrder = `${a.database}.${a.table}`.localeCompare(`${b.database}.${b.table}`)
      if (tableOrder !== 0) return tableOrder
      const fromOrder = a.from.localeCompare(b.from)
      if (fromOrder !== 0) return fromOrder
      return a.to.localeCompare(b.to)
    }),
  }
}
