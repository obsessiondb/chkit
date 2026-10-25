import * as Effect from 'effect/Effect'
import { fromPromise, runEffect } from '../../runtime/effect.js'
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
import { emitCheckJson, evaluateCheck, renderCheckText, resolvePolicy, type CheckInputs } from './output.js'

const STRICT_FLAG = { name: '--strict', type: 'boolean', description: 'Enable all policy checks' } as const

export const checkCommand: ChxPluginCommand = {
  name: 'check',
  description: 'Run policy checks for CI and release gates',
  flags: [STRICT_FLAG],
  run(context): Promise<undefined | number> {
    return runEffect(
      Effect.gen(function* () {
        const { flags, config, configPath, pluginRuntime, pluginContext } = context
        const f = typedFlags(flags, [...GLOBAL_FLAGS, STRICT_FLAG] as const)
        const strict = f['--strict'] === true
        const jsonMode = f['--json'] === true
        const tableSelector = f['--table']
        const { migrationsDir, metaDir } = resolveDirs(config)
        debug('check', `flags: strict=${strict}, json=${jsonMode}`)
        yield* fromPromise(() => mkdir(migrationsDir, { recursive: true }))

        if (!pluginContext.hasExecutor) {
          throw new Error('clickhouse config is required for check (journal is stored in ClickHouse)')
        }
        const db = pluginContext.executor
        const database = config.clickhouse?.database

        const journalStore = createJournalStore(db, config.clickhouse?.cluster)
        const files = yield* fromPromise(() => listMigrations(migrationsDir))
        const journal = yield* fromPromise(() => journalStore.readJournal())
        const databaseMissing = journalStore.databaseMissing
        const appliedNames = new Set(journal.applied.map((entry) => entry.name))
        const pending = files.filter((file) => !appliedNames.has(file))
        const checksumMismatches = yield* fromPromise(() => findChecksumMismatches(migrationsDir, journal))
        const snapshot = yield* fromPromise(() => readSnapshot(metaDir))
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

        const drift = snapshot
          ? yield* fromPromise(() => buildDriftPayload(config, metaDir, snapshot, tableScope, db))
          : null
        const policy = resolvePolicy(strict, config.check)

        yield* fromPromise(() =>
          pluginRuntime.runOnConfigLoaded({
            command: 'check',
            config,
            configPath,
            tableScope,
            flags,
          }),
        )
        const pluginResults = yield* fromPromise(() =>
          pluginRuntime.runOnCheck({
            command: 'check',
            config,
            configPath,
            jsonMode,
            tableScope,
            flags,
          }),
        )

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
          yield* fromPromise(() =>
            pluginRuntime.runOnCheckReport(pluginResults, (line) => {
              console.log(line)
            }),
          )
        }
        return 0
      }),
    )
  },
}
