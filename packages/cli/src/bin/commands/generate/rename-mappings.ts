import type { SchemaDefinition, TableDefinition } from '@chkit/core'

export interface TableRenameMapping {
  oldDatabase: string
  oldName: string
  newDatabase: string
  newName: string
  source: 'cli' | 'schema'
}

export interface ColumnRenameMapping {
  database: string
  table: string
  from: string
  to: string
  source: 'cli' | 'schema'
}

export function parseRenameTableMappings(values: string[]): TableRenameMapping[] {
  return values.map((mapping) => {
    const [fromRaw, toRaw, ...rest] = mapping.split('=').map((part) => part.trim())
    if (!fromRaw || !toRaw || rest.length > 0) {
      throw new Error(
        `Invalid --rename-table mapping "${mapping}". Expected format: old_db.old_table=new_db.new_table`
      )
    }
    const from = parseQualifiedTable(fromRaw)
    const to = parseQualifiedTable(toRaw)
    return {
      oldDatabase: from.database,
      oldName: from.name,
      newDatabase: to.database,
      newName: to.name,
      source: 'cli',
    }
  })
}

export function parseRenameColumnMappings(values: string[]): ColumnRenameMapping[] {
  return values.map((mapping) => {
    const [fromRaw, toRaw, ...rest] = mapping.split('=').map((part) => part.trim())
    if (!fromRaw || !toRaw || rest.length > 0) {
      throw new Error(
        `Invalid --rename-column mapping "${mapping}". Expected format: db.table.old_column=new_column`
      )
    }
    const parts = fromRaw.split('.').map((part) => part.trim())
    if (parts.length !== 3 || parts.some((part) => part.length === 0)) {
      throw new Error(
        `Invalid --rename-column source "${fromRaw}". Expected format: db.table.old_column`
      )
    }

    return {
      database: parts[0] as string,
      table: parts[1] as string,
      from: parts[2] as string,
      to: toRaw,
      source: 'cli',
    }
  })
}

export function collectSchemaRenameMappings(
  definitions: SchemaDefinition[]
): { tableMappings: TableRenameMapping[]; columnMappings: ColumnRenameMapping[] } {
  const tableMappings: TableRenameMapping[] = []
  const columnMappings: ColumnRenameMapping[] = []

  for (const definition of definitions) {
    if (definition.kind !== 'table') continue
    if (definition.renamedFrom) {
      tableMappings.push({
        oldDatabase: definition.renamedFrom.database ?? definition.database,
        oldName: definition.renamedFrom.name,
        newDatabase: definition.database,
        newName: definition.name,
        source: 'schema',
      })
    }
    for (const column of definition.columns) {
      if (!column.renamedFrom) continue
      columnMappings.push({
        database: definition.database,
        table: definition.name,
        from: column.renamedFrom,
        to: column.name,
        source: 'schema',
      })
    }
  }

  return { tableMappings, columnMappings }
}

export function mergeTableMappings(
  schemaMappings: TableRenameMapping[],
  cliMappings: TableRenameMapping[]
): TableRenameMapping[] {
  const merged = [...schemaMappings]
  for (const cliMapping of cliMappings) {
    const cliOldKey = `${cliMapping.oldDatabase}.${cliMapping.oldName}`
    const cliNewKey = `${cliMapping.newDatabase}.${cliMapping.newName}`
    for (let i = merged.length - 1; i >= 0; i -= 1) {
      const entry = merged[i]
      if (!entry) continue
      const oldKey = `${entry.oldDatabase}.${entry.oldName}`
      const newKey = `${entry.newDatabase}.${entry.newName}`
      if (oldKey === cliOldKey || newKey === cliNewKey) {
        merged.splice(i, 1)
      }
    }
    merged.push(cliMapping)
  }
  return merged
}

export function mergeColumnMappings(
  schemaMappings: ColumnRenameMapping[],
  cliMappings: ColumnRenameMapping[]
): ColumnRenameMapping[] {
  const merged = [...schemaMappings]
  for (const cliMapping of cliMappings) {
    const cliFromKey = `${cliMapping.database}.${cliMapping.table}.${cliMapping.from}`
    const cliToKey = `${cliMapping.database}.${cliMapping.table}.${cliMapping.to}`
    for (let i = merged.length - 1; i >= 0; i -= 1) {
      const entry = merged[i]
      if (!entry) continue
      const fromKey = `${entry.database}.${entry.table}.${entry.from}`
      const toKey = `${entry.database}.${entry.table}.${entry.to}`
      if (fromKey === cliFromKey || toKey === cliToKey) {
        merged.splice(i, 1)
      }
    }
    merged.push(cliMapping)
  }
  return merged
}

export function resolveActiveTableMappings(
  previousDefinitions: SchemaDefinition[],
  nextDefinitions: SchemaDefinition[],
  mappings: TableRenameMapping[]
): TableRenameMapping[] {
  return mappings.filter(
    (mapping) =>
      tableExists(previousDefinitions, mapping.oldDatabase, mapping.oldName) &&
      tableExists(nextDefinitions, mapping.newDatabase, mapping.newName)
  )
}

