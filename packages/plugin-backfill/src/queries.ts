import type { ResolvedChxConfig } from '@chkit/core'

import { BackfillConfigError } from './errors.js'
import {
  backfillPaths,
  nowIso,
  readPlan,
  readRun,
  summarizeRunStatus,
  writeJson,
} from './state.js'
import type {
  BackfillDoctorReport,
  BackfillStatusSummary,
} from './types.js'

export async function getBackfillStatus(input: {
  planId: string
  configPath: string
  config: Pick<ResolvedChxConfig, 'metaDir'>
  stateDir?: string
}): Promise<BackfillStatusSummary> {
  const { plan, stateDir } = await readPlan({
    planId: input.planId,
    configPath: input.configPath,
    config: input.config,
    stateDir: input.stateDir,
  })
  const paths = backfillPaths(stateDir, plan.planId)
  const run = await readRun(paths.runPath)

  if (!run) {
    return {
      planId: plan.planId,
      target: plan.target,
      status: 'planned',
      totals: {
        total: plan.chunks.length,
        pending: plan.chunks.length,
        submitted: 0,
        running: 0,
        done: 0,
        failed: 0,
      },
      rowsWritten: 0,
      updatedAt: plan.createdAt,
      runPath: paths.runPath,
    }
  }

  return summarizeRunStatus(run, paths.runPath, plan)
}

export async function cancelBackfillRun(input: {
  planId: string
  configPath: string
  config: Pick<ResolvedChxConfig, 'metaDir'>
  stateDir?: string
}): Promise<BackfillStatusSummary> {
  const { plan, stateDir } = await readPlan({
    planId: input.planId,
    configPath: input.configPath,
    config: input.config,
    stateDir: input.stateDir,
  })
  const paths = backfillPaths(stateDir, plan.planId)
  const run = await readRun(paths.runPath)

  if (!run) {
    throw new BackfillConfigError(
      `Run state not found for plan ${plan.planId}. Start with backfill run before cancel.`
    )
  }
  if (run.status === 'completed') {
    throw new BackfillConfigError(`Run already completed for plan ${plan.planId}; cannot cancel.`)
  }
  if (run.status === 'cancelled') {
    return summarizeRunStatus(run, paths.runPath, plan)
  }

  run.status = 'cancelled'
  run.completedAt = nowIso()
  run.lastError = 'Cancelled by operator'

  await writeJson(paths.runPath, run)

  return summarizeRunStatus(run, paths.runPath, plan)
}

export async function getBackfillDoctorReport(input: {
  planId: string
  configPath: string
  config: Pick<ResolvedChxConfig, 'metaDir'>
  stateDir?: string
}): Promise<BackfillDoctorReport> {
  const { plan, stateDir } = await readPlan({
    planId: input.planId,
    configPath: input.configPath,
    config: input.config,
    stateDir: input.stateDir,
  })
  const paths = backfillPaths(stateDir, plan.planId)
  const run = await readRun(paths.runPath)

  const status = run
    ? summarizeRunStatus(run, paths.runPath, plan)
    : {
        planId: plan.planId,
        target: plan.target,
        status: 'planned' as const,
        totals: { total: plan.chunks.length, pending: plan.chunks.length, submitted: 0, running: 0, done: 0, failed: 0 },
        rowsWritten: 0,
        updatedAt: plan.createdAt,
        runPath: paths.runPath,
      }

  const issueCodes: string[] = []
  const recommendations: string[] = []
  const failedChunkIds: string[] = []

  if (run) {
    for (const [chunkId, state] of Object.entries(run.progress)) {
      if (state.status === 'failed') failedChunkIds.push(chunkId)
    }
  }

  if (status.status === 'planned') {
    issueCodes.push('backfill_plan_missing')
    recommendations.push(`Run: chkit plugin backfill run --plan-id ${status.planId}`)
  }
  if (status.status === 'failed') {
    issueCodes.push('backfill_chunk_failed_retry_exhausted')
    recommendations.push(`Inspect status: chkit plugin backfill status --plan-id ${status.planId}`)
    recommendations.push(
      `Retry failed chunks: chkit plugin backfill resume --plan-id ${status.planId} --replay-failed`
    )
  }
  if (status.status === 'cancelled') {
    issueCodes.push('backfill_required_pending')
    recommendations.push(
      `Resume execution: chkit plugin backfill resume --plan-id ${status.planId} --replay-failed`
    )
  }
  if (status.status === 'running') {
    issueCodes.push('backfill_required_pending')
    recommendations.push(`Monitor progress: chkit plugin backfill status --plan-id ${status.planId}`)
  }
  if (issueCodes.length === 0) {
    recommendations.push('No remediation required.')
  }

  return {
    planId: status.planId,
    status: status.status,
    issueCodes,
    recommendations,
    failedChunkIds,
  }
}
