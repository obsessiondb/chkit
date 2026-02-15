import process from 'node:process'

import { loadSchemaDefinitions as loadSchemaDefinitionsFromCore, type SchemaDefinition } from '@chkit/core'

export async function loadSchemaDefinitions(schemaGlobs: string | string[]): Promise<SchemaDefinition[]> {
  return loadSchemaDefinitionsFromCore(schemaGlobs, { cwd: process.cwd() })
}
