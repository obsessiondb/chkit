import { join } from 'node:path'

import type { ResolvedChxConfig } from '@chkit/core'

import {
  computeBackfillStateDir,
  listPlanIds,
  readRun,
  readSubmission,
} from './state.js'
import type {
  BackfillPluginCheckResult,
} from './types.js'

export async function evaluateBackfillCheck(input: {
  configPath: string
  config: Pick<ResolvedChxConfig, 'metaDir' | 'plugins'>
  stateDir?: string
  failCheckOnRequiredPendingBackfill: boolean
}): Promise<BackfillPluginCheckResult> {
  const stateDir = computeBackfillStateDir(input.config, input.configPath, input.stateDir)
  const plansDir = join(stateDir, 'plans')
  const runsDir = join(stateDir, 'runs')
  const submissionsDir = join(stateDir, 'submissions')

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
        submittedCount: 0,
      },
    }
  }

  let requiredCount = 0
  let activeRuns = 0
  let failedRuns = 0
  let submittedCount = 0
  let unconfirmedCount = 0

  for (const planId of planIds) {
    const runPath = join(runsDir, `${planId}.json`)
    const run = await readRun(runPath)
    if (!run) {
      // A managed job runs on the backend and never writes a local run. Its
      // backend's plugin (e.g. ObsessionDB) checks whether the job completed,
      // so it is not pending here. A local run, if any, still wins.
      const submission = await readSubmission(join(submissionsDir, `${planId}.json`))
      if (!submission) requiredCount += 1
      else {
        submittedCount += 1
        if (submission.status !== 'completed') unconfirmedCount += 1
      }
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

  // Only the ObsessionDB plugin asks the jobs API whether a submitted job
  // completed. Without it (e.g. on CI, where no login session adds it to the
  // config) an unconfirmed submitted plan would otherwise pass unverified.
  if (unconfirmedCount > 0 && !hasObsessionDBPlugin(input.config.plugins)) {
    findings.push({
      code: 'backfill_submitted_unverified',
      message:
        `Submitted backfills not verified: ${unconfirmedCount}. Only the ObsessionDB plugin checks their jobs, and it is ` +
        'not loaded: register obsessiondb() in the config plugins and log in with chkit obsessiondb login.',
      severity: input.failCheckOnRequiredPendingBackfill ? 'error' : 'warn',
      metadata: {
        unconfirmedCount,
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
      submittedCount,
    },
  }
}

function hasObsessionDBPlugin(plugins: ResolvedChxConfig['plugins']): boolean {
  return plugins.some((entry) => entry.enabled !== false && pluginName(entry.plugin) === 'obsessiondb')
}

function pluginName(plugin: unknown): string | undefined {
  if (typeof plugin !== 'object' || plugin === null || !('manifest' in plugin)) return undefined
  const { manifest } = plugin
  if (typeof manifest !== 'object' || manifest === null || !('name' in manifest)) return undefined
  return typeof manifest.name === 'string' ? manifest.name : undefined
}
