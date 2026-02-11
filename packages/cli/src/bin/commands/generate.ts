import { generateArtifacts } from '@chx/codegen'
import process from 'node:process'
import {
  ChxValidationError,
  type ColumnRenameSuggestion,
  type MigrationOperation,
  type MigrationPlan,
  type RiskLevel,
  type SchemaDefinition,
  type TableDefinition,
  planDiff,
} from '@chx/core'

import {
  CLI_VERSION,
  emitJson,
  getCommandContext,
  hasFlag,
  loadSchemaDefinitions,
  parseArg,
  readSnapshot,
  summarizePlan,
} from '../lib.js'
import { loadPluginRuntime } from '../plugin-runtime.js'

interface TableRenameMapping {
  oldDatabase: string
  oldName: string
  newDatabase: string
  newName: string
  source: 'cli' | 'schema'
}

interface ColumnRenameMapping {
  database: string
  table: string
  from: string
  to: string
  source: 'cli' | 'schema'
}

function parseFlagValues(flag: string, args: string[]): string[] {
  const values: string[] = []
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] !== flag) continue
    const value = args[i + 1]
    if (!value || value.startsWith('--')) continue
    values.push(...value.split(',').map((entry) => entry.trim()).filter((entry) => entry.length > 0))
  }
  return values
}

function parseQualifiedTable(input: string): { database: string; name: string } {
  const [database, name, ...rest] = input.split('.').map((part) => part.trim())
  if (!database || !name || rest.length > 0) {
    throw new Error(`Invalid table reference "${input}". Expected format: database.table`)
  }
  return { database, name }
}

