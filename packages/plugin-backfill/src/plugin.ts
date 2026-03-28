import { createClickHouseExecutor } from '@chkit/clickhouse'
import { wrapPluginRun } from '@chkit/core'

import { executeBackfill, type BackfillProgress } from './async-backfill.js'
import { BackfillConfigError } from './errors.js'
import {
  PLAN_FLAGS,
  PLAN_ID_FLAGS,
  RESUME_FLAGS,
  RUN_FLAGS,
  PluginConfigSchema,
  resolveCheckOptions,
  resolvePlanOptions,
  resolveResumeOptions,
  resolveRunOptions,
  resolveStatusOptions,
  type PluginConfig,
} from './options.js'
import { planPayload, statusPayload, cancelPayload, doctorPayload } from './payload.js'
import { buildBackfillPlan } from './planner.js'
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
import type {
  BackfillPlugin,
  BackfillPluginRegistration,
  BackfillRunState,
} from './types.js'

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
  resumeFrom?: BackfillProgress
  replayFailed?: boolean
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

  ensureEnvironmentMatch({
    plan,
    clickhouse: input.clickhouse,
    forceEnvironment: input.forceEnvironment,
  })

  const paths = backfillPaths(stateDir, plan.planId)

  // Check for existing run state
  const existingRun = await readRun(paths.runPath)
  const resumeFrom = input.resumeFrom

  if (existingRun && !resumeFrom) {
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

  const db = createClickHouseExecutor(input.clickhouse)

  try {
    const runState: BackfillRunState = {
      planId: plan.planId,
      target: plan.target,
      status: 'running',
      startedAt: existingRun?.startedAt ?? nowIso(),
      updatedAt: nowIso(),
      progress: resumeFrom ?? {},
    }

    await writeJson(paths.runPath, runState)

    const result = await executeBackfill({
      executor: db,
      planId: plan.planId,
      chunks: plan.chunks.map((c) => ({ id: c.id, from: c.from, to: c.to })),
      buildQuery: (chunk) => {
        const planChunk = plan.chunks.find((c) => c.id === chunk.id)
        if (!planChunk) throw new Error(`Chunk ${chunk.id} not found in plan`)
        return planChunk.sqlTemplate
      },
      concurrency: input.concurrency,
      pollIntervalMs: input.pollIntervalMs,
      resumeFrom,
      replayFailed: input.replayFailed,
      onProgress: async (progress) => {
        runState.progress = progress
        runState.updatedAt = nowIso()
        await writeJson(paths.runPath, runState)
      },
    })

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
    await db.close()
  }
}

