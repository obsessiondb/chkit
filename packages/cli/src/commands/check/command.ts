import { mkdir } from 'node:fs/promises'

import { typedFlags, type ChxPluginCommand } from '../../plugins.js'
import { resolveDirs } from '../../runtime/config.js'
import { debug } from '../../runtime/debug.js'
import { GLOBAL_FLAGS } from '../../runtime/global-flags.js'
import { emitJson } from '../../runtime/json-output.js'
import { createJournalStore } from '../../runtime/journal-store.js'
import { findChecksumMismatches, listMigrations, readSnapshot } from '../../runtime/migration-store.js'
import { resolveTableScope, tableKeysFromDefinitions } from '../../runtime/table-scope.js'
import { buildDriftPayload } from '../drift/payload.js'
import {
  emitCheckJson,
  evaluateCheck,
  renderCheckText,
  resolvePolicy,
  type CheckInputs,
} from './output.js'

const STRICT_FLAG = { name: '--strict', type: 'boolean', description: 'Enable all policy checks' } as const

export const checkCommand: ChxPluginCommand = {
  name: 'check',
  description: 'Run policy checks for CI and release gates',
  flags: [STRICT_FLAG],
  async run(context): Promise<undefined | number> {
    const { flags, config, configPath, pluginRuntime, pluginContext } = context
    const f = typedFlags(flags, [...GLOBAL_FLAGS, STRICT_FLAG] as const)
    const strict = f['--strict'] === true
    const jsonMode = f['--json'] === true
    const tableSelector = f['--table']
    const { migrationsDir, metaDir } = resolveDirs(config)
    debug('check', `flags: strict=${strict}, json=${jsonMode}`)
    await mkdir(migrationsDir, { recursive: true })

    if (!pluginContext.hasExecutor) {
      throw new Error('clickhouse config is required for check (journal is stored in ClickHouse)')
    }
    const db = pluginContext.executor
    const database = config.clickhouse?.database

    const journalStore = createJournalStore(db)
    const files = await listMigrations(migrationsDir)
    const journal = await journalStore.readJournal()
    const databaseMissing = journalStore.databaseMissing
    const appliedNames = new Set(journal.applied.map((entry) => entry.name))
    const pending = files.filter((file) => !appliedNames.has(file))
    const checksumMismatches = await findChecksumMismatches(migrationsDir, journal)
    const snapshot = await readSnapshot(metaDir)
    const tableScope = resolveTableScope(tableSelector, tableKeysFromDefinitions(snapshot?.definitions ?? []))

    if (tableScope.enabled && tableScope.matchCount === 0) {
      const payload = {
        strict,
        ok: true,
        failedChecks: [],
        pendingCount: 0,
        checksumMismatchCount: 0,
        drifted: false,
        driftEvaluated: false,
        driftReasonCounts: {},
        driftReasonTotals: { total: 0, object: 0, table: 0 },
        plugins: {},
        scope: tableScope,
        warning: `No tables matched selector "${tableScope.selector ?? ''}".`,
      }
      if (jsonMode) {
        emitJson('check', payload)
      } else {
        console.log(`No tables matched selector "${tableScope.selector ?? ''}". Check is a no-op.`)
      }
      return 0
    }

    const drift = snapshot ? await buildDriftPayload(config, metaDir, snapshot, tableScope, db) : null
    const policy = resolvePolicy(strict, config.check)

    await pluginRuntime.runOnConfigLoaded({
      command: 'check',
      config,
      configPath,
      tableScope,
      flags,
    })
    const pluginResults = await pluginRuntime.runOnCheck({
      command: 'check',
      config,
      configPath,
      jsonMode,
      tableScope,
      flags,
    })

    const inputs: CheckInputs = {
      strict,
      policy,
      pending,
      checksumMismatches,
      drift,
      pluginResults,
      tableScope,
      databaseMissing,
      database,
    }
    const result = evaluateCheck(inputs)

    debug(
      'check',
      `results: pending=${pending.length}, checksumMismatches=${checksumMismatches.length}, drift=${drift?.drifted ?? 'n/a'}, pluginChecks=${pluginResults.length}, failedChecks=[${result.failedChecks.join(', ')}]`,
    )

    if (jsonMode) {
      emitCheckJson(inputs, result)
      return 0
    }

    renderCheckText(inputs, result)
    if (pluginResults.length > 0) {
      await pluginRuntime.runOnCheckReport(pluginResults, (line) => {
        console.log(line)
      })
    }
    return 0
  },
}
