import { generateArtifacts } from '@chkit/codegen'
import { ChxValidationError, planDiff } from '@chkit/core'

import { defineFlags, typedFlags, type ChxPluginCommand } from '../../plugins.js'
import { resolveDirs } from '../../runtime/config.js'
import { GLOBAL_FLAGS } from '../../runtime/global-flags.js'
import { emitJson } from '../../runtime/json-output.js'
import { readSnapshot } from '../../runtime/migration-store.js'
import { loadSchemaDefinitions } from '../../runtime/schema-loader.js'
import { CLI_VERSION } from '../../runtime/version.js'
import {
  buildScopedSnapshotDefinitions,
  filterPlanByTableScope,
  resolveTableScope,
  tableKeysFromDefinitions,
} from '../../runtime/table-scope.js'
import {
  applyExplicitTableRenames,
  applySelectedRenameSuggestions,
  assertCliColumnMappingsResolvable,
  buildExplicitColumnRenameSuggestions,
} from './plan-pipeline.js'
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
} from './rename-mappings.js'
import { emitGenerateApplyOutput, emitGeneratePlanOutput } from './output.js'
import { debug } from '../../runtime/debug.js'

const GENERATE_FLAGS = defineFlags([
  { name: '--name', type: 'string', description: 'Migration name', placeholder: '<name>' },
  { name: '--migration-id', type: 'string', description: 'Override the default timestamp migration prefix', placeholder: '<id>' },
  { name: '--rename-table', type: 'string[]', description: 'Explicit table rename mapping', placeholder: '<mapping>' },
  { name: '--rename-column', type: 'string[]', description: 'Explicit column rename mapping', placeholder: '<mapping>' },
  { name: '--dryrun', type: 'boolean', description: 'Print plan without writing artifacts' },
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

  debug('generate', `flags: name=${migrationName ?? '(auto)'}, dryrun=${planMode}, json=${jsonMode}`)

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
    jsonMode,
    definitions,
  })

  const renameTableValues = f['--rename-table'] ?? []
  const renameColumnValues = f['--rename-column'] ?? []
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
    return 0
  }

  assertNoConflictingTableMappings(tableMappings)
  assertNoConflictingColumnMappings(columnMappings)
  assertCliTableMappingsResolvable(cliTableMappings, previousDefinitions, definitions)

  const activeTableMappings = resolveActiveTableMappings(previousDefinitions, definitions, tableMappings)
  const remappedPreviousDefinitions = remapOldDefinitionsForTableRenames(
    previousDefinitions,
    activeTableMappings
  )

  debug('generate', `previous snapshot: ${previousDefinitions.length} definitions, current: ${definitions.length} definitions`)

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
        return 1
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
    return 0
  }

  const artifactDefinitions = resolvedScope.enabled
    ? buildScopedSnapshotDefinitions({
        previousDefinitions,
        nextDefinitions: definitions,
        matchedTables: new Set(resolvedScope.matchedTables),
        renameMappings: activeTableMappings,
      })
    : definitions

  debug('generate', `plan: ${plan.operations.length} operations — writing artifacts`)

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
  return 0
}
