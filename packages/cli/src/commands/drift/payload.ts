import { join } from 'node:path'

import { isUnknownDatabaseError, type ClickHouseExecutor, type SchemaObjectRef } from '@chkit/clickhouse'
import type { ChxConfig, Snapshot, TableDefinition } from '@chkit/core'

import { debug } from '../../runtime/debug.js'
import type { TableScope } from '../../runtime/table-scope.js'
import {
  compareSchemaObjects,
  compareTableShape,
  type ObjectDriftDetail,
  type TableDriftDetail,
} from './compare.js'

export interface DriftPayload {
  scope?: TableScope
  snapshotFile: string
  expectedCount: number
  actualCount: number
  drifted: boolean
  databaseMissing?: boolean
  database?: string
  missing: string[]
  extra: string[]
  kindMismatches: Array<{ expected: string; actual: string; object: string }>
  objectDrift: ObjectDriftDetail[]
  tableDrift: TableDriftDetail[]
}

/**
 * Decide whether a schema has drifted. Objects that exist in ClickHouse but are
 * not in the schema (`extra_object` → `extraCount`) are NOT drift by default:
 * on a shared database every unmanaged table would otherwise break the CI gate.
 * Opt in with `check.failOnExtraObjects` to treat them as drift (e.g. when chkit
 * owns the whole database).
 */
export function computeDrifted(input: {
  missingCount: number
  kindMismatchCount: number
  tableDriftCount: number
  extraCount: number
  failOnExtraObjects: boolean
}): boolean {
  return (
    input.missingCount > 0 ||
    input.kindMismatchCount > 0 ||
    input.tableDriftCount > 0 ||
    (input.failOnExtraObjects && input.extraCount > 0)
  )
}

export async function buildDriftPayload(
  config: ChxConfig,
  metaDir: string,
  snapshot: Snapshot,
  scope?: TableScope,
  executor?: ClickHouseExecutor
): Promise<DriftPayload> {
  const selectedTables =
    scope?.enabled && scope.matchCount > 0 ? new Set(scope.matchedTables) : undefined
  if (!executor) throw new Error('clickhouse config is required for drift checks')
  const db = executor

  debug('drift', `building drift payload — expected: ${snapshot.definitions.length} definitions`)
  let actualObjects: SchemaObjectRef[]
  try {
    actualObjects = await db.listSchemaObjects()
  } catch (error) {
    if (isUnknownDatabaseError(error)) {
      const allExpected = snapshot.definitions
        .filter((def) => {
          if (!selectedTables) return true
          if (def.kind !== 'table') return true
          return selectedTables.has(`${def.database}.${def.name}`)
        })
        .map((def) => `${def.database}.${def.name}`)
      return {
        scope,
        snapshotFile: join(metaDir, 'snapshot.json'),
        expectedCount: allExpected.length,
        actualCount: 0,
        drifted: allExpected.length > 0,
        databaseMissing: true,
        database: config.clickhouse?.database,
        missing: allExpected,
        extra: [],
        kindMismatches: [],
        objectDrift: [],
        tableDrift: [],
      }
    }
    throw error
  }
  const expectedObjects = snapshot.definitions
    .filter((def) => {
      if (!selectedTables) return true
      if (def.kind !== 'table') return true
      return selectedTables.has(`${def.database}.${def.name}`)
    })
    .map((def) => ({
      kind: def.kind,
      database: def.database,
      name: def.name,
    }))
  const expectedDatabases = new Set(expectedObjects.map((def) => def.database))
  const actualInScope = actualObjects.filter((item) => expectedDatabases.has(item.database))

  const { missing, extra, kindMismatches, objectDrift } = compareSchemaObjects(
    expectedObjects,
    actualInScope
  )

  const expectedTables = snapshot.definitions.filter((def): def is TableDefinition => {
    if (def.kind !== 'table') return false
    if (!selectedTables) return true
    return selectedTables.has(`${def.database}.${def.name}`)
  })
  const expectedTableMap = new Map(
    expectedTables.map((table) => [`${table.database}.${table.name}`, table])
  )
  const actualTables = await db.listTableDetails([...expectedDatabases])
  const tableDrift = actualTables
    .map((actual) => {
      const expected = expectedTableMap.get(`${actual.database}.${actual.name}`)
      if (!expected) return null
      return compareTableShape(expected, actual)
    })
    .filter((item): item is NonNullable<typeof item> => item !== null)
    .sort((a, b) => a.table.localeCompare(b.table))

  debug('drift', `comparison: missing=${missing.length}, extra=${extra.length}, kindMismatches=${kindMismatches.length}, objectDrift=${objectDrift.length}, tableDrift=${tableDrift.length}`)

  const drifted = computeDrifted({
    missingCount: missing.length,
    kindMismatchCount: kindMismatches.length,
    tableDriftCount: tableDrift.length,
    extraCount: extra.length,
    failOnExtraObjects: config.check?.failOnExtraObjects === true,
  })
  return {
    scope,
    snapshotFile: join(metaDir, 'snapshot.json'),
    expectedCount: expectedObjects.length,
    actualCount: actualInScope.length,
    drifted,
    missing,
    extra,
    kindMismatches,
    objectDrift,
    tableDrift,
  }
}
