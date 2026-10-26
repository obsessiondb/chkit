import { generateArtifacts, generateEmptyMigration } from '@chkit/codegen'
import { applyOnClusterToPlan, ChxValidationError, planDiff, type PlannedCutover } from '@chkit/core'

import { defineFlags, typedFlags, type ChxPluginCommand } from '../../plugins.js'
import { resolveDirs } from '../../runtime/config.js'
import { GLOBAL_FLAGS } from '../../runtime/global-flags.js'
import { emitJson } from '../../runtime/json-output.js'
import { readSnapshot } from '../../runtime/migration-store.js'
import { loadSchemaDefinitionsWithHooks } from '../../runtime/schema-loader.js'
import { CLI_VERSION } from '../../runtime/version.js'
import {
  buildScopedSnapshotDefinitions,
  filterPlanByTableScope,
  resolveTableScope,
  tableKeysFromDefinitions,
} from '../../runtime/table-scope.js'
import { detectDictionaryPasswordWarnings } from './dictionary-password-warnings.js'
import {
  applyExplicitDictionaryRenames,
  applyExplicitTableRenames,
  applySelectedRenameSuggestions,
  assertCliColumnMappingsResolvable,
  buildExplicitColumnRenameSuggestions,
} from './plan-pipeline.js'
import {
  assertCliDictionaryMappingsResolvable,
  assertCliTableMappingsResolvable,
  assertNoConflictingColumnMappings,
  assertNoConflictingDictionaryMappings,
  assertNoConflictingTableMappings,
  collectSchemaRenameMappings,
  mergeColumnMappings,
  mergeDictionaryMappings,
  mergeTableMappings,
  parseRenameColumnMappings,
  parseRenameDictionaryMappings,
  parseRenameTableMappings,
  remapOldDefinitionsForDictionaryRenames,
  remapOldDefinitionsForTableRenames,
  resolveActiveDictionaryMappings,
  resolveActiveTableMappings,
} from './rename-mappings.js'
import { emitGenerateApplyOutput, emitGenerateEmptyOutput, emitGeneratePlanOutput } from './output.js'
import { applyCutovers, carryRetainedDefinitions, resolveCutoverFlags, summarizeCutover } from './cutover.js'
import { debug } from '../../runtime/debug.js'

const GENERATE_FLAGS = defineFlags([
  { name: '--name', type: 'string', description: 'Migration name', placeholder: '<name>' },
  { name: '--migration-id', type: 'string', description: 'Override the default timestamp migration prefix', placeholder: '<id>' },
  { name: '--rename-table', type: 'string[]', description: 'Explicit table rename mapping', placeholder: '<mapping>' },
  { name: '--rename-column', type: 'string[]', description: 'Explicit column rename mapping', placeholder: '<mapping>' },
  { name: '--rename-dictionary', type: 'string[]', description: 'Explicit dictionary rename mapping', placeholder: '<mapping>' },
  { name: '--dryrun', type: 'boolean', description: 'Print plan without writing artifacts' },
  { name: '--empty', type: 'boolean', description: 'Scaffold a blank manual migration (no schema diff, snapshot untouched)' },
  { name: '--cutover', type: 'string[]', description: 'Cut a structural table change over without downtime, keyed by a unique key', placeholder: '<database.table=key>' },
  { name: '--cutover-copy', type: 'string', description: 'Where the cutover copies existing rows: migration (default) or backfill', placeholder: '<mode>' },
  { name: '--cutover-old', type: 'string', description: 'What happens to the pre-cutover table: keep (default, as <table>_previous) or drop', placeholder: '<mode>' },
  { name: '--drop-retained', type: 'string[]', description: 'Drop a table a cutover retained', placeholder: '<database.table>' },
] as const)

export const generateCommand: ChxPluginCommand = {
  name: 'generate',
  description: 'Generate migration artifacts from schema definitions',
  flags: GENERATE_FLAGS,
  run: cmdGenerate,
}