export function assertNoConflictingTableMappings(mappings: TableRenameMapping[]): void {
  const byOld = new Map<string, TableRenameMapping>()
  const byNew = new Map<string, TableRenameMapping>()

  for (const mapping of mappings) {
    const oldKey = `${mapping.oldDatabase}.${mapping.oldName}`
    const newKey = `${mapping.newDatabase}.${mapping.newName}`
    const existingOld = byOld.get(oldKey)
    if (existingOld && (existingOld.newDatabase !== mapping.newDatabase || existingOld.newName !== mapping.newName)) {
      throw new Error(`Conflicting table rename source mapping for "${oldKey}".`)
    }
    byOld.set(oldKey, mapping)

    const existingNew = byNew.get(newKey)
    if (existingNew && (existingNew.oldDatabase !== mapping.oldDatabase || existingNew.oldName !== mapping.oldName)) {
      throw new Error(`Conflicting table rename target mapping for "${newKey}".`)
    }
    byNew.set(newKey, mapping)
  }

  for (const key of byOld.keys()) {
    if (byNew.has(key)) {
      throw new Error(
        `Unsupported chained or cyclic table rename mapping involving "${key}". Use direct one-step mappings only.`
      )
    }
  }
}

export function assertNoConflictingColumnMappings(mappings: ColumnRenameMapping[]): void {
  const byFrom = new Map<string, ColumnRenameMapping>()
  const byTo = new Map<string, ColumnRenameMapping>()

  for (const mapping of mappings) {
    const fromKey = `${mapping.database}.${mapping.table}.${mapping.from}`
    const toKey = `${mapping.database}.${mapping.table}.${mapping.to}`
    const existingFrom = byFrom.get(fromKey)
    if (existingFrom && existingFrom.to !== mapping.to) {
      throw new Error(`Conflicting column rename source mapping for "${fromKey}".`)
    }
    byFrom.set(fromKey, mapping)

    const existingTo = byTo.get(toKey)
    if (existingTo && existingTo.from !== mapping.from) {
      throw new Error(`Conflicting column rename target mapping for "${toKey}".`)
    }
    byTo.set(toKey, mapping)
  }
}

export function assertCliTableMappingsResolvable(
  cliMappings: TableRenameMapping[],
  previousDefinitions: SchemaDefinition[],
  nextDefinitions: SchemaDefinition[]
): void {
  for (const mapping of cliMappings) {
    const hasOld = tableExists(previousDefinitions, mapping.oldDatabase, mapping.oldName)
    const hasNew = tableExists(nextDefinitions, mapping.newDatabase, mapping.newName)
    if (hasOld && hasNew) continue
    if (!hasOld && !hasNew) {
      throw new Error(
        `--rename-table mapping "${mapping.oldDatabase}.${mapping.oldName}=${mapping.newDatabase}.${mapping.newName}" is invalid: source table is missing from previous snapshot and target table is missing from current schema.`
      )
    }
    if (!hasOld) {
      throw new Error(
        `--rename-table mapping "${mapping.oldDatabase}.${mapping.oldName}=${mapping.newDatabase}.${mapping.newName}" is invalid: source table is missing from previous snapshot.`
      )
    }
    throw new Error(
      `--rename-table mapping "${mapping.oldDatabase}.${mapping.oldName}=${mapping.newDatabase}.${mapping.newName}" is invalid: target table is missing from current schema.`
    )
  }
}

export function remapOldDefinitionsForTableRenames(
  previousDefinitions: SchemaDefinition[],
  mappings: TableRenameMapping[]
): SchemaDefinition[] {
  if (mappings.length === 0) return previousDefinitions

  const mappingByOld = new Map<string, TableRenameMapping>()
  for (const mapping of mappings) {
    mappingByOld.set(`${mapping.oldDatabase}.${mapping.oldName}`, mapping)
  }

  return previousDefinitions.map((definition) => {
    if (definition.kind !== 'table') return definition
    const mapping = mappingByOld.get(`${definition.database}.${definition.name}`)
    if (!mapping) return definition
    const remapped: TableDefinition = {
      ...definition,
      database: mapping.newDatabase,
      name: mapping.newName,
    }
    return remapped
  })
}

function parseQualifiedTable(input: string): { database: string; name: string } {
  const [database, name, ...rest] = input.split('.').map((part) => part.trim())
  if (!database || !name || rest.length > 0) {
    throw new Error(`Invalid table reference "${input}". Expected format: database.table`)
  }
  return { database, name }
}

function tableExists(definitions: SchemaDefinition[], database: string, name: string): boolean {
  return definitions.some(
    (definition) => definition.kind === 'table' && definition.database === database && definition.name === name
  )
}
