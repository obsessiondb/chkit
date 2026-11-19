import { type createClickHouseExecutor, createStatelessClickHouseExecutor } from '@chkit/clickhouse'
import { createPluginRunner, withFactoryDefaults } from '@chkit/core'

import { BackfillInterruptedError, CHECKPOINT_VERSION, executeBackfill, untilAborted } from './async-backfill.js'
import { buildChunkExecutionSql } from './chunking/sql.js'
import { generateIdempotencyToken } from './chunking/utils/ids.js'
import { BackfillConfigError } from './errors.js'
import {
  CheckSchema,
  PLAN_FLAGS,
  PLAN_FLAG_MAP,
  PLAN_ID_FLAGS,
  PLAN_ID_FLAG_MAP,
  PlanSchema,
  PluginConfigSchema,
  RESUME_FLAGS,
  RESUME_FLAG_MAP,
  ResumeSchema,
  RUN_FLAGS,
  RUN_FLAG_MAP,
  RunSchema,
  StatusSchema,
  SUBMIT_FLAGS,
  SUBMIT_FLAG_MAP,
  SubmitSchema,
  type PlanOptions,
  type PluginConfig,
  type ResumeOptions,
  type RunOptions,
  type StatusOptions,
} from './options.js'
import { planPayload, statusPayload, cancelPayload, doctorPayload } from './payload.js'
import { assertBackfillTargetSafe, assertPinnedInsertSettingsAccepted, assertReplayColumnsStillInsertable, buildBackfillPlan, unprovableTargetFailures } from './planner.js'
import { evaluateBackfillCheck } from './check.js'
import { cancelBackfillRun, getBackfillDoctorReport, getBackfillStatus } from './queries.js'
import {
  backfillPaths,
  ensureEnvironmentMatch,
  nowIso,
  readPlan,
  readRun,
  summarizeRunStatus,
  writeJson,
} from './state.js'
import { runLockPath, withRunLock } from './run-lock.js'
import type {
  BackfillPlugin,
  BackfillPluginCommandContext,
  BackfillPluginRegistration,
  BackfillRunState,
} from './types.js'

const runCommand = createPluginRunner<BackfillPluginCommandContext>({
  configErrorClass: BackfillConfigError,
})

