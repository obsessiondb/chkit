import { canonicalizeDefinitions, type MigrationPlan } from '@chkit/core'

import type {
  ChxOnAfterApplyContext,
  ChxOnBeforeApplyContext,
  ChxOnBeforePluginCommandContext,
  ChxOnBeforePluginCommandResult,
  ChxOnCheckContext,
  ChxOnCheckResult,
  ChxOnCompleteContext,
  ChxOnConfigLoadedContext,
  ChxOnInitContext,
  ChxOnPlanCreatedContext,
  ChxOnSchemaLoadedContext,
  LoadedPlugin,
  TableScope,
} from '../../plugins.js'
import { debug } from '../debug.js'
import { guardHook } from './errors.js'

const UNFILTERED_TABLE_SCOPE: TableScope = {
  enabled: false,
  matchedTables: [],
  matchCount: 0,
}

export async function runOnInit(
  loaded: LoadedPlugin[],
  context: Omit<ChxOnInitContext, 'options'>,
): Promise<void> {
  for (const item of loaded) {
    const hook = item.plugin.hooks?.onInit
    if (!hook) continue
    debug('hook', `onInit → ${item.plugin.manifest.name}`)
    await guardHook(item.plugin.manifest.name, 'onInit', () =>
      hook({ ...context, options: item.options }),
    )
  }
}

export async function runOnComplete(
  loaded: LoadedPlugin[],
  context: Omit<ChxOnCompleteContext, 'options' | 'exitCode'> & { exitCode?: number },
): Promise<void> {
  const exitCode = context.exitCode ?? 0
  for (const item of loaded) {
    const hook = item.plugin.hooks?.onComplete
    if (!hook) continue
    debug('hook', `onComplete → ${item.plugin.manifest.name} (exitCode: ${exitCode})`)
    await guardHook(item.plugin.manifest.name, 'onComplete', () =>
      hook({ ...context, exitCode, options: item.options }),
    )
  }
}

export async function runOnConfigLoaded(
  loaded: LoadedPlugin[],
  context: Omit<ChxOnConfigLoadedContext, 'options' | 'tableScope'> & { tableScope?: TableScope },
): Promise<void> {
  const tableScope = context.tableScope ?? UNFILTERED_TABLE_SCOPE
  for (const item of loaded) {
    const hook = item.plugin.hooks?.onConfigLoaded
    if (!hook) continue
    debug('hook', `onConfigLoaded → ${item.plugin.manifest.name}`)
    await guardHook(item.plugin.manifest.name, 'onConfigLoaded', () =>
      hook({ ...context, options: item.options, tableScope }),
    )
  }
}

export async function runOnSchemaLoaded(
  loaded: LoadedPlugin[],
  context: ChxOnSchemaLoadedContext,
) {
  let definitions = context.definitions
  for (const item of loaded) {
    const hook = item.plugin.hooks?.onSchemaLoaded
    if (!hook) continue
    debug(
      'hook',
      `onSchemaLoaded → ${item.plugin.manifest.name} (${definitions.length} definitions)`,
    )
    const next = await guardHook(item.plugin.manifest.name, 'onSchemaLoaded', () =>
      hook({ ...context, definitions }),
    )
    if (Array.isArray(next)) {
      debug(
        'hook',
        `onSchemaLoaded ← ${item.plugin.manifest.name} returned ${next.length} definitions`,
      )
      definitions = canonicalizeDefinitions(next)
    }
  }
  return definitions
}

export async function runOnPlanCreated(
  loaded: LoadedPlugin[],
  context: Omit<ChxOnPlanCreatedContext, 'plan' | 'tableScope'> & { tableScope?: TableScope },
  initialPlan: MigrationPlan,
): Promise<MigrationPlan> {
  const tableScope = context.tableScope ?? UNFILTERED_TABLE_SCOPE
  let plan = initialPlan
  for (const item of loaded) {
    const hook = item.plugin.hooks?.onPlanCreated
    if (!hook) continue
    debug(
      'hook',
      `onPlanCreated → ${item.plugin.manifest.name} (${plan.operations.length} operations)`,
    )
    const next = await guardHook(item.plugin.manifest.name, 'onPlanCreated', () =>
      hook({ ...context, tableScope, plan }),
    )
    if (next) {
      debug(
        'hook',
        `onPlanCreated ← ${item.plugin.manifest.name} modified plan (${next.operations.length} operations)`,
      )
      plan = next
    }
  }
  return plan
}

