import process from 'node:process'

import { loadSchemaDefinitions as loadSchemaDefinitionsFromCore } from '@chkit/core/schema-loader'
import type { SchemaDefinition } from '@chkit/core'
import { debug } from './debug.js'

export async function loadSchemaDefinitions(schemaGlobs: string | string[]): Promise<SchemaDefinition[]> {
  const globs = Array.isArray(schemaGlobs) ? schemaGlobs : [schemaGlobs]
  debug('schema', `loading definitions from globs: [${globs.join(', ')}] (cwd: ${process.cwd()})`)
  const definitions = await loadSchemaDefinitionsFromCore(schemaGlobs, { cwd: process.cwd() })
  debug('schema', `loaded ${definitions.length} schema definitions`)
  return definitions
}
