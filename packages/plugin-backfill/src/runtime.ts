import type { ResolvedChxConfig } from '@chkit/core'

import { BackfillConfigError } from './errors.js'
import { executeWorkItems } from './executor.js'
import type { ProgressEvent, WorkItem } from './executor.js'
import {
  backfillPaths,
  collectActiveRunTargets,
  createRunState,
  ensureEnvironmentMatch,
  ensureRunCompatibility,
  nowIso,
  persistRunAndEvent,
  readPlan,
  readRun,
  summarizeRunStatus,
} from './state.js'
import type {
  BackfillExecutionOptions,
  BackfillPlanState,
  BackfillRunChunkState,
  BackfillRunState,
  ExecuteBackfillRunOutput,
  NormalizedBackfillPluginOptions,
} from './types.js'

/** Adapter that bridges a BackfillRunChunkState to the generic WorkItem interface. */
interface ChunkWorkItem extends WorkItem {
  chunk: BackfillRunChunkState
  sqlTemplate: string
}

function toWorkItems(chunks: BackfillRunChunkState[]): ChunkWorkItem[] {
  return chunks.map((chunk) => ({
    id: chunk.id,
    status: chunk.status,
    attempts: chunk.attempts,
    chunk,
    sqlTemplate: chunk.sqlTemplate,
  }))
}

function syncBackFromWorkItem(item: ChunkWorkItem): void {
  item.chunk.status = item.status
  item.chunk.attempts = item.attempts
}