export function createBackfillPlugin(options: PluginConfig = {}): BackfillPlugin {
  const config = PluginConfigSchema.parse(options)

  return {
    manifest: {
      name: 'backfill',
      apiVersion: 1,
    },
    commands: [
      {
        name: 'plan',
        description: 'Build a deterministic backfill plan and persist immutable plan state',
        flags: PLAN_FLAGS,
        run: async (context) =>
          wrapPluginRun({
            command: 'plan',
            label: 'Backfill plan',
            jsonMode: context.jsonMode,
            print: context.print,
            configErrorClass: BackfillConfigError,
            fn: async () => {
              const opts = resolvePlanOptions(config, context.options, context.flags)

              if (!context.config.clickhouse) {
                throw new BackfillConfigError(
                  'ClickHouse connection is required for backfill planning. Configure clickhouse in your clickhouse.config.ts.'
                )
              }

              const db = createClickHouseExecutor(context.config.clickhouse)

              try {
                const output = await buildBackfillPlan({
                  opts,
                  configPath: context.configPath,
                  config: context.config,
                  clickhouse: context.config.clickhouse,
                  clickhouseQuery: async <T>(sql: string) => {
                    const result = await db.query(sql)
                    return result as T[]
                  },
                })

                const payload = planPayload(output)
                if (context.jsonMode) {
                  context.print(payload)
                } else {
                  const partitionCount = output.plan.partitions?.length ?? 0
                  const totalBytes = output.plan.partitions
                    ? formatBytes(output.plan.partitions.reduce((sum, p) => sum + p.bytesOnDisk, 0))
                    : 'unknown'
                  const sortKeyLabel = output.plan.sortKey
                    ? `, sort key: ${output.plan.sortKey.column} (${output.plan.sortKey.category})`
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
        name: 'run',
        description: 'Execute a planned backfill with async query submission and polling',
        flags: RUN_FLAGS,
        run: async (context) =>
          wrapPluginRun({
            command: 'run',
            label: 'Backfill run',
            jsonMode: context.jsonMode,
            print: context.print,
            configErrorClass: BackfillConfigError,
            fn: async () => {
              const opts = resolveRunOptions(config, context.options, context.flags)

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
        flags: RESUME_FLAGS,
        run: async (context) =>
          wrapPluginRun({
            command: 'resume',
            label: 'Backfill resume',
            jsonMode: context.jsonMode,
            print: context.print,
            configErrorClass: BackfillConfigError,
            fn: async () => {
              const opts = resolveResumeOptions(config, context.options, context.flags)

              if (!context.config.clickhouse) {
                throw new BackfillConfigError(
                  'ClickHouse connection is required for backfill execution. Configure clickhouse in your clickhouse.config.ts.'
                )
              }

              const { stateDir } = await readPlan({
                planId: opts.planId,
                configPath: context.configPath,
                config: context.config,
                stateDir: opts.stateDir,
              })
              const paths = backfillPaths(stateDir, opts.planId)
              const existingRun = await readRun(paths.runPath)
              if (!existingRun) {
                throw new BackfillConfigError(
                  `Run state not found for plan ${opts.planId}. Start with backfill run before resume.`
                )
              }
              if (existingRun.status === 'completed') {
                if (context.jsonMode) {
                  context.print({ ok: true, noop: true, planId: opts.planId, status: 'completed', message: 'Run already completed. Nothing to resume.' })
                } else {
                  context.print(`Backfill ${opts.planId}: already completed. Nothing to resume.`)
                }
                return 0
              }

              return runBackfill({
                planId: opts.planId,
                forceEnvironment: opts.forceEnvironment,
                concurrency: opts.concurrency,
                pollIntervalMs: opts.pollIntervalMs,
                stateDir: opts.stateDir,
                resumeFrom: existingRun.progress,
                replayFailed: opts.replayFailed,
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
        flags: PLAN_ID_FLAGS,
        run: async (context) =>
          wrapPluginRun({
            command: 'status',
            label: 'Backfill status',
            jsonMode: context.jsonMode,
            print: context.print,
            configErrorClass: BackfillConfigError,
            fn: async () => {
              const opts = resolveStatusOptions(config, context.options, context.flags)
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
        flags: PLAN_ID_FLAGS,
        run: async (context) =>
          wrapPluginRun({
            command: 'cancel',
            label: 'Backfill cancel',
            jsonMode: context.jsonMode,
            print: context.print,
            configErrorClass: BackfillConfigError,
            fn: async () => {
              const opts = resolveStatusOptions(config, context.options, context.flags)
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
        flags: PLAN_ID_FLAGS,
        run: async (context) =>
          wrapPluginRun({
            command: 'doctor',
            label: 'Backfill doctor',
            jsonMode: context.jsonMode,
            print: context.print,
            configErrorClass: BackfillConfigError,
            fn: async () => {
              const opts = resolveStatusOptions(config, context.options, context.flags)
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
    ],
    hooks: {
      onConfigLoaded({ options: runtimeOptions }) {
        resolveCheckOptions(config, runtimeOptions)
      },
      async onCheck({ config: appConfig, configPath, options: runtimeOptions }) {
        const opts = resolveCheckOptions(config, runtimeOptions)
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
