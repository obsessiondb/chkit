import process from 'node:process'
import { pathToFileURL } from 'node:url'

import fg from 'fast-glob'

import { canonicalizeDefinitions, collectDefinitionsFromModule } from './canonical.js'
import type { SchemaDefinition } from './model.js'

export interface SchemaLoaderOptions {
  cwd?: string
}

export async function loadSchemaDefinitions(
  schemaGlobs: string | string[],
  options: SchemaLoaderOptions = {}
): Promise<SchemaDefinition[]> {
  const patterns = Array.isArray(schemaGlobs) ? schemaGlobs : [schemaGlobs]
  const files = await fg(patterns, {
    cwd: options.cwd ?? process.cwd(),
    absolute: true,
  })

  if (files.length === 0) {
    throw new Error('No schema files matched. Check config.schema patterns.')
  }

  const all: SchemaDefinition[] = []
  for (const file of files) {
    const mod = (await import(pathToFileURL(file).href)) as Record<string, unknown>
    all.push(...collectDefinitionsFromModule(mod))
  }

  return canonicalizeDefinitions(all)
}
