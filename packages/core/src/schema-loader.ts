import process from 'node:process'

import fg from 'fast-glob'

import { canonicalizeDefinitions, collectDefinitionsFromModule } from './canonical.js'
import type { SchemaDefinition } from './model.js'
import { importModuleFile } from './ts-import.js'

export interface SchemaLoaderOptions {
  cwd?: string
}

export async function loadSchemaDefinitions(
  schemaGlobs: string | string[],
  options: SchemaLoaderOptions = {}
): Promise<SchemaDefinition[]> {
  const modules = await loadDefinitionModules(schemaGlobs, options)
  return canonicalizeDefinitions(modules.flatMap(collectDefinitionsFromModule))
}

/** Load configured entry/schema modules so plugins can inspect their exported definitions. */
export async function loadDefinitionModules(
  schemaGlobs: string | string[],
  options: SchemaLoaderOptions = {}
): Promise<Record<string, unknown>[]> {
  const patterns = Array.isArray(schemaGlobs) ? schemaGlobs : [schemaGlobs]
  const files = await fg(patterns, {
    cwd: options.cwd ?? process.cwd(),
    absolute: true,
  })

  if (files.length === 0) {
    throw new Error('No schema files matched. Check config.schema patterns.')
  }

  const modules: Record<string, unknown>[] = []
  for (const file of files) modules.push(await importModuleFile(file))
  return modules
}
