import { createClickHouseExecutor } from '@chkit/clickhouse'
import { wrapPluginRun } from '@chkit/core'

import {
  PLAN_FLAGS,
  PLAN_ID_FLAGS,
  RESUME_FLAGS,
  RUN_FLAGS,
  parseCancelArgs,
  parseDoctorArgs,
  parsePlanArgs,
  parseResumeArgs,
  parseRunArgs,
  parseStatusArgs,
} from './args.js'
import { BackfillConfigError } from './errors.js'
import { normalizeBackfillOptions, mergeOptions, validateBaseOptions } from './options.js'
import { planPayload, runPayload, statusPayload, cancelPayload, doctorPayload } from './payload.js'
import { buildBackfillPlan } from './planner.js'
import { evaluateBackfillCheck } from './check.js'
import { cancelBackfillRun, getBackfillDoctorReport, getBackfillStatus } from './queries.js'
import { executeBackfillRun, resumeBackfillRun } from './runtime.js'
import type {
  BackfillPlugin,
  BackfillPluginOptions,
  BackfillPluginRegistration,
  ExecuteBackfillRunOutput,
  NormalizedBackfillPluginOptions,
} from './types.js'

function formatBytes(bytes: number): string {
  if (bytes >= 1024 ** 4) return `${(bytes / 1024 ** 4).toFixed(1)} TiB`
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1)} GiB`
  if (bytes >= 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(1)} MiB`
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KiB`
  return `${bytes} B`
}

type BackfillCommandContext = Parameters<BackfillPlugin['commands'][number]['run']>[0]

function formatRunOutput(
  output: ExecuteBackfillRunOutput,
  command: string,
  context: Pick<BackfillCommandContext, 'jsonMode' | 'print'>,
): number {
  const payload = {
    ...runPayload(output),
    command,
  }
  if (payload.noop) {
    if (!context.jsonMode) {
      context.print(
        `Plan ${payload.planId} is already completed (${payload.chunkCounts.done}/${payload.chunkCounts.total} chunks done). Nothing to do.`
      )
    } else {
      context.print(payload)
    }
    return 0
  }
  if (context.jsonMode) {
    context.print(payload)
  } else {
    let line = `Backfill ${command} ${payload.planId}: ${payload.status} (done=${payload.chunkCounts.done}/${payload.chunkCounts.total}, ${payload.rowsWritten} rows written)`
    if (payload.lastError) line += ` \u2014 ${payload.lastError}`
    context.print(line)
    if (payload.status === 'completed' && payload.rowsWritten === 0) {
      context.print(
        'Warning: 0 rows written across all chunks. Verify that source data exists in the time range and passes the query\'s WHERE filters.'
      )
    }
  }
  return payload.ok ? 0 : 1
}

function createBackfillCommand(
  base: NormalizedBackfillPluginOptions,
  input: {
    name: string
    label: string
    run: (ctx: {
      context: BackfillCommandContext
      effectiveOptions: NormalizedBackfillPluginOptions
    }) => Promise<number>
  }
): BackfillPlugin['commands'][number]['run'] {
  return async (context) =>
    wrapPluginRun({
      command: input.name,
      label: input.label,
      jsonMode: context.jsonMode,
      print: context.print,
      configErrorClass: BackfillConfigError,
      fn: async () => {
        const effectiveOptions = mergeOptions(base, context.options)
        validateBaseOptions(effectiveOptions)
        return input.run({ context, effectiveOptions })
      },
    })
}

export function createBackfillPlugin(options: BackfillPluginOptions = {}): BackfillPlugin {
  const base = normalizeBackfillOptions(options)
  validateBaseOptions(base)

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
        run: createBackfillCommand(base, {
          name: 'plan',
          label: 'Backfill plan',
          async run({ context, effectiveOptions }) {
            const parsed = parsePlanArgs(context.flags)

            if (!context.config.clickhouse) {
              throw new BackfillConfigError(
                'ClickHouse connection is required for backfill planning. Configure clickhouse in your clickhouse.config.ts.'
              )
            }

            const db = createClickHouseExecutor(context.config.clickhouse)

            try {
              const output = await buildBackfillPlan({
                target: parsed.target,
                from: parsed.from,
                to: parsed.to,
                config: context.config,
                configPath: context.configPath,
                options: effectiveOptions,
                maxChunkBytes: parsed.maxChunkBytes,
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
        description: 'Execute a planned backfill with checkpointed chunk progress',
        flags: RUN_FLAGS,
        run: createBackfillCommand(base, {
          name: 'run',
          label: 'Backfill run',
          async run({ context, effectiveOptions }) {
            const parsed = parseRunArgs(context.flags)

            const db = context.config.clickhouse
              ? createClickHouseExecutor(context.config.clickhouse)
              : undefined

            try {
              const output = await executeBackfillRun({
                planId: parsed.planId,
                config: context.config,
                configPath: context.configPath,
                options: effectiveOptions,
                execution: {
                  replayDone: parsed.replayDone,
                  replayFailed: parsed.replayFailed,
                  forceOverlap: parsed.forceOverlap,
                  forceCompatibility: parsed.forceCompatibility,
                  forceEnvironment: parsed.forceEnvironment,
                  simulation: {
                    failChunkId: parsed.simulateFailChunk,
                    failCount: parsed.simulateFailCount,
                  },
                },
                execute: db ? async (sql) => { await db.command(sql); return undefined } : undefined,
                clickhouse: context.config.clickhouse,
              })

              return formatRunOutput(output, 'run', context)
            } finally {
              await db?.close()
            }
          },
        }),
      },
      {
        name: 'resume',
        description: 'Resume a backfill run from last checkpoint',
        flags: RESUME_FLAGS,
        run: createBackfillCommand(base, {
          name: 'resume',
          label: 'Backfill resume',
          async run({ context, effectiveOptions }) {
            const parsed = parseResumeArgs(context.flags)

            const db = context.config.clickhouse
              ? createClickHouseExecutor(context.config.clickhouse)
              : undefined

            try {
              const output = await resumeBackfillRun({
                planId: parsed.planId,
                config: context.config,
                configPath: context.configPath,
                options: effectiveOptions,
                execution: {
                  replayDone: parsed.replayDone,
                  replayFailed: parsed.replayFailed,
                  forceOverlap: parsed.forceOverlap,
                  forceCompatibility: parsed.forceCompatibility,
                  forceEnvironment: parsed.forceEnvironment,
                },
                execute: db ? async (sql) => { await db.command(sql); return undefined } : undefined,
                clickhouse: context.config.clickhouse,
              })

              return formatRunOutput(output, 'resume', context)
            } finally {
              await db?.close()
            }
          },
        }),
      },
      {
        name: 'status',
        description: 'Show checkpoint and chunk progress for a backfill run',
        flags: PLAN_ID_FLAGS,
        run: createBackfillCommand(base, {
          name: 'status',
          label: 'Backfill status',
          async run({ context, effectiveOptions }) {
            const parsed = parseStatusArgs(context.flags)
            const summary = await getBackfillStatus({
              planId: parsed.planId,
              config: context.config,
              configPath: context.configPath,
              options: effectiveOptions,
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
        run: createBackfillCommand(base, {
          name: 'cancel',
          label: 'Backfill cancel',
          async run({ context, effectiveOptions }) {
            const parsed = parseCancelArgs(context.flags)
            const summary = await cancelBackfillRun({
              planId: parsed.planId,
              config: context.config,
              configPath: context.configPath,
              options: effectiveOptions,
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
        run: createBackfillCommand(base, {
          name: 'doctor',
          label: 'Backfill doctor',
          async run({ context, effectiveOptions }) {
            const parsed = parseDoctorArgs(context.flags)
            const report = await getBackfillDoctorReport({
              planId: parsed.planId,
              config: context.config,
              configPath: context.configPath,
              options: effectiveOptions,
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
        const merged = mergeOptions(base, runtimeOptions)
        validateBaseOptions(merged)
      },
      async onCheck({ config, configPath, options: runtimeOptions }) {
        const effectiveOptions = mergeOptions(base, runtimeOptions)
        validateBaseOptions(effectiveOptions)
        return evaluateBackfillCheck({
          configPath,
          config,
          options: effectiveOptions,
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

export function backfill(options: BackfillPluginOptions = {}): BackfillPluginRegistration {
  return {
    plugin: createBackfillPlugin(options),
    name: 'backfill',
    enabled: true,
    options,
  }
}
