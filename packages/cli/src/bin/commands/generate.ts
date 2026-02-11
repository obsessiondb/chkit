import { generateArtifacts } from '@chx/codegen'
import process from 'node:process'
import { ChxValidationError, planDiff } from '@chx/core'

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
    emitGeneratePlanOutput(plan, jsonMode)
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

  emitGenerateApplyOutput(result, definitions, plan, jsonMode)
}
