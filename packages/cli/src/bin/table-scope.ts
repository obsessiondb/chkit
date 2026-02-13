import type {
  MigrationOperation,
  MigrationPlan,
  SchemaDefinition,
  TableDefinition,
} from '@chx/core'

interface ParsedTableSelector {
  database?: string
  mode: 'exact' | 'prefix'
  value: string
}

export interface TableScope {
  enabled: boolean
  selector?: string
  matchedTables: string[]
  matchCount: number
}

export interface TableScopeFilterResult {
  plan: MigrationPlan
  omittedOperationCount: number
}

interface TableRenameMapping {
  oldDatabase: string
  oldName: string
  newDatabase: string
  newName: string
}

export function tableKey(database: string, name: string): string {
  return `${database}.${name}`
}

export function tableKeysFromDefinitions(definitions: SchemaDefinition[]): string[] {
  return [...new Set(definitions.filter((def): def is TableDefinition => def.kind === 'table').map((def) => tableKey(def.database, def.name)))].sort((a, b) => a.localeCompare(b))
}

export function parseTableSelector(input: string): ParsedTableSelector {
  const selector = input.trim()
  if (!selector) {
    throw new Error('Invalid --table selector "". Expected <table>, <table_prefix*>, <database.table>, or <database.table_prefix*>.')
  }

  const dot = selector.indexOf('.')
  const [database, tableToken] =
    dot === -1
      ? [undefined, selector]
      : [selector.slice(0, dot).trim(), selector.slice(dot + 1).trim()]

  if (database !== undefined && (database.length === 0 || database.includes('*'))) {
    throw new Error(
      `Invalid --table selector "${selector}". Database qualifier must be non-empty and cannot contain "*".`
    )
  }

  if (!tableToken || tableToken === '*') {
    throw new Error(
      `Invalid --table selector "${selector}". A bare "*" is not supported; use an exact table or trailing wildcard prefix.`
    )
  }

  const wildcardCount = [...tableToken].filter((char) => char === '*').length
  if (wildcardCount > 1 || (wildcardCount === 1 && !tableToken.endsWith('*'))) {
    throw new Error(
      `Invalid --table selector "${selector}". "*" is only allowed as a trailing suffix (for example, events_*).`
    )
  }

  if (tableToken.slice(0, -1).includes('*')) {
    throw new Error(
      `Invalid --table selector "${selector}". "*" is only allowed as a trailing suffix (for example, events_*).`
    )
  }

  if (tableToken.endsWith('*')) {
    const value = tableToken.slice(0, -1)
    if (!value) {
      throw new Error(
        `Invalid --table selector "${selector}". A bare "*" is not supported; use an exact table or trailing wildcard prefix.`
      )
    }

    return {
      database,
      mode: 'prefix',
      value,
    }
  }

  return {
    database,
    mode: 'exact',
    value: tableToken,
  }
}

export function resolveTableScope(selector: string | undefined, availableTables: string[]): TableScope {
  if (!selector) {
    return {
      enabled: false,
      matchedTables: [],
      matchCount: 0,
    }
  }

  const parsed = parseTableSelector(selector)
  const normalized = [...new Set(availableTables)].sort((a, b) => a.localeCompare(b))
  const matchedTables = normalized.filter((candidate) => {
    const dot = candidate.indexOf('.')
    if (dot <= 0 || dot === candidate.length - 1) return false
    const database = candidate.slice(0, dot)
    const table = candidate.slice(dot + 1)

    if (parsed.database && parsed.database !== database) return false
    if (parsed.mode === 'exact') return table === parsed.value
    return table.startsWith(parsed.value)
  })

  return {
    enabled: true,
    selector,
    matchedTables,
    matchCount: matchedTables.length,
  }
}

export function tableKeyFromOperationKey(operationKey: string): string | null {
  if (!operationKey.startsWith('table:')) return null
  const target = operationKey.slice('table:'.length)
  const nextSegment = target.indexOf(':')
  return nextSegment === -1 ? target : target.slice(0, nextSegment)
}

