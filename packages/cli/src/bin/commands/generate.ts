import { generateArtifacts } from '@chkit/codegen'
import process from 'node:process'
import { ChxValidationError, planDiff } from '@chkit/core'

import type { CommandDef, CommandRunContext } from '../../plugins.js'
import {
  CLI_VERSION,
  emitJson,
  loadSchemaDefinitions,
  readSnapshot,
} from '../lib.js'
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

export const generateCommand: CommandDef = {
  name: 'generate',
  description: 'Generate migration artifacts from schema definitions',
  flags: [
    { name: '--name', type: 'string', description: 'Migration name', placeholder: '<name>' },
    { name: '--migration-id', type: 'string', description: 'Deterministic migration file prefix', placeholder: '<id>' },
    { name: '--rename-table', type: 'string[]', description: 'Explicit table rename mapping', placeholder: '<mapping>' },
    { name: '--rename-column', type: 'string[]', description: 'Explicit column rename mapping', placeholder: '<mapping>' },
    { name: '--dryrun', type: 'boolean', description: 'Print plan without writing artifacts' },
  ],
  run: cmdGenerate,
}

async function cmdGenerate(ctx: CommandRunContext): Promise<void> {
  const { flags, config, configPath, dirs, pluginRuntime } = ctx
  const migrationName = flags['--name'] as string | undefined
  const migrationId = flags['--migration-id'] as string | undefined
  const tableSelector = flags['--table'] as string | undefined
  const planMode = flags['--dryrun'] === true
  const jsonMode = flags['--json'] === true

  await pluginRuntime.runOnConfigLoaded({
    command: 'generate',
    config,
    configPath,
    tableScope: resolveTableScope(tableSelector, []),
    flags,
  })

  let definitions = await loadSchemaDefinitions(config.schema)
  definitions = await pluginRuntime.runOnSchemaLoaded({
    command: 'generate',
    config,
    tableScope: resolveTableScope(tableSelector, tableKeysFromDefinitions(definitions)),
    flags,
    definitions,
  })

  const renameTableValues = (flags['--rename-table'] as string[] | undefined) ?? []
  const renameColumnValues = (flags['--rename-column'] as string[] | undefined) ?? []
  const cliTableMappings = parseRenameTableMappings(renameTableValues)
  const cliColumnMappings = parseRenameColumnMappings(renameColumnValues)
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
      flags,
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
      flags: {},
      print() {},
    })
    if (codegenExitCode !== 0) {
      throw new Error(`Plugin "codegen" failed in generate integration with exit code ${codegenExitCode}.`)
    }
  }

  emitGenerateApplyOutput(result, artifactDefinitions, plan, jsonMode, resolvedScope)
}
