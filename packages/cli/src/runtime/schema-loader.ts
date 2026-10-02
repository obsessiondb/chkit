import process from 'node:process'

import { loadSchemaDefinitions as loadSchemaDefinitionsFromCore } from '@chkit/core/schema-loader'
import type { ParsedFlags, ResolvedChxConfig, SchemaDefinition } from '@chkit/core'
import type { PluginRuntime } from '../plugins.js'
import { debug } from './debug.js'
import { resolveTableScope, tableKeysFromDefinitions } from './table-scope.js'

export interface LoadSchemaDefinitionsWithHooksInput {
  command: string
  config: ResolvedChxConfig
  configPath: string
  flags: ParsedFlags
  jsonMode: boolean
  tableSelector?: string
}

/**
 * Load schema definitions the way `chkit generate` does: the `onConfigLoaded`
 * hooks, the schema files, then the `onSchemaLoaded` hooks (which may rewrite
 * definitions, e.g. the ObsessionDB engine rewrite). `chkit snapshot rebuild`
 * uses the same pipeline so it writes exactly the snapshot `generate` would.
 */
export async function loadSchemaDefinitionsWithHooks(
  input: LoadSchemaDefinitionsWithHooksInput,
  deps: { pluginRuntime: PluginRuntime },
): Promise<SchemaDefinition[]> {
  await deps.pluginRuntime.runOnConfigLoaded({
    command: input.command,
    config: input.config,
    configPath: input.configPath,
    tableScope: resolveTableScope(input.tableSelector, []),
    flags: input.flags,
  })

  const definitions = await loadSchemaDefinitions(input.config.schema)
  return deps.pluginRuntime.runOnSchemaLoaded({
    command: input.command,
    config: input.config,
    tableScope: resolveTableScope(input.tableSelector, tableKeysFromDefinitions(definitions)),
    flags: input.flags,
    jsonMode: input.jsonMode,
    definitions,
  })
}

export async function loadSchemaDefinitions(schemaGlobs: string | string[]): Promise<SchemaDefinition[]> {
  const globs = Array.isArray(schemaGlobs) ? schemaGlobs : [schemaGlobs]
  debug('schema', `loading definitions from globs: [${globs.join(', ')}] (cwd: ${process.cwd()})`)
  const definitions = await loadSchemaDefinitionsFromCore(schemaGlobs, { cwd: process.cwd() })
  debug('schema', `loaded ${definitions.length} schema definitions`)
  return definitions
}