async function cmdGenerate(ctx: import('../../plugins.js').ChxPluginCommandContext): Promise<undefined | number> {
  const { flags, config, configPath, pluginRuntime } = ctx
  const dirs = resolveDirs(config)
  const f = typedFlags(flags, [...GLOBAL_FLAGS, ...GENERATE_FLAGS] as const)
  const migrationName = f['--name']
  const migrationId = f['--migration-id']
  const tableSelector = f['--table']
  const planMode = f['--dryrun'] === true
  const jsonMode = f['--json'] === true
  const emptyMode = f['--empty'] === true

  debug('generate', `flags: name=${migrationName ?? '(auto)'}, dryrun=${planMode}, json=${jsonMode}, empty=${emptyMode}`)

  // `--empty` scaffolds a blank manual migration: no schema diff, no plugin
  // pipeline, and the snapshot is left untouched. Short-circuit before any of
  // that machinery so the file is a pristine stub for hand-editing.
  if (emptyMode) {
    debug('generate', 'empty mode: scaffolding blank migration')
    const result = await generateEmptyMigration({
      migrationsDir: dirs.migrationsDir,
      migrationName,
      migrationId,
      cliVersion: CLI_VERSION,
    })
    emitGenerateEmptyOutput(result, jsonMode)
    return 0
  }

  const cutoverFlags = resolveCutoverFlags({
    cutover: f['--cutover'] ?? [],
    copy: f['--cutover-copy'],
    oldTable: f['--cutover-old'],
    dropRetained: f['--drop-retained'] ?? [],
  })
  const now = new Date()

  const schemaDefinitions = await loadSchemaDefinitionsWithHooks(
    { command: 'generate', config, configPath, flags, jsonMode, tableSelector },
    { pluginRuntime },
  )

  const renameTableValues = f['--rename-table'] ?? []
  const renameColumnValues = f['--rename-column'] ?? []
  const renameDictionaryValues = f['--rename-dictionary'] ?? []
  const cliTableMappings = parseRenameTableMappings(renameTableValues)
  const cliColumnMappings = parseRenameColumnMappings(renameColumnValues)
  const cliDictionaryMappings = parseRenameDictionaryMappings(renameDictionaryValues)
  const schemaMappings = collectSchemaRenameMappings(schemaDefinitions)
  const tableMappings = mergeTableMappings(schemaMappings.tableMappings, cliTableMappings)
  const columnMappings = mergeColumnMappings(schemaMappings.columnMappings, cliColumnMappings)
  const dictionaryMappings = mergeDictionaryMappings(schemaMappings.dictionaryMappings, cliDictionaryMappings)

  const { migrationsDir, metaDir } = dirs
  const previousDefinitions = (await readSnapshot(metaDir))?.definitions ?? []
  const definitions = carryRetainedDefinitions({
    previousDefinitions,
    definitions: schemaDefinitions,
    dropRetained: f['--drop-retained'] ?? [],
  })
  const resolvedScope = resolveTableScope(tableSelector, [
    ...tableKeysFromDefinitions(previousDefinitions),
    ...tableKeysFromDefinitions(definitions),
  ])

  if (resolvedScope.enabled && resolvedScope.matchCount === 0) {
    if (jsonMode) {
      emitJson('generate', {
        scope: resolvedScope,
        mode: planMode ? 'plan' : 'apply',
        operationCount: 0,
        riskSummary: { safe: 0, caution: 0, danger: 0 },
        operations: [],
        renameSuggestions: [],
        warning: `No tables matched selector "${resolvedScope.selector ?? ''}".`,
      })
    } else {
      console.log(`No tables matched selector "${resolvedScope.selector ?? ''}". No changes planned.`)
    }
    return 0
  }

  assertNoConflictingTableMappings(tableMappings)
  assertNoConflictingColumnMappings(columnMappings)
  assertNoConflictingDictionaryMappings(dictionaryMappings)
  assertCliTableMappingsResolvable(cliTableMappings, previousDefinitions, definitions)
  assertCliDictionaryMappingsResolvable(cliDictionaryMappings, previousDefinitions, definitions)

  const activeTableMappings = resolveActiveTableMappings(previousDefinitions, definitions, tableMappings)
  const activeDictionaryMappings = resolveActiveDictionaryMappings(
    previousDefinitions,
    definitions,
    dictionaryMappings
  )
  const remappedPreviousDefinitions = remapOldDefinitionsForDictionaryRenames(
    remapOldDefinitionsForTableRenames(previousDefinitions, activeTableMappings),
    activeDictionaryMappings
  )

  debug('generate', `previous snapshot: ${previousDefinitions.length} definitions, current: ${definitions.length} definitions`)

  let plan: ReturnType<typeof planDiff>
  try {
    plan = planDiff(remappedPreviousDefinitions, definitions)
  } catch (error) {
    return reportValidationError(error, jsonMode)
  }

  plan = applyExplicitTableRenames(plan, activeTableMappings)
  plan = applyExplicitDictionaryRenames(plan, activeDictionaryMappings)
  assertCliColumnMappingsResolvable(cliColumnMappings, plan, definitions)
  plan = applySelectedRenameSuggestions(plan, buildExplicitColumnRenameSuggestions(plan, columnMappings))

  plan = await pluginRuntime.runOnPlanCreated(
    {
      command: 'generate',
      config,
      tableScope: resolvedScope,
      flags,
    },
    plan
  )

  if (resolvedScope.enabled) {
    plan = filterPlanByTableScope(plan, new Set(resolvedScope.matchedTables), {
      renameMappings: activeTableMappings,
    }).plan
  }

  // A cutover replaces the DROP + CREATE of a structural change with a
  // zero-downtime copy and swap. It runs after scope filtering, so a table
  // outside --table has no DROP + CREATE to replace.
  let cutovers: PlannedCutover[] = []
  if (cutoverFlags.requests.length > 0) {
    try {
      ;({ plan, cutovers } = applyCutovers({
        plan,
        previousDefinitions: remappedPreviousDefinitions,
        definitions,
        cutovers: cutoverFlags,
        cluster: config.clickhouse?.cluster,
        stamp: migrationStamp(now),
      }))
    } catch (error) {
      return reportValidationError(error, jsonMode)
    }
  }
  const cutoverSummaries = cutovers.map(summarizeCutover)

  // Cluster mode: stamp `ON CLUSTER <name>` onto every DDL statement as a final
  // post-pass, after all plan transforms (renames, plugins, scope filtering).
  plan = applyOnClusterToPlan(plan, config.clickhouse?.cluster)

  const dictionaryPasswordWarnings = [
    ...detectDictionaryPasswordWarnings(plan),
    ...plan.operations.flatMap((operation) => operation.warning ? [operation.warning] : []),
  ]

  if (planMode) {
    emitGeneratePlanOutput(plan, jsonMode, resolvedScope, dictionaryPasswordWarnings, cutoverSummaries)
    return 0
  }

  const scopedDefinitions = resolvedScope.enabled
    ? buildScopedSnapshotDefinitions({
        previousDefinitions,
        nextDefinitions: definitions,
        matchedTables: new Set(resolvedScope.matchedTables),
        renameMappings: activeTableMappings,
      })
    : definitions
  // A keep-mode cutover leaves the old table as <table>_previous: record it so
  // drift, check and the next generate treat it as managed.
  const artifactDefinitions = [
    ...scopedDefinitions,
    ...cutovers.flatMap((cutover) => (cutover.retained ? [cutover.retained] : [])),
  ]

  debug('generate', `plan: ${plan.operations.length} operations — writing artifacts`)

  const result = await generateArtifacts({
    definitions: artifactDefinitions,
    migrationsDir,
    metaDir,
    migrationName,
    migrationId,
    plan,
    cliVersion: CLI_VERSION,
    now,
  })

  const codegenPlugin = pluginRuntime.plugins.find((entry) => entry.plugin.manifest.name === 'codegen')
  const codegenRunOnGenerate = codegenPlugin ? codegenPlugin.options.runOnGenerate !== false : false
  if (codegenPlugin && codegenRunOnGenerate) {
    const codegenExitCode = await pluginRuntime.runPluginCommand('codegen', 'codegen', {
      config,
      configPath,
      jsonMode: false,
      tableScope: resolvedScope,
      args: [],
      flags: {},
      print() {},
    })
    if (codegenExitCode !== 0) {
      throw new Error(`Plugin "codegen" failed in generate integration with exit code ${codegenExitCode}.`)
    }
  }

  emitGenerateApplyOutput(result, artifactDefinitions, plan, jsonMode, resolvedScope, dictionaryPasswordWarnings, cutoverSummaries)
  return 0
}

/** Prints a schema or cutover validation failure; rethrows anything else. */
function reportValidationError(error: unknown, jsonMode: boolean): number {
  if (!(error instanceof ChxValidationError)) throw error
  if (jsonMode) {
    emitJson('generate', {
      error: 'validation_failed',
      issues: error.issues,
    })
    return 1
  }
  const details = error.issues.map((issue) => `- [${issue.code}] ${issue.message}`).join('\n')
  throw new Error(`${error.message}\n${details}`)
}

/** The migration file's timestamp prefix, `YYYYMMDDHHMMSS`; names a cutover's temporary objects. */
function migrationStamp(now: Date): string {
  return now.toISOString().replace(/[-:TZ.]/g, '').slice(0, 14)
}