function parseRenameTableMappings(args: string[]): TableRenameMapping[] {
  return parseFlagValues('--rename-table', args).map((mapping) => {
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

function parseRenameColumnMappings(args: string[]): ColumnRenameMapping[] {
  return parseFlagValues('--rename-column', args).map((mapping) => {
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

function collectSchemaRenameMappings(
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

function mergeTableMappings(
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

function mergeColumnMappings(
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

function tableExists(definitions: SchemaDefinition[], database: string, name: string): boolean {
  return definitions.some(
    (definition) => definition.kind === 'table' && definition.database === database && definition.name === name
  )
}

function resolveActiveTableMappings(
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

function assertNoConflictingTableMappings(mappings: TableRenameMapping[]): void {
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

function assertNoConflictingColumnMappings(mappings: ColumnRenameMapping[]): void {
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

function assertCliTableMappingsResolvable(
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

function remapOldDefinitionsForTableRenames(
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

function rankOperation(op: MigrationOperation): number {
  if (op.type.startsWith('drop_')) return 0
  if (op.type === 'create_database') return 1
  if (op.type === 'alter_table_rename_table') return 2
  if (op.type.startsWith('alter_')) return 3
  return 4
}

function summarizeRisk(operations: MigrationOperation[]): Record<RiskLevel, number> {
  const riskSummary: Record<RiskLevel, number> = { safe: 0, caution: 0, danger: 0 }
  for (const operation of operations) {
    riskSummary[operation.risk] = (riskSummary[operation.risk] ?? 0) + 1
  }
  return riskSummary
}

function applySelectedRenameSuggestions(
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

  const operations = [
    ...plan.operations.filter((operation) => !operationKeysToRemove.has(operation.key)),
    ...renameOperations,
  ].sort((a, b) => {
    const rankOrder = rankOperation(a) - rankOperation(b)
    if (rankOrder !== 0) return rankOrder
    return a.key.localeCompare(b.key)
  })

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

function applyExplicitTableRenames(
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
      sql: `RENAME TABLE ${mapping.oldDatabase}.${mapping.oldName} TO ${mapping.newDatabase}.${mapping.newName};`,
    })
  }

  const operations = [
    ...plan.operations.filter((operation) => !operationKeysToRemove.has(operation.key)),
    ...extraOperations,
  ].sort((a, b) => {
    const rankOrder = rankOperation(a) - rankOperation(b)
    if (rankOrder !== 0) return rankOrder
    return a.key.localeCompare(b.key)
  })

  return {
    operations,
    riskSummary: summarizeRisk(operations),
    renameSuggestions: plan.renameSuggestions,
  }
}

function buildExplicitColumnRenameSuggestions(
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
      confirmationSQL: `ALTER TABLE ${mapping.database}.${mapping.table} RENAME COLUMN \`${mapping.from}\` TO \`${mapping.to}\`;`,
    })
  }

  return suggestions
}

function assertCliColumnMappingsResolvable(
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

export async function cmdGenerate(args: string[]): Promise<void> {
  const migrationName = parseArg('--name', args)
  const migrationId = parseArg('--migration-id', args)
  const planMode = hasFlag('--dryrun', args)

  const { config, configPath, dirs, jsonMode } = await getCommandContext(args)
  const pluginRuntime = await loadPluginRuntime({
    config,
    configPath,
    cliVersion: CLI_VERSION,
  })
  await pluginRuntime.runOnConfigLoaded({
    command: 'generate',
    config,
    configPath,
  })
  let definitions = await loadSchemaDefinitions(config.schema)
  definitions = await pluginRuntime.runOnSchemaLoaded({
    command: 'generate',
    config,
    definitions,
  })
  const cliTableMappings = parseRenameTableMappings(args)
  const cliColumnMappings = parseRenameColumnMappings(args)
  const schemaMappings = collectSchemaRenameMappings(definitions)

  const tableMappings = mergeTableMappings(schemaMappings.tableMappings, cliTableMappings)
  const columnMappings = mergeColumnMappings(schemaMappings.columnMappings, cliColumnMappings)
  const { migrationsDir, metaDir } = dirs
  const previousDefinitions = (await readSnapshot(metaDir))?.definitions ?? []
  assertNoConflictingTableMappings(tableMappings)
  assertNoConflictingColumnMappings(columnMappings)
  assertCliTableMappingsResolvable(cliTableMappings, previousDefinitions, definitions)
  const activeTableMappings = resolveActiveTableMappings(previousDefinitions, definitions, tableMappings)
  const remappedPreviousDefinitions = remapOldDefinitionsForTableRenames(
    previousDefinitions,
    activeTableMappings
  )
  let plan: ReturnType<typeof planDiff>
  try {
    plan = planDiff(remappedPreviousDefinitions, definitions)
  } catch (error) {
    if (error instanceof ChxValidationError) {
      if (jsonMode) {
        emitJson('generate', {
          error: 'validation_failed',
          issues: error.issues,
        })
        process.exitCode = 1
        return
      }

      const details = error.issues.map((issue) => `- [${issue.code}] ${issue.message}`).join('\n')
      throw new Error(`${error.message}\n${details}`)
    }
    throw error
  }
  plan = applyExplicitTableRenames(plan, activeTableMappings)
  assertCliColumnMappingsResolvable(cliColumnMappings, plan, definitions)
  plan = applySelectedRenameSuggestions(plan, buildExplicitColumnRenameSuggestions(plan, columnMappings))
  plan = await pluginRuntime.runOnPlanCreated(
    {
      command: 'generate',
      config,
    },
    plan
  )

  if (planMode) {
    const payload = {
      mode: 'plan',
      operationCount: plan.operations.length,
      riskSummary: plan.riskSummary,
      operations: plan.operations,
      renameSuggestions: plan.renameSuggestions,
    }

    if (jsonMode) {
      emitJson('generate', payload)
      return
    }

    console.log(`Planned operations: ${payload.operationCount}`)
    console.log(
      `Risk summary: safe=${payload.riskSummary.safe}, caution=${payload.riskSummary.caution}, danger=${payload.riskSummary.danger}`
    )
    for (const line of summarizePlan(plan.operations)) console.log(`- ${line}`)
    if (payload.renameSuggestions.length > 0) {
      console.log('\nRename suggestions (review and confirm manually):')
      for (const suggestion of payload.renameSuggestions) {
        console.log(
          `- ${suggestion.kind} ${suggestion.database}.${suggestion.table}: ${suggestion.from} -> ${suggestion.to} [${suggestion.confidence}]`
        )
        console.log(`  ${suggestion.reason}`)
        console.log(`  Confirm with: ${suggestion.confirmationSQL}`)
      }
    }
    return
  }

  const result = await generateArtifacts({
    definitions,
    migrationsDir,
    metaDir,
    migrationName,
    migrationId,
    plan,
    cliVersion: CLI_VERSION,
  })

  const typegenPlugin = pluginRuntime.plugins.find((entry) => entry.plugin.manifest.name === 'typegen')
  const typegenRunOnGenerate = typegenPlugin ? typegenPlugin.options.runOnGenerate !== false : false
  if (typegenPlugin && typegenRunOnGenerate) {
    const typegenExitCode = await pluginRuntime.runPluginCommand('typegen', 'typegen', {
      config,
      configPath,
      jsonMode: false,
      args: [],
      print() {},
    })
    if (typegenExitCode !== 0) {
      throw new Error(`Plugin "typegen" failed in generate integration with exit code ${typegenExitCode}.`)
    }
  }

  const payload = {
    migrationFile: result.migrationFile,
    snapshotFile: result.snapshotFile,
    definitionCount: definitions.length,
    operationCount: plan.operations.length,
    riskSummary: plan.riskSummary,
  }

  if (jsonMode) {
    emitJson('generate', payload)
    return
  }

  if (result.migrationFile) {
    console.log(`Generated migration: ${result.migrationFile}`)
  } else {
    console.log('No migration generated: plan is empty.')
  }
  console.log(`Updated snapshot:   ${result.snapshotFile}`)
  console.log(`Definitions:        ${definitions.length}`)
  console.log(`Operations:         ${plan.operations.length}`)
  console.log(
    `Risk summary:       safe=${plan.riskSummary.safe}, caution=${plan.riskSummary.caution}, danger=${plan.riskSummary.danger}`
  )
}