function formatBytes(bytes: number): string {
  if (bytes >= 1024 ** 4) return `${(bytes / 1024 ** 4).toFixed(1)} TiB`
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1)} GiB`
  if (bytes >= 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(1)} MiB`
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KiB`
  return `${bytes} B`
}

async function runBackfill(input: {
  planId: string
  forceEnvironment: boolean
  concurrency: number
  pollIntervalMs: number
  stateDir?: string
  resume?: { replayFailed: boolean; acceptUnknown: boolean }
  configPath: string
  config: Parameters<typeof readPlan>[0]['config']
  clickhouse: NonNullable<Parameters<typeof createClickHouseExecutor>[0]>
  print: (value: unknown) => void
  jsonMode: boolean
}): Promise<number> {
  const { plan, stateDir } = await readPlan({
    planId: input.planId,
    configPath: input.configPath,
    config: input.config,
    stateDir: input.stateDir,
  })

  const paths = backfillPaths(stateDir, plan.planId)

  // The lock is held from before the checkpoint is read until the run ends,
  // so two runs or resumes never submit one chunk under two query ids, and
  // released on SIGINT or SIGTERM once no chunk can write the checkpoint (#765).
  return withRunLock(runLockPath(paths.runsDir, plan.planId), plan.planId, (signal) =>
    runBackfillLocked(input, plan, paths, signal),
  )
}

async function runBackfillLocked(
  input: Parameters<typeof runBackfill>[0],
  plan: Awaited<ReturnType<typeof readPlan>>['plan'],
  paths: ReturnType<typeof backfillPaths>,
  signal: AbortSignal,
): Promise<number> {
  // Check for existing run state
  const existingRun = await readRun(paths.runPath)

  if (input.resume) {
    if (!existingRun) {
      throw new BackfillConfigError(
        `Run state not found for plan ${plan.planId}. Start with backfill run before resume.`
      )
    }
    if (existingRun.status === 'completed') {
      if (input.jsonMode) {
        input.print({ ok: true, noop: true, planId: plan.planId, status: 'completed', message: 'Run already completed. Nothing to resume.' })
      } else {
        input.print(`Backfill ${plan.planId}: already completed. Nothing to resume.`)
      }
      return 0
    }
  }
  const resumeFrom = input.resume ? existingRun?.progress : undefined

  ensureEnvironmentMatch({
    plan,
    clickhouse: input.clickhouse,
    forceEnvironment: input.forceEnvironment,
  })

  if (existingRun && !input.resume) {
    // `run` command (no resumeFrom) must not silently continue an existing run.
    // Users should use `backfill resume` instead.
    const status = existingRun.status
    if (status === 'completed') {
      throw new BackfillConfigError(
        `Run already completed for plan ${plan.planId}. Nothing to do.`
      )
    }
    if (status === 'cancelled') {
      throw new BackfillConfigError(
        `Run is cancelled for plan ${plan.planId}. Create a new plan or inspect with backfill doctor.`
      )
    }
    throw new BackfillConfigError(
      `A run already exists for plan ${plan.planId} (status: ${status}). Use backfill resume to continue.`
    )
  }

  // Chunk workers read and poll concurrently, which a session-bound executor
  // rejects ("Session is locked by a concurrent client"): a stateless one.
  const db = createStatelessClickHouseExecutor(input.clickhouse)

  try {
    const [database, table] = plan.target.split('.')
    if (!database || !table) throw new BackfillConfigError('Invalid backfill target.')
    // A metadata read that hangs must not keep an interrupted run, and its lock.
    const insertableColumns = await untilAborted(
      assertBackfillTargetSafe({ database, table, mode: plan.execution.mode, query: (sql, settings) => db.query(sql, settings) }),
      signal,
      () => new BackfillInterruptedError(`Backfill plan ${plan.planId}: interrupted.`),
    )
    await untilAborted(
      assertPinnedInsertSettingsAccepted({ planId: plan.planId, query: (sql, settings) => db.query(sql, settings) }),
      signal,
      () => new BackfillInterruptedError(`Backfill plan ${plan.planId}: interrupted.`),
    )
    const unprovableFailures = await untilAborted(
      unprovableTargetFailures({ database, table, query: (sql, settings) => db.query(sql, settings) }),
      signal,
      () => new BackfillInterruptedError(`Backfill plan ${plan.planId}: interrupted.`),
    )
    assertReplayColumnsStillInsertable({
      planId: plan.planId,
      target: plan.target,
      targetColumns: plan.execution.targetColumns,
      insertableColumns,
    })
    // A resume keeps the format it read until executeBackfill reports
    // progress, which is always in this release's format.
    const checkpointVersion = input.resume ? existingRun?.checkpointVersion : CHECKPOINT_VERSION
    const runState: BackfillRunState = {
      planId: plan.planId,
      target: plan.target,
      status: 'running',
      startedAt: existingRun?.startedAt ?? nowIso(),
      updatedAt: nowIso(),
      progress: resumeFrom ?? {},
      ...(checkpointVersion === undefined ? {} : { checkpointVersion }),
    }

    await writeJson(paths.runPath, runState)

    let progressWrites: Promise<void> = Promise.resolve()
    const result = await executeBackfill({
      executor: db,
      cluster: input.clickhouse.cluster,
      planId: plan.planId,
      chunks: plan.chunkPlan.chunks.map((chunk) => ({ id: chunk.id })),
      buildQuery: (chunk) => {
        const planChunk = plan.chunkPlan.chunks.find((candidate) => candidate.id === chunk.id)
        if (!planChunk) throw new Error(`Chunk ${chunk.id} not found in plan`)
        return buildChunkExecutionSql({
          planId: plan.planId,
          chunk: planChunk,
          target: plan.target,
          sourceTarget: plan.execution.sourceTarget,
          table: plan.chunkPlan.table,
          mvReplayQueries: plan.execution.mvReplayQueries,
          targetColumns: plan.execution.targetColumns,
          cutoverKey: plan.execution.cutoverKey,
          idempotencyToken: plan.execution.requireIdempotencyToken
            ? generateIdempotencyToken(plan.planId, planChunk.id)
            : '',
        })
      },
      concurrency: input.concurrency,
      pollIntervalMs: input.pollIntervalMs,
      resumeFrom,
      checkpointVersion: existingRun?.checkpointVersion,
      signal,
      replayFailed: input.resume?.replayFailed,
      acceptUnknown: input.resume?.acceptUnknown,
      unprovableFailures,
      // Chunks report progress concurrently; one write at a time keeps an
      // older snapshot's rename from landing after a newer one.
      onProgress: (progress) => {
        runState.progress = progress
        runState.checkpointVersion = CHECKPOINT_VERSION
        runState.updatedAt = nowIso()
        progressWrites = progressWrites.then(() => writeJson(paths.runPath, runState))
        return progressWrites
      },
    })
    await progressWrites

    // A run is completed only when every chunk is done (#765).
    if (result.failed === 0 && result.completed !== result.total) {
      throw new Error(
        `Backfill plan ${plan.planId}: ${result.total - result.completed} of ${result.total} chunks did not run, so the run is not marked completed. Resume it.`,
      )
    }
    runState.status = result.failed > 0 ? 'failed' : 'completed'
    runState.completedAt = nowIso()
    runState.updatedAt = nowIso()
    runState.progress = result.progress
    if (result.failed > 0) {
      const failedEntry = Object.values(result.progress).find((c) => c.status === 'failed')
      runState.lastError = failedEntry?.error ?? 'One or more chunks failed'
    }
    await writeJson(paths.runPath, runState)

    const summary = summarizeRunStatus(runState, paths.runPath, plan)

    if (input.jsonMode) {
      input.print({
        ok: result.failed === 0,
        planId: plan.planId,
        status: runState.status,
        chunkCounts: summary.totals,
        rowsWritten: summary.rowsWritten,
        runPath: paths.runPath,
        lastError: runState.lastError,
      })
    } else {
      let line = `Backfill ${plan.planId}: ${runState.status} (done=${summary.totals.done}/${summary.totals.total}, ${summary.rowsWritten} rows written)`
      if (runState.lastError) line += ` \u2014 ${runState.lastError}`
      input.print(line)
      if (runState.status === 'completed' && summary.rowsWritten === 0) {
        input.print(
          'Warning: 0 rows written across all chunks. Verify that source data exists in the time range and passes the query\'s WHERE filters.'
        )
      }
    }

    return result.failed > 0 ? 1 : 0
  } finally {
    // After an interrupt the process exits once the lock is released: a
    // close that waits for a running INSERT would hold it until the INSERT ends.
    if (signal.aborted) void db.close().catch(() => undefined)
    else await db.close()
  }
}

export function createBackfillPlugin(options: PluginConfig = {}): BackfillPlugin {
  const factoryOptions = options as Record<string, unknown>
  const planOptionsSchema = withFactoryDefaults(PlanSchema, factoryOptions)
  const submitOptionsSchema = withFactoryDefaults(SubmitSchema, factoryOptions)
  const runOptionsSchema = withFactoryDefaults(RunSchema, factoryOptions)
  const resumeOptionsSchema = withFactoryDefaults(ResumeSchema, factoryOptions)
  const statusOptionsSchema = withFactoryDefaults(StatusSchema, factoryOptions)

  return {
    manifest: {
      name: 'backfill',
      apiVersion: 1,
    },
    optionsSchema: withFactoryDefaults(PluginConfigSchema, factoryOptions),
    commands: [
      {
        name: 'plan',
        description: 'Build a deterministic backfill plan and persist immutable plan state',
        takesArgs: false,
        flags: PLAN_FLAGS,
        optionsSchema: planOptionsSchema,
        flagMapping: PLAN_FLAG_MAP,
        run: runCommand({
          command: 'plan',
          label: 'Backfill plan',
          fn: async (context) => {
            const opts = context.options as PlanOptions

            if (!context.config.clickhouse) {
              throw new BackfillConfigError(
                'ClickHouse connection is required for backfill planning. Configure clickhouse in your clickhouse.config.ts.'
              )
            }

            // Planning only reads, and chunk refinement reads several slices
            // at once, which a session-bound executor rejects ("Session is
            // locked by a concurrent client").
            const db = createStatelessClickHouseExecutor(context.config.clickhouse)

            try {
              const output = await buildBackfillPlan({
                opts,
                configPath: context.configPath,
                config: context.config,
                clickhouse: context.config.clickhouse,
                clickhouseQuery: async <T>(sql: string, settings?: Record<string, string | number | boolean | undefined>) => {
                  const result = await db.query(sql, settings)
                  return result as T[]
                },
                // ObsessionDB enables parallel replicas by default, which inflates
                // aggregate results (count, GROUP BY). Disable for planning queries
                // until ObsessionDB handles it at the profile level.
                querySettings: { enable_parallel_replicas: 0 },
              })

              const payload = planPayload(output)
              if (context.jsonMode) {
                context.print(payload)
              } else {
                const partitionCount = output.plan.chunkPlan.partitions.length
                const totalBytes = formatBytes(output.plan.chunkPlan.totalBytesCompressed)
                const primarySortKey = output.plan.chunkPlan.table.sortKeys[0]
                const sortKeyLabel = primarySortKey
                  ? `, sort key: ${primarySortKey.name} (${primarySortKey.category})`
                  : ''
                context.print(
                  `Backfill plan ${payload.planId} for ${payload.target} (${payload.chunkCount} chunks across ${partitionCount} partitions, ~${totalBytes}${sortKeyLabel}) -> ${payload.planPath}`
                )
              }

              return 0
            } finally {
              await db.close()
            }
          },
        }),
      },
      {
        name: 'submit',
        description: 'Submit a backfill plan to a managed job backend (e.g. ObsessionDB) instead of running it locally',
        takesArgs: false,
        flags: SUBMIT_FLAGS,
        optionsSchema: submitOptionsSchema,
        flagMapping: SUBMIT_FLAG_MAP,
        run: runCommand({
          command: 'submit',
          label: 'Backfill submit',
          fn: async () => {
            // Reaching this handler means no managed backend intercepted the
            // command. The ObsessionDB plugin handles `submit` via its
            // onBeforePluginCommand hook when a service is selected; without
            // one there is nowhere to submit to.
            throw new BackfillConfigError(
              'backfill submit requires a managed job backend. Log in and select an ObsessionDB service ' +
                '(`chkit obsessiondb login`, then `chkit obsessiondb service select`), ' +
                'or use `chkit backfill run --local` to execute the backfill against a direct connection.',
            )
          },
        }),
      },
      {
        name: 'run',
        description: 'Execute a planned backfill with async query submission and polling',
        takesArgs: false,
        flags: RUN_FLAGS,
        optionsSchema: runOptionsSchema,
        flagMapping: RUN_FLAG_MAP,
        run: runCommand({
          command: 'run',
          label: 'Backfill run',
          fn: async (context) => {
            const opts = context.options as RunOptions

            if (!context.config.clickhouse) {
              throw new BackfillConfigError(
                'ClickHouse connection is required for backfill execution. Configure clickhouse in your clickhouse.config.ts.'
              )
            }

            return runBackfill({
              planId: opts.planId,
              forceEnvironment: opts.forceEnvironment,
              concurrency: opts.concurrency,
              pollIntervalMs: opts.pollIntervalMs,
              stateDir: opts.stateDir,
              configPath: context.configPath,
              config: context.config,
              clickhouse: context.config.clickhouse,
              print: context.print,
              jsonMode: context.jsonMode,
            })
          },
        }),
      },
      {
        name: 'resume',
        description: 'Resume a backfill run from last checkpoint',
        takesArgs: false,
        flags: RESUME_FLAGS,
        optionsSchema: resumeOptionsSchema,
        flagMapping: RESUME_FLAG_MAP,
        run: runCommand({
          command: 'resume',
          label: 'Backfill resume',
          fn: async (context) => {
            const opts = context.options as ResumeOptions

            if (!context.config.clickhouse) {
              throw new BackfillConfigError(
                'ClickHouse connection is required for backfill execution. Configure clickhouse in your clickhouse.config.ts.'
              )
            }

            return runBackfill({
              planId: opts.planId,
              forceEnvironment: opts.forceEnvironment,
              concurrency: opts.concurrency,
              pollIntervalMs: opts.pollIntervalMs,
              stateDir: opts.stateDir,
              resume: { replayFailed: opts.replayFailed, acceptUnknown: opts.acceptUnknown },
              configPath: context.configPath,
              config: context.config,
              clickhouse: context.config.clickhouse,
              print: context.print,
              jsonMode: context.jsonMode,
            })
          },
        }),
      },
      {
        name: 'status',
        description: 'Show checkpoint and chunk progress for a backfill run',
        takesArgs: false,
        flags: PLAN_ID_FLAGS,
        optionsSchema: statusOptionsSchema,
        flagMapping: PLAN_ID_FLAG_MAP,
        run: runCommand({
          command: 'status',
          label: 'Backfill status',
          fn: async (context) => {
            const opts = context.options as StatusOptions
            const summary = await getBackfillStatus({
              planId: opts.planId,
              config: context.config,
              configPath: context.configPath,
              stateDir: opts.stateDir,
            })
            const payload = statusPayload(summary)
            if (context.jsonMode) {
              context.print(payload)
            } else {
              let line = `Backfill status ${payload.planId}: ${payload.status} (done=${payload.chunkCounts.done}/${payload.chunkCounts.total}, failed=${payload.chunkCounts.failed}, ${payload.rowsWritten} rows written)`
              if (payload.lastError) line += ` \u2014 ${payload.lastError}`
              context.print(line)
              if (payload.status === 'completed' && payload.rowsWritten === 0) {
                context.print(
                  'Warning: 0 rows written across all chunks. Verify that source data exists in the time range and passes the query\'s WHERE filters.'
                )
              }
            }
            return payload.ok ? 0 : 1
          },
        }),
      },
      {
        name: 'cancel',
        description: 'Cancel an in-progress backfill run and prevent further chunk execution',
        takesArgs: false,
        flags: PLAN_ID_FLAGS,
        optionsSchema: statusOptionsSchema,
        flagMapping: PLAN_ID_FLAG_MAP,
        run: runCommand({
          command: 'cancel',
          label: 'Backfill cancel',
          fn: async (context) => {
            const opts = context.options as StatusOptions
            const summary = await cancelBackfillRun({
              planId: opts.planId,
              config: context.config,
              configPath: context.configPath,
              stateDir: opts.stateDir,
            })
            const payload = cancelPayload(summary)
            if (context.jsonMode) {
              context.print(payload)
            } else {
              context.print(
                `Backfill cancel ${payload.planId}: ${payload.status} (done=${payload.chunkCounts.done}/${payload.chunkCounts.total})`
              )
            }
            return payload.ok ? 0 : 1
          },
        }),
      },
      {
        name: 'doctor',
        description: 'Provide actionable remediation steps for failed or pending backfill runs',
        takesArgs: false,
        flags: PLAN_ID_FLAGS,
        optionsSchema: statusOptionsSchema,
        flagMapping: PLAN_ID_FLAG_MAP,
        run: runCommand({
          command: 'doctor',
          label: 'Backfill doctor',
          fn: async (context) => {
            const opts = context.options as StatusOptions
            const report = await getBackfillDoctorReport({
              planId: opts.planId,
              config: context.config,
              configPath: context.configPath,
              stateDir: opts.stateDir,
            })
            const payload = doctorPayload(report)
            if (context.jsonMode) {
              context.print(payload)
            } else {
              context.print(
                `Backfill doctor ${payload.planId}: ${payload.issueCodes.length === 0 ? 'ok' : payload.issueCodes.join(', ')}`
              )
              for (const recommendation of payload.recommendations) {
                context.print(`- ${recommendation}`)
              }
            }
            return payload.ok ? 0 : 1
          },
        }),
      },
      {
        name: 'list',
        description: 'List the backfill jobs of a managed job backend service (e.g. ObsessionDB)',
        takesArgs: false,
        run: runCommand({
          command: 'list',
          label: 'Backfill list',
          fn: async () => {
            // Reaching this handler means no managed backend intercepted the
            // command. The ObsessionDB plugin lists a service's jobs via its
            // onBeforePluginCommand hook; local runs have no job list.
            throw new BackfillConfigError(
              'backfill list shows the jobs of a managed job backend. Register the ObsessionDB plugin, log in and select a service ' +
                '(`chkit obsessiondb login`, then `chkit obsessiondb service select`). ' +
                'Inspect a local run with `chkit plugin backfill status --plan-id <id>`.',
            )
          },
        }),
      },
    ],
    hooks: {
      onConfigLoaded() {
        // Plugin-level options validated softly at load time via PluginConfigSchema.
      },
      async onCheck({ config: appConfig, configPath, options }) {
        const opts = CheckSchema.parse(options)
        return evaluateBackfillCheck({
          configPath,
          config: appConfig,
          stateDir: opts.stateDir,
          failCheckOnRequiredPendingBackfill: opts.failCheckOnRequiredPendingBackfill,
        })
      },
      onCheckReport({ result, print }) {
        const findingCodes = result.findings.map((finding) => finding.code)
        if (result.ok) {
          print('backfill check: ok')
          return
        }
        print(
          `backfill check: failed${findingCodes.length > 0 ? ` (${findingCodes.join(', ')})` : ''}`
        )
      },
    },
  }
}

export function backfill(options: PluginConfig = {}): BackfillPluginRegistration {
  return {
    plugin: createBackfillPlugin(options),
    name: 'backfill',
    enabled: true,
    options,
  }
}