async function executeRunLoop(input: {
  plan: BackfillPlanState
  run: BackfillRunState
  paths: {
    runPath: string
    eventPath: string
  }
  execution: BackfillExecutionOptions
  retryDelayMs: number
  execute?: (sql: string) => Promise<undefined | { rowsWritten?: number }>
}): Promise<ExecuteBackfillRunOutput> {
  const maxRetries = input.plan.options.maxRetriesPerChunk
  const ac = new AbortController()

  const onSignal = () => { ac.abort() }
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

    // Prepare chunks: apply skip/reset logic, then filter to executable set.
    const executableItems: ChunkWorkItem[] = []
    for (const chunk of input.run.chunks) {
      if (chunk.status === 'done' && !input.run.replayDone) continue

      if (chunk.status === 'failed') {
        if (!input.run.replayFailed) {
          continue
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

      executableItems.push(...toWorkItems([chunk]))
    }

    // Simulation support: wrap the execute function to inject failures.
    const failureBudget = input.execution.simulation?.failCount ?? 0
    const failChunkId = input.execution.simulation?.failChunkId

    const wrappedExecute = async (item: ChunkWorkItem): Promise<void> => {
      // The executor has already incremented item.attempts and set
      // item.status = 'running' before calling execute.  Use item.attempts
      // (already incremented) for the simulation budget check.
      const shouldSimulateFailure =
        failChunkId === item.id && item.attempts <= failureBudget

      if (shouldSimulateFailure) {
        throw new Error(`Simulated failure for chunk ${item.id} attempt ${item.attempts}`)
      }

      if (input.execute) {
        const result = await input.execute(item.sqlTemplate)
        if (result && typeof result === 'object' && typeof result.rowsWritten === 'number') {
          item.chunk.rowsWritten = result.rowsWritten
        }
      }
    }

    const result = await executeWorkItems(
      executableItems,
      wrappedExecute,
      { maxRetries, retryDelayMs: input.retryDelayMs },
      {
        onProgress: async (item: ChunkWorkItem, event: ProgressEvent, meta) => {
          // Keep the chunk state in sync with the work item
          syncBackFromWorkItem(item)

          if (event === 'item_started') {
            item.chunk.startedAt = nowIso()
            await persistRunAndEvent({
              run: input.run,
              runPath: input.paths.runPath,
              eventPath: input.paths.eventPath,
              event: {
                type: 'chunk_started',
                planId: input.run.planId,
                chunkId: item.id,
                attempt: item.attempts,
              },
            })
          } else if (event === 'item_done') {
            item.chunk.completedAt = nowIso()
            item.chunk.lastError = undefined
            await persistRunAndEvent({
              run: input.run,
              runPath: input.paths.runPath,
              eventPath: input.paths.eventPath,
              event: {
                type: 'chunk_done',
                planId: input.run.planId,
                chunkId: item.id,
                attempt: item.attempts,
              },
            })
          } else if (event === 'item_retry') {
            item.chunk.lastError = meta?.error
            await persistRunAndEvent({
              run: input.run,
              runPath: input.paths.runPath,
              eventPath: input.paths.eventPath,
              event: {
                type: 'chunk_retry_scheduled',
                planId: input.run.planId,
                chunkId: item.id,
                attempt: item.attempts,
                nextAttempt: meta?.nextAttempt,
              },
            })
          } else if (event === 'item_failed') {
            item.chunk.lastError = meta?.error
            await persistRunAndEvent({
              run: input.run,
              runPath: input.paths.runPath,
              eventPath: input.paths.eventPath,
              event: {
                type: 'chunk_failed_retry_exhausted',
                planId: input.run.planId,
                chunkId: item.id,
                attempt: item.attempts,
                message: meta?.error,
              },
            })
          }
        },
      },
      ac.signal,
    )

    // Determine final run status
    const failedChunks = input.run.chunks.filter((c) => c.status === 'failed')

    if (!result.aborted && failedChunks.length > 0) {
      input.run.status = 'failed'
      input.run.lastError =
        failedChunks[failedChunks.length - 1]?.lastError ?? 'One or more chunks failed'
      input.run.completedAt = nowIso()

      await persistRunAndEvent({
        run: input.run,
        runPath: input.paths.runPath,
        eventPath: input.paths.eventPath,
        event: {
          type: 'run_completed_with_failures',
          planId: input.plan.planId,
          failedCount: failedChunks.length,
          totalCount: input.run.chunks.length,
        },
      })

      return {
        run: input.run,
        status: summarizeRunStatus(input.run, input.paths.runPath, input.paths.eventPath),
        runPath: input.paths.runPath,
        eventPath: input.paths.eventPath,
      }
    }

    if (!result.aborted) {
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
  execute?: (sql: string) => Promise<undefined | { rowsWritten?: number }>
  clickhouse?: { url: string; database: string }
}): Promise<ExecuteBackfillRunOutput> {
  const execution = input.execution ?? {}
  const { plan, stateDir } = await readPlan({
    planId: input.planId,
    configPath: input.configPath,
    config: input.config,
    options: input.options,
  })

  ensureEnvironmentMatch({
    plan,
    clickhouse: input.clickhouse,
    forceEnvironment: execution.forceEnvironment ?? false,
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
    retryDelayMs: input.options.defaults.retryDelayMs,
    execute: input.execute,
  })
}

export async function resumeBackfillRun(input: {
  planId: string
  configPath: string
  config: Pick<ResolvedChxConfig, 'metaDir'>
  options: NormalizedBackfillPluginOptions
  execution?: BackfillExecutionOptions
  execute?: (sql: string) => Promise<undefined | { rowsWritten?: number }>
  clickhouse?: { url: string; database: string }
}): Promise<ExecuteBackfillRunOutput> {
  const { plan, stateDir } = await readPlan({
    planId: input.planId,
    configPath: input.configPath,
    config: input.config,
    options: input.options,
  })

  ensureEnvironmentMatch({
    plan,
    clickhouse: input.clickhouse,
    forceEnvironment: input.execution?.forceEnvironment ?? false,
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

  // Resume always retries failed chunks — the whole point of resume is to
  // recover from failures.  Users shouldn't need --replay-failed for this.
  const execution: BackfillExecutionOptions = {
    ...input.execution,
    replayFailed: true,
  }

  return executeRunLoop({
    plan,
    run,
    paths,
    execution,
    retryDelayMs: input.options.defaults.retryDelayMs,
    execute: input.execute,
  })
}
