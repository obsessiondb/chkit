import { canonicalizeDefinitions, definitionKey } from './canonical.js'
import { diffByName, diffClauses, diffSettings } from './diff-primitives.js'
import type {
  ColumnDefinition,
  ColumnRenameSuggestion,
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
  renderAlterModifySetting,
  renderAlterModifyTTL,
  renderAlterResetSetting,
  toCreateSQL,
} from './sql.js'
import { assertValidDefinitions } from './validate.js'

function createMap(definitions: SchemaDefinition[]): Map<string, SchemaDefinition> {
  return new Map(definitions.map((def) => [definitionKey(def), def]))
}

function addOperation(operations: MigrationOperation[], operation: MigrationOperation): void {
  operations.push(operation)
}

function pushDropOperation(
  operations: MigrationOperation[],
  def: SchemaDefinition,
  risk: RiskLevel = 'danger'
): void {
  if (def.kind === 'table') {
    addOperation(operations, {
      type: 'drop_table',
      key: definitionKey(def),
      risk,
      sql: `DROP TABLE IF EXISTS ${def.database}.${def.name};`,
    })
    return
  }
  if (def.kind === 'view') {
    addOperation(operations, {
      type: 'drop_view',
      key: definitionKey(def),
      risk,
      sql: `DROP VIEW IF EXISTS ${def.database}.${def.name};`,
    })
    return
  }
  addOperation(operations, {
    type: 'drop_materialized_view',
    key: definitionKey(def),
    risk,
    sql: `DROP VIEW IF EXISTS ${def.database}.${def.name};`,
  })
}

function pushCreateOperation(
  operations: MigrationOperation[],
  def: SchemaDefinition,
  risk: RiskLevel = 'safe'
): void {
  if (def.kind === 'table') {
    addOperation(operations, {
      type: 'create_table',
      key: definitionKey(def),
      risk,
      sql: toCreateSQL(def),
    })
    return
  }
  if (def.kind === 'view') {
    addOperation(operations, {
      type: 'create_view',
      key: definitionKey(def),
      risk,
      sql: toCreateSQL(def),
    })
    return
  }
  addOperation(operations, {
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
  addOperation(operations, {
    type: 'create_database',
    key: `database:${database}`,
    risk,
    sql: `CREATE DATABASE IF NOT EXISTS ${database};`,
  })
}

function normalizeClauseList(value: string[] | undefined): string {
  return (value ?? []).join(',')
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

function renderRenameColumnSuggestionSQL(table: TableDefinition, from: string, to: string): string {
  return `ALTER TABLE ${table.database}.${table.name} RENAME COLUMN \`${from}\` TO \`${to}\`;`
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
    addOperation(ops, {
      type: 'alter_table_add_column',
      key: `table:${newDef.database}.${newDef.name}:column:${column.name}`,
      risk: 'safe',
      sql: renderAlterAddColumn(newDef, column),
    })
  }
  for (const { name, newItem } of columnDiff.changed) {
    addOperation(ops, {
      type: 'alter_table_modify_column',
      key: `table:${newDef.database}.${newDef.name}:column:${name}`,
      risk: 'caution',
      sql: renderAlterModifyColumn(newDef, newItem),
    })
  }
  for (const column of columnDiff.removed) {
    addOperation(ops, {
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
    addOperation(ops, {
      type: 'alter_table_add_index',
      key: `table:${newDef.database}.${newDef.name}:index:${index.name}`,
      risk: 'caution',
      sql: renderAlterAddIndex(newDef, index),
    })
  }
  for (const { name, newItem } of indexDiff.changed) {
    addOperation(ops, {
      type: 'alter_table_drop_index',
      key: `table:${newDef.database}.${newDef.name}:index:${name}`,
      risk: 'caution',
      sql: renderAlterDropIndex(newDef, name),
    })
    addOperation(ops, {
      type: 'alter_table_add_index',
      key: `table:${newDef.database}.${newDef.name}:index:${name}`,
      risk: 'caution',
      sql: renderAlterAddIndex(newDef, newItem),
    })
  }
  for (const index of indexDiff.removed) {
    addOperation(ops, {
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
    addOperation(ops, {
      type: 'alter_table_add_projection',
      key: `table:${newDef.database}.${newDef.name}:projection:${projection.name}`,
      risk: 'caution',
      sql: renderAlterAddProjection(newDef, projection),
    })
  }
  for (const { name, newItem } of projectionDiff.changed) {
    addOperation(ops, {
      type: 'alter_table_drop_projection',
      key: `table:${newDef.database}.${newDef.name}:projection:${name}`,
      risk: 'caution',
      sql: renderAlterDropProjection(newDef, name),
    })
    addOperation(ops, {
      type: 'alter_table_add_projection',
      key: `table:${newDef.database}.${newDef.name}:projection:${name}`,
      risk: 'caution',
      sql: renderAlterAddProjection(newDef, newItem),
    })
  }
  for (const projection of projectionDiff.removed) {
    addOperation(ops, {
      type: 'alter_table_drop_projection',
      key: `table:${newDef.database}.${newDef.name}:projection:${projection.name}`,
      risk: 'caution',
      sql: renderAlterDropProjection(newDef, projection.name),
    })
  }

  const settingDiff = diffSettings(oldDef.settings ?? {}, newDef.settings ?? {})
  for (const change of settingDiff.changes) {
    if (change.kind === 'reset') {
      addOperation(ops, {
        type: 'alter_table_reset_setting',
        key: `table:${newDef.database}.${newDef.name}:setting:${change.key}`,
        risk: 'caution',
        sql: renderAlterResetSetting(newDef, change.key),
      })
      continue
    }
    addOperation(ops, {
      type: 'alter_table_modify_setting',
      key: `table:${newDef.database}.${newDef.name}:setting:${change.key}`,
      risk: 'caution',
      sql: renderAlterModifySetting(newDef, change.key, change.value),
    })
  }

  if ((oldDef.ttl ?? '') !== (newDef.ttl ?? '')) {
    addOperation(ops, {
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
      const changed =
        newDef.as !== oldDef.as ||
        newDef.comment !== oldDef.comment ||
        newDef.to.database !== oldDef.to.database ||
        newDef.to.name !== oldDef.to.name
      if (changed) {
        pushDropOperation(operations, oldDef, 'caution')
        pushCreateOperation(operations, newDef, 'caution')
      }
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

  operations.sort((a, b) => {
    const rank = (op: MigrationOperation): number => {
      if (op.type.startsWith('drop_')) return 0
      if (op.type.startsWith('alter_')) return 1
      if (op.type === 'create_database') return 2
      return 3
    }
    const rankOrder = rank(a) - rank(b)
    if (rankOrder !== 0) return rankOrder
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
