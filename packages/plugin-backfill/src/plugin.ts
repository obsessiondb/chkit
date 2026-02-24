import { parseCancelArgs, parseDoctorArgs, parsePlanArgs, parseResumeArgs, parseRunArgs, parseStatusArgs } from './args.js'
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
import type { BackfillPlugin, BackfillPluginOptions, BackfillPluginRegistration } from './types.js'

const PLAN_FLAGS = [
  { name: '--target', type: 'string' as const, description: 'Target table (database.table)', placeholder: '<database.table>' },
  { name: '--from', type: 'string' as const, description: 'Start timestamp', placeholder: '<timestamp>' },
  { name: '--to', type: 'string' as const, description: 'End timestamp', placeholder: '<timestamp>' },
  { name: '--chunk-hours', type: 'string' as const, description: 'Hours per chunk', placeholder: '<hours>' },
  { name: '--force-large-window', type: 'boolean' as const, description: 'Allow large time windows without confirmation' },
]

const RUN_FLAGS = [
  { name: '--plan-id', type: 'string' as const, description: 'Plan ID to execute', placeholder: '<id>' },
  { name: '--replay-done', type: 'boolean' as const, description: 'Re-execute already completed chunks' },
  { name: '--replay-failed', type: 'boolean' as const, description: 'Re-execute failed chunks' },
  { name: '--force-overlap', type: 'boolean' as const, description: 'Allow overlapping runs' },
  { name: '--force-compatibility', type: 'boolean' as const, description: 'Skip compatibility checks' },
  { name: '--simulate-fail-chunk', type: 'string' as const, description: 'Simulate failure on chunk', placeholder: '<chunk-id>' },
  { name: '--simulate-fail-count', type: 'string' as const, description: 'Number of simulated failures', placeholder: '<count>' },
]

const RESUME_FLAGS = [
  { name: '--plan-id', type: 'string' as const, description: 'Plan ID to resume', placeholder: '<id>' },
  { name: '--replay-done', type: 'boolean' as const, description: 'Re-execute already completed chunks' },
  { name: '--replay-failed', type: 'boolean' as const, description: 'Re-execute failed chunks' },
  { name: '--force-overlap', type: 'boolean' as const, description: 'Allow overlapping runs' },
  { name: '--force-compatibility', type: 'boolean' as const, description: 'Skip compatibility checks' },
]

