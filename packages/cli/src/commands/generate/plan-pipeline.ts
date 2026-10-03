import type {
  ColumnRenameSuggestion,
  MigrationOperation,
  MigrationPlan,
  RiskLevel,
  SchemaDefinition,
} from '@chkit/core'
import { quoteIdentifier, renderQualifiedName } from '@chkit/core'

import type { ColumnRenameMapping, DictionaryRenameMapping, TableRenameMapping } from './rename-mappings.js'

// Drops and object creates keep the order planDiff gave them, which is
// dependency-aware (#231); the classes this pipeline adds to sort by key.
const DROP_RANK = 0
const CREATE_RANK = 4

export function applySelectedRenameSuggestions(
  plan: MigrationPlan,
  selectedSuggestions: ColumnRenameSuggestion[]
): MigrationPlan {
  if (selectedSuggestions.length === 0) return plan

  const operationKeysToRemove = new Set<string>()
  const renameOperations: MigrationOperation[] = []

  for (const suggestion of selectedSuggestions) {
    operationKeysToRemove.add(suggestion.dropOperationKey)
    operationKeysToRemove.add(suggestion.addOperationKey)
    renameOperations.push({
      type: 'alter_table_rename_column',
      key: `table:${suggestion.database}.${suggestion.table}:column_rename:${suggestion.from}:${suggestion.to}`,
      risk: 'caution',
      sql: suggestion.confirmationSQL,
    })
  }

  const operations = mergeOperations(
    plan.operations.filter((operation) => !operationKeysToRemove.has(operation.key)),
    renameOperations
  )

  return {
    operations,
    riskSummary: summarizeRisk(operations),
    renameSuggestions: plan.renameSuggestions.filter(
      (suggestion) =>
        !selectedSuggestions.some(
          (selected) =>
            selected.database === suggestion.database &&
            selected.table === suggestion.table &&
            selected.from === suggestion.from &&
            selected.to === suggestion.to
        )
    ),
  }
}

export function applyExplicitTableRenames(
  plan: MigrationPlan,
  mappings: TableRenameMapping[]
): MigrationPlan {
  if (mappings.length === 0) return plan

  const operationKeysToRemove = new Set<string>()
  const extraOperations: MigrationOperation[] = []
  const createDatabaseOps = new Set(
    plan.operations.filter((operation) => operation.type === 'create_database').map((operation) => operation.key)
  )

  for (const mapping of mappings) {
    operationKeysToRemove.add(`table:${mapping.oldDatabase}.${mapping.oldName}`)
    operationKeysToRemove.add(`table:${mapping.newDatabase}.${mapping.newName}`)
    if (mapping.oldDatabase !== mapping.newDatabase) {
      const dbKey = `database:${mapping.newDatabase}`
      if (!createDatabaseOps.has(dbKey)) {
        extraOperations.push({
          type: 'create_database',
          key: dbKey,
          risk: 'safe',
          sql: `CREATE DATABASE IF NOT EXISTS ${mapping.newDatabase};`,
        })
        createDatabaseOps.add(dbKey)
      }
    }
    extraOperations.push({
      type: 'alter_table_rename_table',
      key: `table:${mapping.newDatabase}.${mapping.newName}:rename_table`,
      risk: 'caution',
      sql: `RENAME TABLE IF EXISTS ${renderQualifiedName(mapping.oldDatabase, mapping.oldName)} TO ${renderQualifiedName(mapping.newDatabase, mapping.newName)};`,
    })
  }

  const operations = mergeOperations(
    plan.operations.filter((operation) => !operationKeysToRemove.has(operation.key)),
    extraOperations
  )

  return {
    operations,
    riskSummary: summarizeRisk(operations),
    renameSuggestions: plan.renameSuggestions,
  }
}

export function applyExplicitDictionaryRenames(
  plan: MigrationPlan,
  mappings: DictionaryRenameMapping[]
): MigrationPlan {
  if (mappings.length === 0) return plan

  const operationKeysToRemove = new Set<string>()
  const extraOperations: MigrationOperation[] = []
  const createDatabaseOps = new Set(
    plan.operations.filter((operation) => operation.type === 'create_database').map((operation) => operation.key)
  )

  for (const mapping of mappings) {
    operationKeysToRemove.add(`dictionary:${mapping.oldDatabase}.${mapping.oldName}`)
    operationKeysToRemove.add(`dictionary:${mapping.newDatabase}.${mapping.newName}`)
    if (mapping.oldDatabase !== mapping.newDatabase) {
      const dbKey = `database:${mapping.newDatabase}`
      if (!createDatabaseOps.has(dbKey)) {
        extraOperations.push({
          type: 'create_database',
          key: dbKey,
          risk: 'safe',
          sql: `CREATE DATABASE IF NOT EXISTS ${mapping.newDatabase};`,
        })
        createDatabaseOps.add(dbKey)
      }
    }
    extraOperations.push({
      type: 'rename_dictionary',
      key: `dictionary:${mapping.newDatabase}.${mapping.newName}:rename_dictionary`,
      risk: 'caution',
      sql: `RENAME DICTIONARY IF EXISTS ${renderQualifiedName(mapping.oldDatabase, mapping.oldName)} TO ${renderQualifiedName(mapping.newDatabase, mapping.newName)};`,
    })
  }

  const operations = mergeOperations(
    plan.operations.filter((operation) => !operationKeysToRemove.has(operation.key)),
    extraOperations
  )

  return {
    operations,
    riskSummary: summarizeRisk(operations),
    renameSuggestions: plan.renameSuggestions,
  }
}

