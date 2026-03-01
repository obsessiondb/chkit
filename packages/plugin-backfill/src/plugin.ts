import process from 'node:process'
import { createInterface } from 'node:readline/promises'

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
import { loadTimeColumnInfo } from './detect.js'
import { BackfillConfigError } from './errors.js'
import { normalizeBackfillOptions, mergeOptions, validateBaseOptions } from './options.js'
import { planPayload, runPayload, statusPayload, cancelPayload, doctorPayload } from './payload.js'
import { buildBackfillPlan } from './planner.js'
import {
  cancelBackfillRun,
  evaluateBackfillCheck,
  executeBackfillRun,
  getBackfillDoctorReport,
  getBackfillStatus,
  resumeBackfillRun,
} from './runtime.js'
import type {
  BackfillPlugin,
  BackfillPluginOptions,
  BackfillPluginRegistration,
  NormalizedBackfillPluginOptions,
  TimeColumnCandidate,
} from './types.js'

async function resolveTimeColumn(input: {
  flagValue?: string
  defaults: NormalizedBackfillPluginOptions['defaults']
  target: string
  schemaGlobs: string | string[]
  configPath: string
  jsonMode: boolean
}): Promise<string> {
  if (input.flagValue) return input.flagValue

  const { schemaTimeColumn, candidates } = await loadTimeColumnInfo(
    input.target,
    input.schemaGlobs,
    input.configPath
  )

  if (schemaTimeColumn) return schemaTimeColumn
  if (input.defaults.timeColumn) return input.defaults.timeColumn

  if (candidates.length === 0) {
    throw new BackfillConfigError(
      `Cannot determine time column for ${input.target}. Specify --time-column <column>, set plugins.backfill.timeColumn in table schema, or set defaults.timeColumn in plugin config.`
    )
  }

  if (input.jsonMode) {
    return candidates[0]!.name
  }

  if (candidates.length === 1) {
    return confirmSingleCandidate(candidates[0]!, input.target)
  }

  return selectFromCandidates(candidates, input.target)
}

async function confirmSingleCandidate(
  candidate: TimeColumnCandidate,
  target: string
): Promise<string> {
  const label = `${candidate.name} (${candidate.type}${candidate.source === 'order_by' ? ', in ORDER BY' : ''})`
  const rl = createInterface({ input: process.stdin, output: process.stdout })
  try {
    const response = await rl.question(`Detected time column for ${target}: ${label}\nUse ${candidate.name}? [Y/n]: `)
    const trimmed = response.trim().toLowerCase()
    if (trimmed === '' || trimmed === 'y' || trimmed === 'yes') {
      return candidate.name
    }
    throw new BackfillConfigError(
      `Time column not confirmed. Specify --time-column <column> explicitly.`
    )
  } finally {
    rl.close()
  }
}

async function selectFromCandidates(
  candidates: TimeColumnCandidate[],
  target: string
): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout })
  try {
    console.log(`Detected time column candidates for ${target}:`)
    for (let i = 0; i < candidates.length; i++) {
      const c = candidates[i]!
      const suffix = c.source === 'order_by' ? ', in ORDER BY' : ''
      console.log(`  ${i + 1}. ${c.name} (${c.type}${suffix})`)
    }
    const response = await rl.question(`Select time column [1-${candidates.length}]: `)
    const index = Number(response.trim()) - 1
    if (!Number.isInteger(index) || index < 0 || index >= candidates.length) {
      throw new BackfillConfigError(
        `Invalid selection. Specify --time-column <column> explicitly.`
      )
    }
    return candidates[index]!.name
  } finally {
    rl.close()
  }
}

type BackfillCommandContext = Parameters<BackfillPlugin['commands'][number]['run']>[0]

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
            const timeColumn = await resolveTimeColumn({
              flagValue: parsed.timeColumn,
              defaults: effectiveOptions.defaults,
              target: parsed.target,
              schemaGlobs: context.config.schema,
              configPath: context.configPath,
              jsonMode: context.jsonMode,
            })

            const output = await buildBackfillPlan({
              target: parsed.target,
              from: parsed.from,
              to: parsed.to,
              timeColumn,
              config: context.config,
              configPath: context.configPath,
              options: effectiveOptions,
              chunkHours: parsed.chunkHours,
              forceLargeWindow: parsed.forceLargeWindow,
            })

            const payload = planPayload(output)
            if (context.jsonMode) {
              context.print(payload)
            } else {
              context.print(
                `Backfill plan ${payload.planId} for ${payload.target} (${payload.chunkCount} chunks at ${payload.chunkHours}h, time column: ${payload.timeColumn}) -> ${payload.planPath}${payload.existed ? ' [existing]' : ''}`
              )
            }

            return 0
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

            if (!context.config.clickhouse) {
              throw new BackfillConfigError(
                'ClickHouse connection config is required for backfill run. Set clickhouse in your chkit config.'
              )
            }
            const db = createClickHouseExecutor(context.config.clickhouse)

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
                  simulation: {
                    failChunkId: parsed.simulateFailChunk,
                    failCount: parsed.simulateFailCount,
                  },
                },
                execute: (sql) => db.execute(sql),
              })

              const payload = {
                ...runPayload(output),
                command: 'run' as const,
              }
              if (context.jsonMode) {
                context.print(payload)
              } else {
                context.print(
                  `Backfill run ${payload.planId}: ${payload.status} (done=${payload.chunkCounts.done}/${payload.chunkCounts.total})`
                )
              }
              return payload.ok ? 0 : 1
            } finally {
              await db.close()
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

            if (!context.config.clickhouse) {
              throw new BackfillConfigError(
                'ClickHouse connection config is required for backfill resume. Set clickhouse in your chkit config.'
              )
            }
            const db = createClickHouseExecutor(context.config.clickhouse)

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
                },
                execute: (sql) => db.execute(sql),
              })

              const payload = {
                ...runPayload(output),
                command: 'resume' as const,
              }
              if (context.jsonMode) {
                context.print(payload)
              } else {
                context.print(
                  `Backfill resume ${payload.planId}: ${payload.status} (done=${payload.chunkCounts.done}/${payload.chunkCounts.total})`
                )
              }
              return payload.ok ? 0 : 1
            } finally {
              await db.close()
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
              context.print(
                `Backfill status ${payload.planId}: ${payload.status} (done=${payload.chunkCounts.done}/${payload.chunkCounts.total}, failed=${payload.chunkCounts.failed})`
              )
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
    plugin: createBackfillPlugin(),
    name: 'backfill',
    enabled: true,
    options,
  }
}