const PLAN_ID_FLAGS = [
  { name: '--plan-id', type: 'string' as const, description: 'Plan ID', placeholder: '<id>' },
]

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
        async run({ flags, jsonMode, print, options: runtimeOptions, config, configPath }) {
          try {
            const parsed = parsePlanArgs(flags)
            const effectiveOptions = mergeOptions(base, runtimeOptions)
            validateBaseOptions(effectiveOptions)

            const output = await buildBackfillPlan({
              target: parsed.target,
              from: parsed.from,
              to: parsed.to,
              config,
              configPath,
              options: effectiveOptions,
              chunkHours: parsed.chunkHours,
              forceLargeWindow: parsed.forceLargeWindow,
            })

            const payload = planPayload(output)
            if (jsonMode) {
              print(payload)
            } else {
              print(
                `Backfill plan ${payload.planId} for ${payload.target} (${payload.chunkCount} chunks at ${payload.chunkHours}h) -> ${payload.planPath}${payload.existed ? ' [existing]' : ''}`
              )
            }

            return 0
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error)
            if (jsonMode) {
              print({
                ok: false,
                command: 'plan',
                error: message,
              })
            } else {
              print(`Backfill plan failed: ${message}`)
            }

            if (error instanceof BackfillConfigError) return 2
            return 1
          }
        },
      },
      {
        name: 'run',
        description: 'Execute a planned backfill with checkpointed chunk progress',
        flags: RUN_FLAGS,
        async run({ flags, jsonMode, print, options: runtimeOptions, config, configPath }) {
          try {
            const parsed = parseRunArgs(flags)
            const effectiveOptions = mergeOptions(base, runtimeOptions)
            validateBaseOptions(effectiveOptions)

            const output = await executeBackfillRun({
              planId: parsed.planId,
              config,
              configPath,
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
            })

            const payload = {
              ...runPayload(output),
              command: 'run' as const,
            }

            if (jsonMode) {
              print(payload)
            } else {
              print(
                `Backfill run ${payload.planId}: ${payload.status} (done=${payload.chunkCounts.done}/${payload.chunkCounts.total})`
              )
            }

            return payload.ok ? 0 : 1
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error)
            if (jsonMode) {
              print({ ok: false, command: 'run', error: message })
            } else {
              print(`Backfill run failed: ${message}`)
            }

            if (error instanceof BackfillConfigError) return 2
            return 1
          }
        },
      },
      {
        name: 'resume',
        description: 'Resume a backfill run from last checkpoint',
        flags: RESUME_FLAGS,
        async run({ flags, jsonMode, print, options: runtimeOptions, config, configPath }) {
          try {
            const parsed = parseResumeArgs(flags)
            const effectiveOptions = mergeOptions(base, runtimeOptions)
            validateBaseOptions(effectiveOptions)

            const output = await resumeBackfillRun({
              planId: parsed.planId,
              config,
              configPath,
              options: effectiveOptions,
              execution: {
                replayDone: parsed.replayDone,
                replayFailed: parsed.replayFailed,
                forceOverlap: parsed.forceOverlap,
                forceCompatibility: parsed.forceCompatibility,
              },
            })

            const payload = {
              ...runPayload(output),
              command: 'resume' as const,
            }

            if (jsonMode) {
              print(payload)
            } else {
              print(
                `Backfill resume ${payload.planId}: ${payload.status} (done=${payload.chunkCounts.done}/${payload.chunkCounts.total})`
              )
            }

            return payload.ok ? 0 : 1
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error)
            if (jsonMode) {
              print({ ok: false, command: 'resume', error: message })
            } else {
              print(`Backfill resume failed: ${message}`)
            }

            if (error instanceof BackfillConfigError) return 2
            return 1
          }
        },
      },
      {
        name: 'status',
        description: 'Show checkpoint and chunk progress for a backfill run',
        flags: PLAN_ID_FLAGS,
        async run({ flags, jsonMode, print, options: runtimeOptions, config, configPath }) {
          try {
            const parsed = parseStatusArgs(flags)
            const effectiveOptions = mergeOptions(base, runtimeOptions)
            validateBaseOptions(effectiveOptions)

            const summary = await getBackfillStatus({
              planId: parsed.planId,
              config,
              configPath,
              options: effectiveOptions,
            })
            const payload = statusPayload(summary)

            if (jsonMode) {
              print(payload)
            } else {
              print(
                `Backfill status ${payload.planId}: ${payload.status} (done=${payload.chunkCounts.done}/${payload.chunkCounts.total}, failed=${payload.chunkCounts.failed})`
              )
            }

            return payload.ok ? 0 : 1
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error)
            if (jsonMode) {
              print({ ok: false, command: 'status', error: message })
            } else {
              print(`Backfill status failed: ${message}`)
            }

            if (error instanceof BackfillConfigError) return 2
            return 1
          }
        },
      },
      {
        name: 'cancel',
        description: 'Cancel an in-progress backfill run and prevent further chunk execution',
        flags: PLAN_ID_FLAGS,
        async run({ flags, jsonMode, print, options: runtimeOptions, config, configPath }) {
          try {
            const parsed = parseCancelArgs(flags)
            const effectiveOptions = mergeOptions(base, runtimeOptions)
            validateBaseOptions(effectiveOptions)

            const summary = await cancelBackfillRun({
              planId: parsed.planId,
              config,
              configPath,
              options: effectiveOptions,
            })
            const payload = cancelPayload(summary)

            if (jsonMode) {
              print(payload)
            } else {
              print(
                `Backfill cancel ${payload.planId}: ${payload.status} (done=${payload.chunkCounts.done}/${payload.chunkCounts.total})`
              )
            }

            return payload.ok ? 0 : 1
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error)
            if (jsonMode) {
              print({ ok: false, command: 'cancel', error: message })
            } else {
              print(`Backfill cancel failed: ${message}`)
            }

            if (error instanceof BackfillConfigError) return 2
            return 1
          }
        },
      },
      {
        name: 'doctor',
        description: 'Provide actionable remediation steps for failed or pending backfill runs',
        flags: PLAN_ID_FLAGS,
        async run({ flags, jsonMode, print, options: runtimeOptions, config, configPath }) {
          try {
            const parsed = parseDoctorArgs(flags)
            const effectiveOptions = mergeOptions(base, runtimeOptions)
            validateBaseOptions(effectiveOptions)

            const report = await getBackfillDoctorReport({
              planId: parsed.planId,
              config,
              configPath,
              options: effectiveOptions,
            })
            const payload = doctorPayload(report)

            if (jsonMode) {
              print(payload)
            } else {
              print(
                `Backfill doctor ${payload.planId}: ${payload.issueCodes.length === 0 ? 'ok' : payload.issueCodes.join(', ')}`
              )
              for (const recommendation of payload.recommendations) {
                print(`- ${recommendation}`)
              }
            }

            return payload.ok ? 0 : 1
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error)
            if (jsonMode) {
              print({ ok: false, command: 'doctor', error: message })
            } else {
              print(`Backfill doctor failed: ${message}`)
            }

            if (error instanceof BackfillConfigError) return 2
            return 1
          }
        },
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