export async function runOnBeforeApply(
  loaded: LoadedPlugin[],
  context: ChxOnBeforeApplyContext,
): Promise<string[]> {
  let statements = context.statements
  for (const item of loaded) {
    const hook = item.plugin.hooks?.onBeforeApply
    if (!hook) continue
    debug(
      'hook',
      `onBeforeApply → ${item.plugin.manifest.name} (${context.migration}, ${statements.length} statements)`,
    )
    const result = await guardHook(item.plugin.manifest.name, 'onBeforeApply', () =>
      hook({ ...context, statements }),
    )
    if (result?.statements) {
      debug(
        'hook',
        `onBeforeApply ← ${item.plugin.manifest.name} modified statements (${result.statements.length})`,
      )
      statements = result.statements
    }
  }
  return statements
}

export async function runOnAfterApply(
  loaded: LoadedPlugin[],
  context: ChxOnAfterApplyContext,
): Promise<void> {
  for (const item of loaded) {
    const hook = item.plugin.hooks?.onAfterApply
    if (!hook) continue
    debug('hook', `onAfterApply → ${item.plugin.manifest.name} (${context.migration})`)
    await guardHook(item.plugin.manifest.name, 'onAfterApply', () => hook(context))
  }
}

export async function runOnCheck(
  loaded: LoadedPlugin[],
  context: Omit<ChxOnCheckContext, 'options' | 'tableScope'> & { tableScope?: TableScope },
): Promise<ChxOnCheckResult[]> {
  const tableScope = context.tableScope ?? UNFILTERED_TABLE_SCOPE
  const results: ChxOnCheckResult[] = []
  for (const item of loaded) {
    const hook = item.plugin.hooks?.onCheck
    if (!hook) continue
    debug('hook', `onCheck → ${item.plugin.manifest.name}`)
    const result = await guardHook(item.plugin.manifest.name, 'onCheck', () =>
      hook({ ...context, options: item.options, tableScope }),
    )
    if (!result) continue
    debug(
      'hook',
      `onCheck ← ${item.plugin.manifest.name}: ok=${result.ok}, findings=${result.findings.length}`,
    )
    results.push({
      plugin: result.plugin || item.plugin.manifest.name,
      evaluated: result.evaluated,
      ok: result.ok,
      findings: result.findings,
      metadata: result.metadata,
    })
  }
  return results
}

export async function runOnCheckReport(
  byName: Map<string, LoadedPlugin>,
  results: ChxOnCheckResult[],
  print: (line: string) => void,
): Promise<void> {
  for (const result of results) {
    const item = byName.get(result.plugin)
    if (!item) continue
    const hook = item.plugin.hooks?.onCheckReport
    if (!hook) continue
    await guardHook(item.plugin.manifest.name, 'onCheckReport', () =>
      hook({ result, print }),
    )
  }
}

export async function runOnBeforePluginCommand(
  loaded: LoadedPlugin[],
  pluginName: string,
  commandName: string,
  context: Omit<ChxOnBeforePluginCommandContext, 'targetPlugin' | 'command' | 'options'>,
): Promise<ChxOnBeforePluginCommandResult> {
  for (const item of loaded) {
    if (item.plugin.manifest.name === pluginName) continue
    const hook = item.plugin.hooks?.onBeforePluginCommand
    if (!hook) continue
    debug(
      'hook',
      `onBeforePluginCommand → ${item.plugin.manifest.name} (target: ${pluginName}:${commandName})`,
    )
    const result = await guardHook(
      item.plugin.manifest.name,
      'onBeforePluginCommand',
      () =>
        hook({
          ...context,
          targetPlugin: pluginName,
          command: commandName,
          options: item.options,
        }),
    )
    if (result.handled) {
      debug(
        'hook',
        `onBeforePluginCommand ← ${item.plugin.manifest.name} handled command (exitCode: ${result.exitCode})`,
      )
      return result
    }
  }
  return { handled: false }
}

export { UNFILTERED_TABLE_SCOPE }
