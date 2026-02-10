import { canonicalizeDefinitions, definitionKey } from './canonical.js'
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
  if (oldDef.engine !== newDef.engine) return true
  if (normalizeClauseList(oldDef.primaryKey) !== normalizeClauseList(newDef.primaryKey)) return true
  if (normalizeClauseList(oldDef.orderBy) !== normalizeClauseList(newDef.orderBy)) return true
  if ((oldDef.partitionBy ?? '') !== (newDef.partitionBy ?? '')) return true
  if (normalizeClauseList(oldDef.uniqueKey) !== normalizeClauseList(newDef.uniqueKey)) return true
  return false
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
  const addedColumns: ColumnDefinition[] = []
  const droppedColumns: ColumnDefinition[] = []

  const oldColumns = new Map(oldDef.columns.map((c) => [c.name, c]))
  const newColumnNames = new Set(newDef.columns.map((c) => c.name))
  for (const column of newDef.columns) {
    const oldColumn = oldColumns.get(column.name)
    if (!oldColumn) {
      addedColumns.push(column)
      addOperation(ops, {
        type: 'alter_table_add_column',
        key: `table:${newDef.database}.${newDef.name}:column:${column.name}`,
        risk: 'safe',
        sql: renderAlterAddColumn(newDef, column),
      })
      continue
    }

    if (JSON.stringify(normalizeColumn(oldColumn)) !== JSON.stringify(normalizeColumn(column))) {
      addOperation(ops, {
        type: 'alter_table_modify_column',
        key: `table:${newDef.database}.${newDef.name}:column:${column.name}`,
        risk: 'caution',
        sql: renderAlterModifyColumn(newDef, column),
      })
    }
  }

  for (const oldColumn of oldDef.columns) {
    if (newColumnNames.has(oldColumn.name)) continue
    droppedColumns.push(oldColumn)
    addOperation(ops, {
      type: 'alter_table_drop_column',
      key: `table:${newDef.database}.${newDef.name}:column:${oldColumn.name}`,
      risk: 'danger',
      sql: renderAlterDropColumn(newDef, oldColumn.name),
    })
  }

  const oldIndexes = new Map((oldDef.indexes ?? []).map((idx) => [idx.name, idx]))
  const newIndexNames = new Set((newDef.indexes ?? []).map((idx) => idx.name))
  for (const idx of newDef.indexes ?? []) {
    const oldIdx = oldIndexes.get(idx.name)
    if (!oldIdx) {
      addOperation(ops, {
        type: 'alter_table_add_index',
        key: `table:${newDef.database}.${newDef.name}:index:${idx.name}`,
        risk: 'caution',
        sql: renderAlterAddIndex(newDef, idx),
      })
      continue
    }

    if (JSON.stringify(oldIdx) !== JSON.stringify(idx)) {
      addOperation(ops, {
        type: 'alter_table_drop_index',
        key: `table:${newDef.database}.${newDef.name}:index:${idx.name}`,
        risk: 'caution',
        sql: renderAlterDropIndex(newDef, idx.name),
      })
      addOperation(ops, {
        type: 'alter_table_add_index',
        key: `table:${newDef.database}.${newDef.name}:index:${idx.name}`,
        risk: 'caution',
        sql: renderAlterAddIndex(newDef, idx),
      })
    }
  }

  for (const oldIdx of oldDef.indexes ?? []) {
    if (newIndexNames.has(oldIdx.name)) continue
    addOperation(ops, {
      type: 'alter_table_drop_index',
      key: `table:${newDef.database}.${newDef.name}:index:${oldIdx.name}`,
      risk: 'caution',
      sql: renderAlterDropIndex(newDef, oldIdx.name),
    })
  }

  const oldProjections = new Map((oldDef.projections ?? []).map((p) => [p.name, p]))
  const newProjectionNames = new Set((newDef.projections ?? []).map((p) => p.name))
  for (const projection of newDef.projections ?? []) {
    const oldProjection = oldProjections.get(projection.name)
    if (!oldProjection) {
      addOperation(ops, {
        type: 'alter_table_add_projection',
        key: `table:${newDef.database}.${newDef.name}:projection:${projection.name}`,
        risk: 'caution',
        sql: renderAlterAddProjection(newDef, projection),
      })
      continue
    }

    if (JSON.stringify(oldProjection) !== JSON.stringify(projection)) {
      addOperation(ops, {
        type: 'alter_table_drop_projection',
        key: `table:${newDef.database}.${newDef.name}:projection:${projection.name}`,
        risk: 'caution',
        sql: renderAlterDropProjection(newDef, projection.name),
      })
      addOperation(ops, {
        type: 'alter_table_add_projection',
        key: `table:${newDef.database}.${newDef.name}:projection:${projection.name}`,
        risk: 'caution',
        sql: renderAlterAddProjection(newDef, projection),
      })
    }
  }

  for (const oldProjection of oldDef.projections ?? []) {
    if (newProjectionNames.has(oldProjection.name)) continue
    addOperation(ops, {
      type: 'alter_table_drop_projection',
      key: `table:${newDef.database}.${newDef.name}:projection:${oldProjection.name}`,
      risk: 'caution',
      sql: renderAlterDropProjection(newDef, oldProjection.name),
    })
  }

  const oldSettings = oldDef.settings ?? {}
  const newSettings = newDef.settings ?? {}
  const allSettings = [...new Set([...Object.keys(oldSettings), ...Object.keys(newSettings)])].sort()
  for (const key of allSettings) {
    const hadValue = key in oldSettings
    const nextValue = newSettings[key]
    if (nextValue === undefined) {
      if (hadValue) {
        addOperation(ops, {
          type: 'alter_table_reset_setting',
          key: `table:${newDef.database}.${newDef.name}:setting:${key}`,
          risk: 'caution',
          sql: renderAlterResetSetting(newDef, key),
        })
      }
      continue
    }

    if (!hadValue || oldSettings[key] !== nextValue) {
      addOperation(ops, {
        type: 'alter_table_modify_setting',
        key: `table:${newDef.database}.${newDef.name}:setting:${key}`,
        risk: 'caution',
        sql: renderAlterModifySetting(newDef, key, nextValue),
      })
    }
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
