import { join } from 'node:path'

import { createClickHouseExecutor } from '@chkit/clickhouse'
import type { ChxConfig, Snapshot, TableDefinition } from '@chkit/core'

import { typedFlags, type CommandDef, type CommandRunContext } from '../../plugins.js'
import { GLOBAL_FLAGS } from '../global-flags.js'
import {
  compareSchemaObjects,
  compareTableShape,
  type ObjectDriftDetail,
  type TableDriftDetail,
} from '../../drift.js'
import { emitJson } from '../json-output.js'
import { readSnapshot } from '../migration-store.js'
import { resolveTableScope, tableKeysFromDefinitions, type TableScope } from '../table-scope.js'

export interface DriftPayload {
  scope?: TableScope
  snapshotFile: string
  expectedCount: number
  actualCount: number
  drifted: boolean
  missing: string[]
  extra: string[]
  kindMismatches: Array<{ expected: string; actual: string; object: string }>
  objectDrift: ObjectDriftDetail[]
  tableDrift: TableDriftDetail[]
}

export const driftCommand: CommandDef = {
  name: 'drift',
  description: 'Compare snapshot state with current ClickHouse objects',
  flags: [],
  run: cmdDrift,
}

export async function buildDriftPayload(
  config: ChxConfig,
  metaDir: string,
  snapshot: Snapshot,
  scope?: TableScope
): Promise<DriftPayload> {
  const selectedTables =
    scope?.enabled && scope.matchCount > 0 ? new Set(scope.matchedTables) : undefined
  if (!config.clickhouse) throw new Error('clickhouse config is required for drift checks')
  const db = createClickHouseExecutor(config.clickhouse)
  const actualObjects = await db.listSchemaObjects()
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

  const drifted =
    missing.length > 0 ||
    extra.length > 0 ||
    kindMismatches.length > 0 ||
    objectDrift.length > 0 ||
    tableDrift.length > 0
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

async function cmdDrift(ctx: CommandRunContext): Promise<void> {
  const { flags, config, dirs } = ctx
  const f = typedFlags(flags, GLOBAL_FLAGS)
  const tableSelector = f['--table']
  const jsonMode = f['--json'] === true
  const { metaDir } = dirs
  const snapshot = await readSnapshot(metaDir)
  if (!snapshot) {
    throw new Error('Snapshot not found. Run `chkit generate` before drift checks.')
  }
  const scope = resolveTableScope(tableSelector, tableKeysFromDefinitions(snapshot.definitions))
  if (scope.enabled && scope.matchCount === 0) {
    const payload: DriftPayload = {
      scope,
      snapshotFile: join(metaDir, 'snapshot.json'),
      expectedCount: 0,
      actualCount: 0,
      drifted: false,
      missing: [],
      extra: [],
      kindMismatches: [],
      objectDrift: [],
      tableDrift: [],
    }
    if (jsonMode) {
      emitJson('drift', {
        ...payload,
        warning: `No tables matched selector "${scope.selector ?? ''}".`,
      })
      return
    }
    console.log(`No tables matched selector "${scope.selector ?? ''}". Drift check is a no-op.`)
    return
  }
  const payload = await buildDriftPayload(config, metaDir, snapshot, scope)

  if (jsonMode) {
    emitJson('drift', payload)
    return
  }

  console.log(`Expected objects: ${payload.expectedCount}`)
  console.log(`Actual objects:   ${payload.actualCount}`)
  console.log(`Drifted:          ${payload.drifted ? 'yes' : 'no'}`)
  if (payload.scope?.enabled) {
    console.log(`Table scope:      ${payload.scope.selector ?? ''} (${payload.scope.matchCount} matched)`)
    for (const table of payload.scope.matchedTables) console.log(`- ${table}`)
  }
  if (payload.missing.length > 0) {
    console.log('\nMissing objects:')
    for (const item of payload.missing) console.log(`- ${item}`)
  }
  if (payload.extra.length > 0) {
    console.log('\nUnexpected objects:')
    for (const item of payload.extra) console.log(`- ${item}`)
  }
  if (payload.kindMismatches.length > 0) {
    console.log('\nKind mismatches:')
    for (const item of payload.kindMismatches) {
      console.log(`- ${item.object}: expected=${item.expected} actual=${item.actual}`)
    }
  }
  if (payload.objectDrift.length > 0) {
    console.log('\nObject drift reasons:')
    for (const item of payload.objectDrift) {
      if (item.code === 'kind_mismatch') {
        console.log(
          `- ${item.code} ${item.object}: expected=${item.expectedKind ?? ''} actual=${item.actualKind ?? ''}`
        )
        continue
      }
      console.log(`- ${item.code} ${item.object}`)
    }
  }
  if (payload.tableDrift.length > 0) {
    console.log('\nTable shape drift:')
    for (const item of payload.tableDrift) {
      console.log(`- ${item.table}`)
      if (item.missingColumns.length > 0) console.log(`  missingColumns=${item.missingColumns.join(',')}`)
      if (item.extraColumns.length > 0) console.log(`  extraColumns=${item.extraColumns.join(',')}`)
      if (item.changedColumns.length > 0) console.log(`  changedColumns=${item.changedColumns.join(',')}`)
      if (item.settingDiffs.length > 0) console.log(`  settingDiffs=${item.settingDiffs.join(',')}`)
      if (item.indexDiffs.length > 0) console.log(`  indexDiffs=${item.indexDiffs.join(',')}`)
      if (item.ttlMismatch) console.log('  ttlMismatch=true')
      if (item.engineMismatch) console.log('  engineMismatch=true')
      if (item.primaryKeyMismatch) console.log('  primaryKeyMismatch=true')
      if (item.orderByMismatch) console.log('  orderByMismatch=true')
      if (item.uniqueKeyMismatch) console.log('  uniqueKeyMismatch=true')
      if (item.partitionByMismatch) console.log('  partitionByMismatch=true')
      if (item.projectionDiffs.length > 0) {
        console.log(`  projectionDiffs=${item.projectionDiffs.join(',')}`)
      }
      console.log(`  reasonCodes=${item.reasonCodes.join(',')}`)
    }
  }
}
