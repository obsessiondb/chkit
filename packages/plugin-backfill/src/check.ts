import { join } from 'node:path'

import type { ResolvedChxConfig } from '@chkit/core'

import {
  computeBackfillStateDir,
  listPlanIds,
  readRun,
} from './state.js'
import type {
  BackfillPluginCheckResult,
} from './types.js'

export async function evaluateBackfillCheck(input: {
  configPath: string
  config: Pick<ResolvedChxConfig, 'metaDir'>
  stateDir?: string
  failCheckOnRequiredPendingBackfill: boolean
}): Promise<BackfillPluginCheckResult> {
  const stateDir = computeBackfillStateDir(input.config, input.configPath, input.stateDir)
  const plansDir = join(stateDir, 'plans')
  const runsDir = join(stateDir, 'runs')

  const planIds = await listPlanIds(plansDir)
  if (planIds.length === 0) {
    return {
      plugin: 'backfill',
      evaluated: true,
      ok: true,
      findings: [],
      metadata: {
        requiredCount: 0,
        activeRuns: 0,
        failedRuns: 0,
      },
    }
  }

  let requiredCount = 0
  let activeRuns = 0
  let failedRuns = 0

  for (const planId of planIds) {
    const runPath = join(runsDir, `${planId}.json`)
    const run = await readRun(runPath)
    if (!run) {
      requiredCount += 1
      continue
    }

    if (run.status === 'running') activeRuns += 1
    if (run.status === 'failed') failedRuns += 1
    if (run.status !== 'completed') requiredCount += 1
  }

  const findings: BackfillPluginCheckResult['findings'] = []
  if (requiredCount > 0) {
    findings.push({
      code: 'backfill_required_pending',
      message: `Required backfills pending completion: ${requiredCount}`,
      severity: input.failCheckOnRequiredPendingBackfill ? 'error' : 'warn',
      metadata: {
        requiredCount,
      },
    })
  }

  if (failedRuns > 0) {
    findings.push({
      code: 'backfill_chunk_failed_retry_exhausted',
      message: `Backfill runs failed after retry budget: ${failedRuns}`,
      severity: 'error',
      metadata: {
        failedRuns,
      },
    })
  }

  if (!input.failCheckOnRequiredPendingBackfill) {
    findings.push({
      code: 'backfill_policy_relaxed',
      message: 'Backfill check policy is relaxed: failCheckOnRequiredPendingBackfill=false.',
      severity: 'warn',
    })
  }

  const ok = findings.every((finding) => finding.severity !== 'error')
  return {
    plugin: 'backfill',
    evaluated: true,
    ok,
    findings,
    metadata: {
      requiredCount,
      activeRuns,
      failedRuns,
    },
  }
}
