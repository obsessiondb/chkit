import { generateArtifacts } from '@chkit/codegen'
import process from 'node:process'
import { ChxValidationError, planDiff } from '@chkit/core'

import {
  CLI_VERSION,
  emitJson,
  getCommandContext,
  hasFlag,
  loadSchemaDefinitions,
  parseArg,
  readSnapshot,
} from '../lib.js'
import { loadPluginRuntime } from '../plugin-runtime.js'
import {
  buildScopedSnapshotDefinitions,
  filterPlanByTableScope,
  resolveTableScope,
  tableKeysFromDefinitions,
} from '../table-scope.js'
import {
  applyExplicitTableRenames,
  applySelectedRenameSuggestions,
  assertCliColumnMappingsResolvable,
  buildExplicitColumnRenameSuggestions,
} from './generate/plan-pipeline.js'
import {
  assertCliTableMappingsResolvable,
  assertNoConflictingColumnMappings,
  assertNoConflictingTableMappings,
  collectSchemaRenameMappings,
  mergeColumnMappings,
  mergeTableMappings,
  parseRenameColumnMappings,
  parseRenameTableMappings,
  remapOldDefinitionsForTableRenames,
  resolveActiveTableMappings,
} from './generate/rename-mappings.js'
import { emitGenerateApplyOutput, emitGeneratePlanOutput } from './generate/output.js'

export async function cmdGenerate(args: string[]): Promise<void> {
  const migrationName = parseArg('--name', args)
  const migrationId = parseArg('--migration-id', args)
  const tableSelector = parseArg('--table', args)
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
    tableScope: resolveTableScope(tableSelector, []),
  })

  let definitions = await loadSchemaDefinitions(config.schema)
  definitions = await pluginRuntime.runOnSchemaLoaded({
    command: 'generate',
    config,
    tableScope: resolveTableScope(tableSelector, tableKeysFromDefinitions(definitions)),
    definitions,
  })

  const cliTableMappings = parseRenameTableMappings(args)
  const cliColumnMappings = parseRenameColumnMappings(args)
  const schemaMappings = collectSchemaRenameMappings(definitions)
  const tableMappings = mergeTableMappings(schemaMappings.tableMappings, cliTableMappings)
  const columnMappings = mergeColumnMappings(schemaMappings.columnMappings, cliColumnMappings)

  const { migrationsDir, metaDir } = dirs
  const previousDefinitions = (await readSnapshot(metaDir))?.definitions ?? []
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
    return
  }

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
      tableScope: resolvedScope,
    },
    plan
  )

  if (resolvedScope.enabled) {
    plan = filterPlanByTableScope(plan, new Set(resolvedScope.matchedTables), {
      renameMappings: activeTableMappings,
    }).plan
  }

  if (planMode) {
    emitGeneratePlanOutput(plan, jsonMode, resolvedScope)
    return
  }

  const artifactDefinitions = resolvedScope.enabled
    ? buildScopedSnapshotDefinitions({
        previousDefinitions,
        nextDefinitions: definitions,
        matchedTables: new Set(resolvedScope.matchedTables),
        renameMappings: activeTableMappings,
      })
    : definitions

  const result = await generateArtifacts({
    definitions: artifactDefinitions,
    migrationsDir,
    metaDir,
    migrationName,
    migrationId,
    plan,
    cliVersion: CLI_VERSION,
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
      print() {},
    })
    if (codegenExitCode !== 0) {
      throw new Error(`Plugin "codegen" failed in generate integration with exit code ${codegenExitCode}.`)
    }
  }

  emitGenerateApplyOutput(result, artifactDefinitions, plan, jsonMode, resolvedScope)
}