export function databaseKeyFromOperationKey(operationKey: string): string | null {
  if (!operationKey.startsWith('database:')) return null
  return operationKey.slice('database:'.length)
}

export function filterPlanByTableScope(
  plan: MigrationPlan,
  matchedTables: ReadonlySet<string>,
  options: { renameMappings?: TableRenameMapping[] } = {}
): TableScopeFilterResult {
  if (matchedTables.size === 0) {
    return {
      plan: {
        operations: [],
        renameSuggestions: [],
        riskSummary: { safe: 0, caution: 0, danger: 0 },
      },
      omittedOperationCount: plan.operations.length,
    }
  }

  const selectedTables = new Set(matchedTables)
  for (const mapping of options.renameMappings ?? []) {
    const oldKey = tableKey(mapping.oldDatabase, mapping.oldName)
    const newKey = tableKey(mapping.newDatabase, mapping.newName)
    if (selectedTables.has(oldKey) || selectedTables.has(newKey)) {
      selectedTables.add(oldKey)
      selectedTables.add(newKey)
    }
  }

  const selectedDatabases = new Set([...selectedTables].map((value) => value.split('.')[0] ?? ''))
  const operations = plan.operations.filter((operation) => {
    const targetTable = tableKeyFromOperationKey(operation.key)
    if (targetTable) return selectedTables.has(targetTable)

    const targetDatabase = databaseKeyFromOperationKey(operation.key)
    if (targetDatabase) return selectedDatabases.has(targetDatabase)

    return false
  })

  const renameSuggestions = plan.renameSuggestions.filter((suggestion) =>
    selectedTables.has(tableKey(suggestion.database, suggestion.table))
  )

  const riskSummary = operations.reduce(
    (summary, operation) => {
      summary[operation.risk] += 1
      return summary
    },
    { safe: 0, caution: 0, danger: 0 } as Record<MigrationOperation['risk'], number>
  )

  return {
    plan: {
      operations,
      renameSuggestions,
      riskSummary,
    },
    omittedOperationCount: plan.operations.length - operations.length,
  }
}

export function buildScopedSnapshotDefinitions(input: {
  previousDefinitions: SchemaDefinition[]
  nextDefinitions: SchemaDefinition[]
  matchedTables: ReadonlySet<string>
  renameMappings?: TableRenameMapping[]
}): SchemaDefinition[] {
  if (input.matchedTables.size === 0) return input.previousDefinitions

  const selectedTables = new Set(input.matchedTables)
  for (const mapping of input.renameMappings ?? []) {
    const oldKey = tableKey(mapping.oldDatabase, mapping.oldName)
    const newKey = tableKey(mapping.newDatabase, mapping.newName)
    if (selectedTables.has(oldKey) || selectedTables.has(newKey)) {
      selectedTables.add(oldKey)
      selectedTables.add(newKey)
    }
  }

  const result = new Map<string, SchemaDefinition>()
  for (const definition of input.previousDefinitions) {
    result.set(`${definition.kind}:${definition.database}.${definition.name}`, definition)
  }

  for (const [key, definition] of [...result.entries()]) {
    if (definition.kind !== 'table') continue
    const currentTableKey = tableKey(definition.database, definition.name)
    if (!selectedTables.has(currentTableKey)) continue

    const stillExists = input.nextDefinitions.some(
      (item) => item.kind === 'table' && tableKey(item.database, item.name) === currentTableKey
    )
    if (!stillExists) result.delete(key)
  }

  for (const definition of input.nextDefinitions) {
    if (definition.kind !== 'table') continue
    const currentTableKey = tableKey(definition.database, definition.name)
    if (!selectedTables.has(currentTableKey)) continue
    result.set(`${definition.kind}:${definition.database}.${definition.name}`, definition)
  }

  return [...result.values()]
}
