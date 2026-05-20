import { summarizeDriftReasons } from '../drift/compare.js'
import type { DriftPayload } from '../drift/payload.js'
import type { ChxOnCheckResult, TableScope } from '../../plugins.js'
import { emitJson } from '../../runtime/json-output.js'

export interface CheckPolicy {
  failOnPending: boolean
  failOnChecksumMismatch: boolean
  failOnDrift: boolean
}

export interface CheckInputs {
  strict: boolean
  policy: CheckPolicy
  pending: string[]
  checksumMismatches: { name: string; expected: string; actual: string }[]
  drift: DriftPayload | null
  pluginResults: ChxOnCheckResult[]
  tableScope: TableScope
  databaseMissing: boolean
  database: string | undefined
}

export interface CheckResult {
  ok: boolean
  failedChecks: string[]
}

export function evaluateCheck(inputs: CheckInputs): CheckResult {
  const { policy, pending, checksumMismatches, drift, pluginResults } = inputs
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
  return { ok: failedChecks.length === 0, failedChecks }
}

function buildPayload(inputs: CheckInputs, result: CheckResult) {
  const driftReasonSummary = inputs.drift
    ? summarizeDriftReasons({
        objectDrift: inputs.drift.objectDrift,
        tableDrift: inputs.drift.tableDrift,
      })
    : { counts: {}, total: 0, object: 0, table: 0 }

  return {
    strict: inputs.strict,
    policy: inputs.policy,
    ok: result.ok,
    failedChecks: result.failedChecks,
    pendingCount: inputs.pending.length,
    checksumMismatchCount: inputs.checksumMismatches.length,
    drifted: inputs.drift?.drifted ?? false,
    driftEvaluated: inputs.drift !== null,
    driftReasonCounts: driftReasonSummary.counts,
    driftReasonTotals: {
      total: driftReasonSummary.total,
      object: driftReasonSummary.object,
      table: driftReasonSummary.table,
    },
    plugins: Object.fromEntries(
      inputs.pluginResults.map((entry) => [
        entry.plugin,
        {
          evaluated: entry.evaluated,
          ok: entry.ok,
          findingCodes: entry.findings.map((finding) => finding.code),
          ...(entry.metadata ?? {}),
        },
      ]),
    ),
    scope: inputs.tableScope,
    ...(inputs.databaseMissing ? { databaseMissing: true, database: inputs.database } : {}),
  }
}

export function emitCheckJson(inputs: CheckInputs, result: CheckResult): void {
  emitJson('check', buildPayload(inputs, result))
  if (!result.ok) process.exitCode = 1
}

export function renderCheckText(inputs: CheckInputs, result: CheckResult): void {
  const { policy, pending, checksumMismatches, drift, pluginResults, tableScope, databaseMissing, database } = inputs

  if (databaseMissing) {
    console.log(`⚠ Database "${database}" does not exist on the target server.`)
    console.log('  It will be created when you run: chkit migrate --apply\n')
  }

  console.log(`Check status: ${result.ok ? 'ok' : 'failed'}`)
  console.log(
    `Policy: pending=${policy.failOnPending ? 'on' : 'off'}, checksum=${policy.failOnChecksumMismatch ? 'on' : 'off'}, drift=${policy.failOnDrift ? 'on' : 'off'}`,
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
    console.log(`Drift reasons: total=${summary.total}, object=${summary.object}, table=${summary.table}`)
  }
  if (pluginResults.length > 0) {
    console.log('Plugin checks:')
    for (const entry of pluginResults) {
      const findingCodes = entry.findings.map((finding) => finding.code)
      console.log(
        `- ${entry.plugin}: ${entry.ok ? 'ok' : 'failed'}${findingCodes.length > 0 ? ` (${findingCodes.join(', ')})` : ''}`,
      )
    }
  }
  if (!result.ok) {
    console.log(`Failed checks: ${result.failedChecks.join(', ')}`)
    process.exitCode = 1
  }
}

export function resolvePolicy(strict: boolean, configCheck: { failOnPending?: boolean; failOnChecksumMismatch?: boolean; failOnDrift?: boolean } | undefined): CheckPolicy {
  return {
    failOnPending: strict ? true : configCheck?.failOnPending ?? true,
    failOnChecksumMismatch: strict ? true : configCheck?.failOnChecksumMismatch ?? true,
    failOnDrift: strict ? true : configCheck?.failOnDrift ?? true,
  }
}
