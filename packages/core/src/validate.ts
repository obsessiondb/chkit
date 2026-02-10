import { definitionKey } from './canonical.js'
import type {
  SchemaDefinition,
  TableDefinition,
  ValidationIssue,
  ValidationIssueCode,
} from './model.js'
import { ChxValidationError as ValidationError } from './model.js'

function pushValidationIssue(
  issues: ValidationIssue[],
  def: SchemaDefinition,
  code: ValidationIssueCode,
  message: string
): void {
  issues.push({
    code,
    kind: def.kind,
    database: def.database,
    name: def.name,
    message,
  })
}

function validateTableDefinition(def: TableDefinition, issues: ValidationIssue[]): void {
  const columnSeen = new Set<string>()
  const columnSet = new Set<string>()
  for (const column of def.columns) {
    if (columnSeen.has(column.name)) {
      pushValidationIssue(
        issues,
        def,
        'duplicate_column_name',
        `Table ${def.database}.${def.name} has duplicate column name "${column.name}"`
      )
      continue
    }
    columnSeen.add(column.name)
    columnSet.add(column.name)
  }

  const indexSeen = new Set<string>()
  for (const index of def.indexes ?? []) {
    if (indexSeen.has(index.name)) {
      pushValidationIssue(
        issues,
        def,
        'duplicate_index_name',
        `Table ${def.database}.${def.name} has duplicate index name "${index.name}"`
      )
      continue
    }
    indexSeen.add(index.name)
  }

  const projectionSeen = new Set<string>()
  for (const projection of def.projections ?? []) {
    if (projectionSeen.has(projection.name)) {
      pushValidationIssue(
        issues,
        def,
        'duplicate_projection_name',
        `Table ${def.database}.${def.name} has duplicate projection name "${projection.name}"`
      )
      continue
    }
    projectionSeen.add(projection.name)
  }

  for (const column of def.primaryKey) {
    if (!columnSet.has(column)) {
      pushValidationIssue(
        issues,
        def,
        'primary_key_missing_column',
        `Table ${def.database}.${def.name} primaryKey references missing column "${column}"`
      )
    }
  }

  for (const column of def.orderBy) {
    if (!columnSet.has(column)) {
      pushValidationIssue(
        issues,
        def,
        'order_by_missing_column',
        `Table ${def.database}.${def.name} orderBy references missing column "${column}"`
      )
    }
  }
}

export function validateDefinitions(definitions: SchemaDefinition[]): ValidationIssue[] {
  const issues: ValidationIssue[] = []
  const objectKeys = new Set<string>()
  for (const def of definitions) {
    const key = definitionKey(def)
    if (objectKeys.has(key)) {
      pushValidationIssue(
        issues,
        def,
        'duplicate_object_name',
        `Duplicate schema object definition "${def.kind}:${def.database}.${def.name}"`
      )
      continue
    }
    objectKeys.add(key)

    if (def.kind === 'table') {
      validateTableDefinition(def, issues)
    }
  }

  return issues
}

export function assertValidDefinitions(definitions: SchemaDefinition[]): void {
  const issues = validateDefinitions(definitions)
  if (issues.length > 0) throw new ValidationError(issues)
}
