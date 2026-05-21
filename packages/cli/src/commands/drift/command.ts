import { join } from 'node:path'

import { typedFlags, type ChxPluginCommand } from '../../plugins.js'
import { resolveDirs } from '../../runtime/config.js'
import { GLOBAL_FLAGS } from '../../runtime/global-flags.js'
import { emitJson } from '../../runtime/json-output.js'
import { readSnapshot } from '../../runtime/migration-store.js'
import { resolveTableScope, tableKeysFromDefinitions } from '../../runtime/table-scope.js'
import { buildDriftPayload, type DriftPayload } from './payload.js'

export const driftCommand: ChxPluginCommand = {
  name: 'drift',
  description: 'Compare snapshot state with current ClickHouse objects',
  flags: [],
  async run(context): Promise<undefined | number> {
    const { flags, config, pluginContext } = context
    const f = typedFlags(flags, GLOBAL_FLAGS)
    const tableSelector = f['--table']
    const jsonMode = f['--json'] === true
    const { metaDir } = resolveDirs(config)
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
        return 0
      }
      console.log(`No tables matched selector "${scope.selector ?? ''}". Drift check is a no-op.`)
      return 0
    }
    if (!pluginContext.hasExecutor) {
      throw new Error('clickhouse config is required for drift checks')
    }
    const payload = await buildDriftPayload(config, metaDir, snapshot, scope, pluginContext.executor)

    if (jsonMode) {
      emitJson('drift', payload)
      return 0
    }

    if (payload.databaseMissing) {
      console.log(`⚠ Database "${payload.database ?? ''}" does not exist on the target server.`)
      console.log('  It will be created when you run: chkit migrate --apply\n')
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
    return 0
  },
}
