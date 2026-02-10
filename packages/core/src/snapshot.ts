import { canonicalizeDefinitions } from './canonical.js'
import type { SchemaDefinition, Snapshot } from './model.js'

export function createSnapshot(definitions: SchemaDefinition[]): Snapshot {
  return {
    version: 1,
    generatedAt: new Date().toISOString(),
    definitions: canonicalizeDefinitions(definitions),
  }
}
