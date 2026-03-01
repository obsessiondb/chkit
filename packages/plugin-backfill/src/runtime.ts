import { join } from 'node:path'
import process from 'node:process'

import type { ResolvedChxConfig } from '@chkit/core'

import { BackfillConfigError } from './errors.js'
import {
  backfillPaths,
  collectActiveRunTargets,
  computeBackfillStateDir,
  createRunState,
  ensureRunCompatibility,
  listPlanIds,
  nowIso,
  persistRunAndEvent,
  readPlan,
  readRun,
  summarizeRunStatus,
} from './state.js'
import type {
  BackfillDoctorReport,
  BackfillPlanState,
  BackfillExecutionOptions,
  BackfillPluginCheckResult,
  BackfillRunChunkState,
  BackfillRunState,
  BackfillStatusSummary,
  ExecuteBackfillRunOutput,
  NormalizedBackfillPluginOptions,
} from './types.js'

export async function evaluateBackfillCheck(input: {
  configPath: string
  config: Pick<ResolvedChxConfig, 'metaDir'>
  options: NormalizedBackfillPluginOptions
}): Promise<BackfillPluginCheckResult> {
  const stateDir = computeBackfillStateDir(input.config, input.configPath, input.options)
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
      severity: input.options.policy.failCheckOnRequiredPendingBackfill ? 'error' : 'warn',
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

  if (!input.options.policy.failCheckOnRequiredPendingBackfill) {
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

async function executeChunk(input: {
  run: BackfillRunState
  chunk: BackfillRunChunkState
  maxRetries: number
  runPath: string
  eventPath: string
  execute?: (sql: string) => Promise<void | { rowsWritten?: number }>
  simulation?: {
    failChunkId?: string
    failCount?: number
  }
}): Promise<{ ok: true } | { ok: false; error: string }> {
  const failureBudget = input.simulation?.failCount ?? 0

  while (input.chunk.attempts < input.maxRetries) {
    input.chunk.status = 'running'
    input.chunk.attempts += 1
    input.chunk.startedAt = nowIso()

    await persistRunAndEvent({
      run: input.run,
      runPath: input.runPath,
      eventPath: input.eventPath,
      event: {
        type: 'chunk_started',
        planId: input.run.planId,
        chunkId: input.chunk.id,
        attempt: input.chunk.attempts,
      },
    })

    const shouldSimulateFailure =
      input.simulation?.failChunkId === input.chunk.id && input.chunk.attempts <= failureBudget

    if (!shouldSimulateFailure) {
      let executionError: string | undefined
      let executionResult: void | { rowsWritten?: number } | undefined
      if (input.execute) {
        try {
          executionResult = await input.execute(input.chunk.sqlTemplate)
        } catch (error) {
          executionError = error instanceof Error ? error.message : String(error)
        }
      }

      if (!executionError) {
        input.chunk.status = 'done'
        input.chunk.completedAt = nowIso()
        input.chunk.lastError = undefined
        if (executionResult && typeof executionResult === 'object' && typeof executionResult.rowsWritten === 'number') {
          input.chunk.rowsWritten = executionResult.rowsWritten
        }

        await persistRunAndEvent({
          run: input.run,
          runPath: input.runPath,
          eventPath: input.eventPath,
          event: {
            type: 'chunk_done',
            planId: input.run.planId,
            chunkId: input.chunk.id,
            attempt: input.chunk.attempts,
          },
        })

        return { ok: true }
      }

      input.chunk.lastError = executionError

      if (input.chunk.attempts >= input.maxRetries) {
        input.chunk.status = 'failed'
        input.run.status = 'failed'
        input.run.lastError = executionError

        await persistRunAndEvent({
          run: input.run,
          runPath: input.runPath,
          eventPath: input.eventPath,
          event: {
            type: 'chunk_failed_retry_exhausted',
            planId: input.run.planId,
            chunkId: input.chunk.id,
            attempt: input.chunk.attempts,
            message: executionError,
          },
        })

        return { ok: false, error: executionError }
      }

      input.chunk.status = 'pending'

      await persistRunAndEvent({
        run: input.run,
        runPath: input.runPath,
        eventPath: input.eventPath,
        event: {
          type: 'chunk_retry_scheduled',
          planId: input.run.planId,
          chunkId: input.chunk.id,
          attempt: input.chunk.attempts,
          nextAttempt: input.chunk.attempts + 1,
        },
      })

      continue
    }

    const errorMessage = `Simulated failure for chunk ${input.chunk.id} attempt ${input.chunk.attempts}`
    input.chunk.lastError = errorMessage

    if (input.chunk.attempts >= input.maxRetries) {
      input.chunk.status = 'failed'
      input.run.status = 'failed'
      input.run.lastError = errorMessage

      await persistRunAndEvent({
        run: input.run,
        runPath: input.runPath,
        eventPath: input.eventPath,
        event: {
          type: 'chunk_failed_retry_exhausted',
          planId: input.run.planId,
          chunkId: input.chunk.id,
          attempt: input.chunk.attempts,
          message: errorMessage,
        },
      })

      return { ok: false, error: errorMessage }
    }

    input.chunk.status = 'pending'

    await persistRunAndEvent({
      run: input.run,
      runPath: input.runPath,
      eventPath: input.eventPath,
      event: {
        type: 'chunk_retry_scheduled',
        planId: input.run.planId,
        chunkId: input.chunk.id,
        attempt: input.chunk.attempts,
        nextAttempt: input.chunk.attempts + 1,
      },
    })
  }

  return {
    ok: false,
    error: `Retry budget exhausted for chunk ${input.chunk.id}`,
  }
}

async function executeRunLoop(input: {
  plan: BackfillPlanState
  run: BackfillRunState
  paths: {
    runPath: string
    eventPath: string
  }
  execution: BackfillExecutionOptions
  execute?: (sql: string) => Promise<void | { rowsWritten?: number }>
}): Promise<ExecuteBackfillRunOutput> {
  const maxRetries = input.plan.options.maxRetriesPerChunk
  let aborted = false

  const onSignal = () => { aborted = true }
  process.on('SIGINT', onSignal)
  process.on('SIGTERM', onSignal)

  try {
    input.run.status = 'running'
    input.run.replayDone = input.execution.replayDone ?? false
    input.run.replayFailed = input.execution.replayFailed ?? false

    await persistRunAndEvent({
      run: input.run,
      runPath: input.paths.runPath,
      eventPath: input.paths.eventPath,
      event: {
        type: 'run_started',
        planId: input.plan.planId,
        replayDone: input.run.replayDone,
        replayFailed: input.run.replayFailed,
      },
    })

    for (const chunk of input.run.chunks) {
      if (aborted) break

      if (chunk.status === 'done' && !input.run.replayDone) continue

      if (chunk.status === 'failed') {
        if (!input.run.replayFailed) {
          input.run.status = 'failed'
          input.run.lastError =
            chunk.lastError ??
            `Chunk ${chunk.id} is failed and resume requires --replay-failed to re-run failed chunks.`

          await persistRunAndEvent({
            run: input.run,
            runPath: input.paths.runPath,
            eventPath: input.paths.eventPath,
            event: {
              type: 'run_blocked_failed_chunk',
              planId: input.plan.planId,
              chunkId: chunk.id,
              message: input.run.lastError,
            },
          })

          return {
            run: input.run,
            status: summarizeRunStatus(input.run, input.paths.runPath, input.paths.eventPath),
            runPath: input.paths.runPath,
            eventPath: input.paths.eventPath,
          }
        }

        chunk.status = 'pending'
        chunk.attempts = 0
        chunk.lastError = undefined
        chunk.startedAt = undefined
        chunk.completedAt = undefined
      }

      if (chunk.status === 'running') {
        chunk.status = 'pending'
      }

      const executed = await executeChunk({
        run: input.run,
        chunk,
        maxRetries,
        runPath: input.paths.runPath,
        eventPath: input.paths.eventPath,
        execute: input.execute,
        simulation: input.execution.simulation,
      })

      if (!executed.ok) {
        input.run.completedAt = nowIso()
        return {
          run: input.run,
          status: summarizeRunStatus(input.run, input.paths.runPath, input.paths.eventPath),
          runPath: input.paths.runPath,
          eventPath: input.paths.eventPath,
        }
      }
    }

    if (!aborted) {
      input.run.status = 'completed'
      input.run.completedAt = nowIso()
      input.run.lastError = undefined

      await persistRunAndEvent({
        run: input.run,
        runPath: input.paths.runPath,
        eventPath: input.paths.eventPath,
        event: {
          type: 'run_completed',
          planId: input.plan.planId,
        },
      })
    }

    return {
      run: input.run,
      status: summarizeRunStatus(input.run, input.paths.runPath, input.paths.eventPath),
      runPath: input.paths.runPath,
      eventPath: input.paths.eventPath,
    }
  } finally {
    process.removeListener('SIGINT', onSignal)
    process.removeListener('SIGTERM', onSignal)

    for (const chunk of input.run.chunks) {
      if (chunk.status === 'running') {
        chunk.status = 'pending'
      }
    }

    if (input.run.status === 'running') {
      input.run.status = 'paused'
      await persistRunAndEvent({
        run: input.run,
        runPath: input.paths.runPath,
        eventPath: input.paths.eventPath,
        event: {
          type: 'run_paused',
          planId: input.plan.planId,
          reason: 'process_exit',
        },
      })
    }
  }
}

async function assertNoOverlappingActiveRun(input: {
  runsDir: string
  planId: string
  target: string
}): Promise<void> {
  const activeTargets = await collectActiveRunTargets(input.runsDir)
  for (const [activePlanId, activeTarget] of activeTargets.entries()) {
    if (activePlanId === input.planId) continue
    if (activeTarget !== input.target) continue
    throw new BackfillConfigError(
      `Overlapping active run detected for target ${input.target} (plan ${activePlanId}). Retry with --force-overlap to override.`
    )
  }
}

export async function executeBackfillRun(input: {
  planId: string
  configPath: string
  config: Pick<ResolvedChxConfig, 'metaDir'>
  options: NormalizedBackfillPluginOptions
  execution?: BackfillExecutionOptions
  execute?: (sql: string) => Promise<void | { rowsWritten?: number }>
}): Promise<ExecuteBackfillRunOutput> {
  const execution = input.execution ?? {}
  const { plan, stateDir } = await readPlan({
    planId: input.planId,
    configPath: input.configPath,
    config: input.config,
    options: input.options,
  })
  const paths = backfillPaths(stateDir, plan.planId)

  if (input.options.policy.blockOverlappingRuns && !execution.forceOverlap) {
    await assertNoOverlappingActiveRun({
      runsDir: paths.runsDir,
      planId: plan.planId,
      target: plan.target,
    })
  }

  let run = await readRun(paths.runPath)
  if (!run) {
    run = createRunState({
      plan,
      options: input.options,
      execution,
    })
  } else {
    ensureRunCompatibility({
      run,
      plan,
      options: input.options,
      forceCompatibility: execution.forceCompatibility ?? false,
    })
  }

  if (run.status === 'completed' && !execution.replayDone && !execution.replayFailed) {
    return {
      run,
      status: summarizeRunStatus(run, paths.runPath, paths.eventPath),
      runPath: paths.runPath,
      eventPath: paths.eventPath,
      noop: true,
    }
  }
  if (run.status === 'cancelled') {
    throw new BackfillConfigError(
      `Run is cancelled for plan ${plan.planId}. Create a new plan or inspect with backfill doctor.`
    )
  }

  return executeRunLoop({
    plan,
    run,
    paths,
    execution,
    execute: input.execute,
  })
}

export async function resumeBackfillRun(input: {
  planId: string
  configPath: string
  config: Pick<ResolvedChxConfig, 'metaDir'>
  options: NormalizedBackfillPluginOptions
  execution?: BackfillExecutionOptions
  execute?: (sql: string) => Promise<void | { rowsWritten?: number }>
}): Promise<ExecuteBackfillRunOutput> {
  const { plan, stateDir } = await readPlan({
    planId: input.planId,
    configPath: input.configPath,
    config: input.config,
    options: input.options,
  })
  const paths = backfillPaths(stateDir, plan.planId)
  const run = await readRun(paths.runPath)

  if (!run) {
    throw new BackfillConfigError(
      `Run state not found for plan ${plan.planId}. Start with backfill run before resume.`
    )
  }

  ensureRunCompatibility({
    run,
    plan,
    options: input.options,
    forceCompatibility: input.execution?.forceCompatibility ?? false,
  })
  if (input.options.policy.blockOverlappingRuns && !input.execution?.forceOverlap) {
    await assertNoOverlappingActiveRun({
      runsDir: paths.runsDir,
      planId: plan.planId,
      target: plan.target,
    })
  }
  if (run.status === 'cancelled') {
    throw new BackfillConfigError(
      `Run is cancelled for plan ${plan.planId}. Create a new plan or inspect with backfill doctor.`
    )
  }

  return executeRunLoop({
    plan,
    run,
    paths,
    execution: input.execution ?? {},
    execute: input.execute,
  })
}

export async function getBackfillStatus(input: {
  planId: string
  configPath: string
  config: Pick<ResolvedChxConfig, 'metaDir'>
  options: NormalizedBackfillPluginOptions
}): Promise<BackfillStatusSummary> {
  const { plan, stateDir } = await readPlan({
    planId: input.planId,
    configPath: input.configPath,
    config: input.config,
    options: input.options,
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
        running: 0,
        done: 0,
        failed: 0,
        skipped: 0,
      },
      attempts: 0,
      rowsWritten: 0,
      updatedAt: plan.createdAt,
      runPath: paths.runPath,
      eventPath: paths.eventPath,
    }
  }

  return summarizeRunStatus(run, paths.runPath, paths.eventPath)
}

export async function cancelBackfillRun(input: {
  planId: string
  configPath: string
  config: Pick<ResolvedChxConfig, 'metaDir'>
  options: NormalizedBackfillPluginOptions
}): Promise<BackfillStatusSummary> {
  const { plan, stateDir } = await readPlan({
    planId: input.planId,
    configPath: input.configPath,
    config: input.config,
    options: input.options,
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
    return summarizeRunStatus(run, paths.runPath, paths.eventPath)
  }

  run.status = 'cancelled'
  run.completedAt = nowIso()
  run.lastError = 'Cancelled by operator'
  for (const chunk of run.chunks) {
    if (chunk.status === 'running') {
      chunk.status = 'pending'
    }
  }

  await persistRunAndEvent({
    run,
    runPath: paths.runPath,
    eventPath: paths.eventPath,
    event: {
      type: 'run_cancelled',
      planId: plan.planId,
    },
  })

  return summarizeRunStatus(run, paths.runPath, paths.eventPath)
}

export async function getBackfillDoctorReport(input: {
  planId: string
  configPath: string
  config: Pick<ResolvedChxConfig, 'metaDir'>
  options: NormalizedBackfillPluginOptions
}): Promise<BackfillDoctorReport> {
  const status = await getBackfillStatus(input)
  const issueCodes: string[] = []
  const recommendations: string[] = []
  const failedChunkIds: string[] = []

  const run = await readRun(status.runPath)
  for (const chunk of run?.chunks ?? []) {
    if (chunk.status === 'failed') failedChunkIds.push(chunk.id)
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
