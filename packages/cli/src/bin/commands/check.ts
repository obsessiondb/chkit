import { mkdir } from 'node:fs/promises'

import { summarizeDriftReasons } from '../../drift.js'
import {
  emitJson,
  findChecksumMismatches,
  getCommandContext,
  hasFlag,
  listMigrations,
  readJournal,
  readSnapshot,
} from '../lib.js'
import { buildDriftPayload } from './drift.js'

export async function cmdCheck(args: string[]): Promise<void> {
  const strict = hasFlag('--strict', args)
  const { config, dirs, jsonMode } = await getCommandContext(args)
  const { migrationsDir, metaDir } = dirs
  await mkdir(migrationsDir, { recursive: true })

  const files = await listMigrations(migrationsDir)
  const journal = await readJournal(metaDir)
  const appliedNames = new Set(journal.applied.map((entry) => entry.name))
  const pending = files.filter((f) => !appliedNames.has(f))
  const checksumMismatches = await findChecksumMismatches(migrationsDir, journal)
  const snapshot = await readSnapshot(metaDir)
  const drift = snapshot && config.clickhouse ? await buildDriftPayload(config, metaDir, snapshot) : null

  const policy = {
    failOnPending: strict ? true : config.check?.failOnPending ?? true,
    failOnChecksumMismatch: strict ? true : config.check?.failOnChecksumMismatch ?? true,
    failOnDrift: strict ? true : config.check?.failOnDrift ?? true,
  }

  const failedChecks: string[] = []
  if (policy.failOnPending && pending.length > 0) failedChecks.push('pending_migrations')
  if (policy.failOnChecksumMismatch && checksumMismatches.length > 0) failedChecks.push('checksum_mismatch')
  if (policy.failOnDrift && drift?.drifted) failedChecks.push('schema_drift')
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
  if (!ok) {
    console.log(`Failed checks: ${failedChecks.join(', ')}`)
    process.exitCode = 1
  }
}
