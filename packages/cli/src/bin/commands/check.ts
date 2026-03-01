import { mkdir } from 'node:fs/promises'

import { summarizeDriftReasons } from '../../drift.js'
import { typedFlags, type CommandDef, type CommandRunContext } from '../../plugins.js'
import { withClickHouseExecutor } from '../clickhouse-resource.js'
import { GLOBAL_FLAGS } from '../global-flags.js'
import { emitJson } from '../json-output.js'
import { createJournalStore } from '../journal-store.js'
import { findChecksumMismatches, listMigrations, readSnapshot } from '../migration-store.js'
import { resolveTableScope, tableKeysFromDefinitions } from '../table-scope.js'
import { buildDriftPayload } from './drift.js'

export const checkCommand: CommandDef = {
  name: 'check',
  description: 'Run policy checks for CI and release gates',
  flags: [
    { name: '--strict', type: 'boolean', description: 'Enable all policy checks' },
  ],
  run: cmdCheck,
}

async function cmdCheck(ctx: CommandRunContext): Promise<void> {
  const { flags, config, configPath, dirs, pluginRuntime } = ctx
  const f = typedFlags(flags, [...GLOBAL_FLAGS, { name: '--strict', type: 'boolean', description: 'Enable all policy checks' }] as const)
  const strict = f['--strict'] === true
  const jsonMode = f['--json'] === true
  const tableSelector = f['--table']
  const { migrationsDir, metaDir } = dirs
  await mkdir(migrationsDir, { recursive: true })

  if (!config.clickhouse) {
    throw new Error('clickhouse config is required for check (journal is stored in ClickHouse)')
  }

  await withClickHouseExecutor(config.clickhouse, async (db) => {
    const journalStore = createJournalStore(db)

    const files = await listMigrations(migrationsDir)
    const journal = await journalStore.readJournal()
    const appliedNames = new Set(journal.applied.map((entry) => entry.name))
    const pending = files.filter((f) => !appliedNames.has(f))
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
      return
    }
    const drift = snapshot ? await buildDriftPayload(config, metaDir, snapshot, tableScope) : null

    const policy = {
      failOnPending: strict ? true : config.check?.failOnPending ?? true,
      failOnChecksumMismatch: strict ? true : config.check?.failOnChecksumMismatch ?? true,
      failOnDrift: strict ? true : config.check?.failOnDrift ?? true,
    }

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

    const failedChecks: string[] = []
    if (policy.failOnPending && pending.length > 0) failedChecks.push('pending_migrations')
    if (policy.failOnChecksumMismatch && checksumMismatches.length > 0) failedChecks.push('checksum_mismatch')
    if (policy.failOnDrift && drift?.drifted) failedChecks.push('schema_drift')
    for (const result of pluginResults) {
      const hasErrorFinding = result.findings.some((finding) => finding.severity === 'error')
      if (result.evaluated && !result.ok && hasErrorFinding) {
        failedChecks.push(`plugin:${result.plugin}`)
      }
    }
    const ok = failedChecks.length === 0
    const driftReasonSummary = drift
      ? summarizeDriftReasons({
          objectDrift: drift.objectDrift,
          tableDrift: drift.tableDrift,
        })
      : { counts: {}, total: 0, object: 0, table: 0 }

    const payload = {
      strict,
      policy,
      ok,
      failedChecks,
      pendingCount: pending.length,
      checksumMismatchCount: checksumMismatches.length,
      drifted: drift?.drifted ?? false,
      driftEvaluated: drift !== null,
      driftReasonCounts: driftReasonSummary.counts,
      driftReasonTotals: {
        total: driftReasonSummary.total,
        object: driftReasonSummary.object,
        table: driftReasonSummary.table,
      },
      plugins: Object.fromEntries(
        pluginResults.map((result) => [
          result.plugin,
          {
            evaluated: result.evaluated,
            ok: result.ok,
            findingCodes: result.findings.map((finding) => finding.code),
            ...(result.metadata ?? {}),
          },
        ])
      ),
      scope: tableScope,
    }

    if (jsonMode) {
      emitJson('check', payload)
      if (!ok) process.exitCode = 1
      return
    }

    console.log(`Check status: ${ok ? 'ok' : 'failed'}`)
    console.log(
      `Policy: pending=${policy.failOnPending ? 'on' : 'off'}, checksum=${policy.failOnChecksumMismatch ? 'on' : 'off'}, drift=${policy.failOnDrift ? 'on' : 'off'}`
    )
    console.log(`Pending migrations: ${pending.length}`)
    console.log(`Checksum mismatches: ${checksumMismatches.length}`)
    if (tableScope.enabled) {
      console.log(`Table scope: ${tableScope.selector ?? ''} (${tableScope.matchCount} matched)`)
      for (const table of tableScope.matchedTables) console.log(`- ${table}`)
    }
    if (drift === null) {
      console.log('Schema drift: not evaluated (missing snapshot or clickhouse config)')
    } else {
      console.log(`Schema drift: ${drift.drifted ? 'yes' : 'no'}`)
      const summary = summarizeDriftReasons({
        objectDrift: drift.objectDrift,
        tableDrift: drift.tableDrift,
      })
      console.log(
        `Drift reasons: total=${summary.total}, object=${summary.object}, table=${summary.table}`
      )
    }
    if (pluginResults.length > 0) {
      console.log('Plugin checks:')
      for (const result of pluginResults) {
        const findingCodes = result.findings.map((finding) => finding.code)
        console.log(
          `- ${result.plugin}: ${result.ok ? 'ok' : 'failed'}${findingCodes.length > 0 ? ` (${findingCodes.join(', ')})` : ''}`
        )
      }
      await pluginRuntime.runOnCheckReport(pluginResults, (line) => {
        console.log(line)
      })
    }
    if (!ok) {
      console.log(`Failed checks: ${failedChecks.join(', ')}`)
      process.exitCode = 1
    }
  })
}