export function buildExplicitColumnRenameSuggestions(
  plan: MigrationPlan,
  mappings: ColumnRenameMapping[]
): ColumnRenameSuggestion[] {
  if (mappings.length === 0) return []
  const operationKeys = new Set(plan.operations.map((operation) => operation.key))

  const suggestions: ColumnRenameSuggestion[] = []
  for (const mapping of mappings) {
    const dropOperationKey = `table:${mapping.database}.${mapping.table}:column:${mapping.from}`
    const addOperationKey = `table:${mapping.database}.${mapping.table}:column:${mapping.to}`
    if (!operationKeys.has(dropOperationKey) || !operationKeys.has(addOperationKey)) continue
    suggestions.push({
      kind: 'column',
      database: mapping.database,
      table: mapping.table,
      from: mapping.from,
      to: mapping.to,
      confidence: 'high',
      reason:
        mapping.source === 'cli'
          ? 'Explicitly confirmed by --rename-column mapping.'
          : 'Explicitly confirmed by schema metadata (renamedFrom).',
      dropOperationKey,
      addOperationKey,
      confirmationSQL: `ALTER TABLE ${renderQualifiedName(mapping.database, mapping.table)} RENAME COLUMN IF EXISTS ${quoteIdentifier(mapping.from)} TO ${quoteIdentifier(mapping.to)};`,
    })
  }

  return suggestions
}

export function assertCliColumnMappingsResolvable(
  cliMappings: ColumnRenameMapping[],
  plan: MigrationPlan,
  nextDefinitions: SchemaDefinition[]
): void {
  for (const mapping of cliMappings) {
    if (!tableExists(nextDefinitions, mapping.database, mapping.table)) {
      throw new Error(
        `--rename-column mapping "${mapping.database}.${mapping.table}.${mapping.from}=${mapping.to}" is invalid: target table is missing from current schema.`
      )
    }
    const hasDrop = plan.operations.some(
      (operation) =>
        operation.type === 'alter_table_drop_column' &&
        operation.key === `table:${mapping.database}.${mapping.table}:column:${mapping.from}`
    )
    const hasAdd = plan.operations.some(
      (operation) =>
        operation.type === 'alter_table_add_column' &&
        operation.key === `table:${mapping.database}.${mapping.table}:column:${mapping.to}`
    )
    if (hasDrop && hasAdd) continue
    throw new Error(
      `--rename-column mapping "${mapping.database}.${mapping.table}.${mapping.from}=${mapping.to}" is invalid: planner did not find both matching drop and add operations.`
    )
  }
}

/**
 * Combines the planner's operations (minus the ones a rename replaces) with the
 * rename/create_database operations added here. Drops and object creates keep
 * the planner's order, which is dependency-aware (#231); the classes this
 * pipeline adds to are ordered by key, and operations that share a key keep
 * the planner's order, so a column's `REMOVE DEFAULT` still runs before its
 * `MODIFY COLUMN`.
 */
function mergeOperations(kept: MigrationOperation[], added: MigrationOperation[]): MigrationOperation[] {
  return [...kept, ...added]
    .map((operation, index) => ({ operation, index }))
    .sort((a, b) => {
      const rank = rankOperation(a.operation)
      const rankOrder = rank - rankOperation(b.operation)
      if (rankOrder !== 0) return rankOrder
      if (rank === DROP_RANK || rank === CREATE_RANK) return a.index - b.index
      return a.operation.key.localeCompare(b.operation.key) || a.index - b.index
    })
    .map(({ operation }) => operation)
}

function rankOperation(op: MigrationOperation): number {
  if (op.type.startsWith('drop_')) return DROP_RANK
  if (op.type === 'create_database') return 1
  if (op.type === 'alter_table_rename_table' || op.type === 'rename_dictionary') return 2
  if (op.type.startsWith('alter_')) return 3
  return CREATE_RANK
}

function summarizeRisk(operations: MigrationOperation[]): Record<RiskLevel, number> {
  const riskSummary: Record<RiskLevel, number> = { safe: 0, caution: 0, danger: 0 }
  for (const operation of operations) {
    riskSummary[operation.risk] = (riskSummary[operation.risk] ?? 0) + 1
  }
  return riskSummary
}

function tableExists(definitions: SchemaDefinition[], database: string, name: string): boolean {
  return definitions.some(
    (definition) => definition.kind === 'table' && definition.database === database && definition.name === name
  )
}
