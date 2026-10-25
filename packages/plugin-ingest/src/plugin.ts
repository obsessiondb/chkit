import process from 'node:process'

import { createStatelessClickHouseExecutor, type ClickHouseExecutor } from '@chkit/clickhouse'
import {
  createPluginRunner,
  defineFlags,
  withFactoryDefaults,
  type ChxInlinePluginRegistration,
  type ResolvedChxConfig,
} from '@chkit/core'
import { loadDefinitionModules } from '@chkit/core/schema-loader'
import * as Effect from 'effect/Effect'
import type * as Scope from 'effect/Scope'
import { z } from 'zod'

import { BATCH_ID_COLUMN, createClickHouseDestination, INGESTED_AT_COLUMN, RUN_ID_COLUMN } from './destination.js'
import { IngestConfigError } from './errors.js'
import { runIngestion, type BackfillRequest } from './executor.js'
import { createClickHouseJournal, DEFAULT_JOURNAL_TABLE } from './journal.js'
import { collectPipelines, selectStreams, type SelectedStream } from './registry.js'
import { doctorJournal, repairJournal } from './recovery.js'
import { foreign, runPublic, sync } from './runtime.js'
import type { PipelineDefinition } from './types.js'

const REQUIRED_COLUMNS = [BATCH_ID_COLUMN, RUN_ID_COLUMN, INGESTED_AT_COLUMN]

const IngestOptionsSchema = z.object({
  journalTable: z.string().min(1).default(DEFAULT_JOURNAL_TABLE),
  /** Host-default execution budget in seconds. */
  maxDurationSeconds: z.number().positive().default(3600),
  prefetchBatches: z.number().int().positive().default(1),
})
type IngestOptions = z.infer<typeof IngestOptionsSchema>

export type IngestPluginOptions = Partial<IngestOptions>

const SELECTION_FLAGS = defineFlags([
  { name: '--tag', type: 'string[]', description: 'Exact tag every selected stream must carry (repeatable, AND)', placeholder: '<tag>' },
] as const)

const RUN_FLAGS = defineFlags([
  ...SELECTION_FLAGS,
  { name: '--backfill', type: 'string', description: 'Stable backfill id; uses an isolated checkpoint namespace', placeholder: '<id>' },
  { name: '--from', type: 'string', description: 'Backfill range lower bound (ISO timestamp)', placeholder: '<timestamp>' },
  { name: '--to', type: 'string', description: 'Backfill range upper bound (ISO timestamp)', placeholder: '<timestamp>' },
  { name: '--max-duration', type: 'string', description: 'Execution budget in seconds', placeholder: '<seconds>' },
] as const)

const RECOVERY_FLAGS = defineFlags([
  ...SELECTION_FLAGS,
  { name: '--backfill', type: 'string', description: 'Inspect an isolated backfill checkpoint namespace', placeholder: '<id>' },
] as const)

const REPAIR_FLAGS = defineFlags([
  ...RECOVERY_FLAGS,
  { name: '--apply', type: 'string', description: 'Materialize the reviewed fingerprint with writers stopped (select one stream)', placeholder: '<fingerprint>' },
] as const)

interface IngestPluginCommandContext {
  args: string[]
  flags: Record<string, string | string[] | boolean | undefined>
  jsonMode: boolean
  options: IngestOptions
  config: ResolvedChxConfig
  configPath: string
  print: (value: unknown) => void
  pluginContext?: { executor: ClickHouseExecutor; hasExecutor: boolean }
}

interface IngestFinding {
  code: string
  message: string
  severity: 'info' | 'warn' | 'error'
}

export type IngestPlugin = ReturnType<typeof createIngestPlugin>

interface IngestTarget {
  executor: ClickHouseExecutor
  database: string
  targetId: string
  close(): Promise<void>
}

const runCommand = createPluginRunner<IngestPluginCommandContext>({ configErrorClass: IngestConfigError })

export function createIngestPlugin(options: IngestPluginOptions = {}) {
  const optionsSchema = withFactoryDefaults(IngestOptionsSchema, options)

  return {
    manifest: { name: 'ingest' as const, apiVersion: 1 as const },
    optionsSchema,
    commands: [
      {
        name: 'run',
        description: 'Execute the selected ingestion streams from their journaled checkpoints',
        flags: RUN_FLAGS,
        optionsSchema,
        run: runCommand({
          command: 'run',
          label: 'Ingest run',
          fn: (context) => runPublic(Effect.gen(function* () {
            const selected = yield* loadSelection(context)
            const backfill = parseBackfill(context.flags)
            const maxDurationSeconds = parseMaxDuration(context.flags['--max-duration']) ?? context.options.maxDurationSeconds
            return yield* withTarget(context, (target) => Effect.gen(function* () {
              const abort = new AbortController()
              yield* Effect.acquireRelease(
                sync(() => {
                  const onSignal = () => abort.abort(new DOMException('Interrupted', 'AbortError'))
                  process.once('SIGINT', onSignal)
                  process.once('SIGTERM', onSignal)
                  return onSignal
                }),
                (onSignal) => Effect.sync(() => {
                  process.off('SIGINT', onSignal)
                  process.off('SIGTERM', onSignal)
                })
              )
              const result = yield* foreign(() => runIngestion(
                { selected, backfill },
                {
                  journal: createClickHouseJournal({
                    executor: target.executor,
                    database: target.database,
                    targetId: target.targetId,
                    table: context.options.journalTable,
                  }),
                  destination: createClickHouseDestination(target.executor),
                  signal: abort.signal,
                  maxDurationMs: maxDurationSeconds * 1000,
                  prefetchBatches: context.options.prefetchBatches,
                  log: context.jsonMode ? undefined : (message) => context.print(message),
                }
              ))
              if (context.jsonMode) {
                yield* sync(() => context.print({ command: 'run', ...result }))
              } else {
                const rows = result.streams.reduce((sum, stream) => sum + stream.rows, 0)
                yield* sync(() => context.print(`Ingest run ${result.runId}: ${result.ok ? 'ok' : 'incomplete'} (${result.streams.length} streams, ${rows} rows)`))
              }
              return result.ok ? 0 : 1
            }))
          })),
        }),
      },
      {
        name: 'list',
        description: 'List the ingestion streams in the loaded definition graph',
        flags: SELECTION_FLAGS,
        optionsSchema,
        run: runCommand({
          command: 'list',
          label: 'Ingest list',
          fn: (context) => runPublic(Effect.gen(function* () {
            const selected = yield* loadSelection(context)
            const streams = selected.map(describeStream)
            if (context.jsonMode) {
              yield* sync(() => context.print({ ok: true, command: 'list', streams }))
            } else {
              for (const stream of streams) {
                yield* sync(() => context.print(`${stream.streamId} -> ${stream.destination} [${stream.tags.join(', ')}]`))
              }
            }
            return 0
          })),
        }),
      },
      {
        name: 'doctor',
        description: 'Validate journal evidence and diagnose uncertain run histories',
        flags: RECOVERY_FLAGS,
        optionsSchema,
        run: runCommand({
          command: 'doctor',
          label: 'Ingest doctor',
          fn: (context) => runPublic(Effect.gen(function* () {
            const selected = yield* loadSelection(context)
            const backfill = parseBackfill(context.flags)
            return yield* withTarget(context, (target) => Effect.gen(function* () {
              const streams = yield* Effect.forEach(selected, (entry) => Effect.gen(function* () {
                const namespaceId = backfill ? `${entry.stream.id}#backfill:${backfill.id}` : entry.stream.id
                const report = yield* foreign(() => doctorJournal(namespaceId, {
                  executor: target.executor, database: target.database, targetId: target.targetId, table: context.options.journalTable,
                }))
                return { ...describeStream(entry), report }
              }), { concurrency: 'unbounded' })
              const ok = streams.every((stream) => stream.report.healthy)
              if (context.jsonMode) {
                yield* sync(() => context.print({ ok, command: 'doctor', targetId: target.targetId, streams }))
              } else {
                for (const { report } of streams) {
                  yield* sync(() => context.print(`${report.namespaceId}: ${report.healthy ? 'healthy' : report.problems.join('; ')} (${report.runs} runs, selected checkpoint v${report.checkpoint.version}, ${report.selectedEvidenceRows} stream evidence rows)`))
                }
              }
              return ok ? 0 : 1
            }))
          })),
        }),
      },
      {
        name: 'repair',
        description: 'Review recovery; --apply materializes a verified journal for explicit configuration activation',
        flags: REPAIR_FLAGS,
        optionsSchema,
        run: runCommand({
          command: 'repair',
          label: 'Ingest repair',
          fn: (context) => runPublic(Effect.gen(function* () {
            const selected = yield* loadSelection(context)
            const backfill = parseBackfill(context.flags)
            const apply = context.flags['--apply']
            if (typeof apply === 'string' && selected.length !== 1) {
              return yield* Effect.fail(new IngestConfigError('--apply requires exactly one selected stream; use --tag to narrow the selection.'))
            }
            return yield* withTarget(context, (target) => Effect.gen(function* () {
              const streams = yield* Effect.forEach(selected, (entry) => Effect.gen(function* () {
                const namespaceId = backfill ? `${entry.stream.id}#backfill:${backfill.id}` : entry.stream.id
                const result = yield* foreign(() => repairJournal(namespaceId, typeof apply === 'string' ? apply : undefined, {
                  executor: target.executor, database: target.database, targetId: target.targetId, table: context.options.journalTable,
                }))
                return { ...describeStream(entry), ...result }
              }))
              if (context.jsonMode) {
                yield* sync(() => context.print({ ok: true, command: 'repair', targetId: target.targetId, streams }))
              } else {
                for (const { applied, plan } of streams) {
                  if (plan.healthy) {
                    yield* sync(() => context.print(`${plan.namespaceId}: healthy; ${plan.runs} runs, selected checkpoint v${plan.checkpoint.version}.`))
                    continue
                  }
                  yield* sync(() => context.print(`${plan.namespaceId}: ${applied ? 'repair materialized; configuration activation required' : 'repair plan'}; retain ${plan.retainedFacts} facts, selected checkpoint v${plan.checkpoint.version}.`))
                  for (const problem of plan.problems) yield* sync(() => context.print(problem))
                  yield* sync(() => context.print(`Evidence: ${plan.evidenceRows} rows ${applied ? 'preserved in' : 'will be archived to'} ${applied ? plan.archiveTable : `${plan.archiveTable}_<copy id>`}; original table retained.`))
                  yield* sync(() => context.print(plan.replayWarning))
                  yield* sync(() => context.print(plan.activation))
                  if (!applied && !plan.healthy && plan.repairable) yield* sync(() => context.print(`Review this plan, then run ingest repair --tag stream:${plan.namespaceId.split('#backfill:')[0]}${backfill ? ` --backfill ${backfill.id}` : ''} --apply ${plan.fingerprint}`))
                }
              }
              return 0
            }))
          })),
        }),
      },
      {
        name: 'status',
        description: 'Show the committed checkpoint of each selected stream',
        flags: SELECTION_FLAGS,
        optionsSchema,
        run: runCommand({
          command: 'status',
          label: 'Ingest status',
          fn: (context) => runPublic(Effect.gen(function* () {
            const selected = yield* loadSelection(context)
            return yield* withTarget(context, (target) => Effect.gen(function* () {
              const journal = createClickHouseJournal({
                executor: target.executor,
                database: target.database,
                targetId: target.targetId,
                table: context.options.journalTable,
              })
              yield* foreign(() => journal.ensure())
              const streams = yield* Effect.forEach(
                selected, (entry) => Effect.gen(function* () {
                  const checkpoint = yield* foreign(() => journal.readCheckpoint(entry.stream.id))
                  return { ...describeStream(entry), checkpointVersion: checkpoint.version, checkpoint: checkpoint.envelope ?? null }
                }), { concurrency: 'unbounded' }
              )
              if (context.jsonMode) {
                yield* sync(() => context.print({ ok: true, command: 'status', targetId: target.targetId, streams }))
              } else {
                for (const stream of streams) {
                  yield* sync(() => context.print(`${stream.streamId}: v${stream.checkpointVersion} ${stream.checkpoint ? JSON.stringify(stream.checkpoint.state) : '(no checkpoint)'}`))
                }
              }
              return 0
            }))
          })),
        }),
      },
    ],
    hooks: {
      onCheck(context: { config: ResolvedChxConfig }) {
        return runPublic(Effect.gen(function* () {
          const findings = checkGraph(yield* loadGraph(context.config))
          return {
            plugin: 'ingest',
            evaluated: true,
            ok: findings.every((finding) => finding.severity !== 'error'),
            findings,
          }
        }))
      },
    },
  }
}

export function ingest(options: IngestPluginOptions = {}): ChxInlinePluginRegistration<IngestPlugin, IngestPluginOptions> {
  return { plugin: createIngestPlugin(options), name: 'ingest', enabled: true, options }
}

/** Local, zero-network graph checks: they hold in `--offline` mode too. */
export function checkGraph(pipelines: readonly PipelineDefinition[]): IngestFinding[] {
  const findings: IngestFinding[] = []
  if (pipelines.length === 0) {
    findings.push({ code: 'ingest_no_pipelines', message: 'No ingestion pipeline is exported by the project entry.', severity: 'warn' })
  }
  for (const pipeline of pipelines) {
    for (const stream of pipeline.streams) {
      const columns = new Set(stream.destination.columns.map((column) => column.name))
      const missing = REQUIRED_COLUMNS.filter((name) => !columns.has(name))
      if (missing.length > 0) {
        findings.push({
          code: 'ingest_missing_metadata_columns',
          message: `Stream "${stream.id}" destination ${stream.destination.database}.${stream.destination.name} is missing ${missing.join(', ')}. Spread ingestionColumns into its columns.`,
          severity: 'error',
        })
      }
    }
  }
  return findings
}

// Discover values exported from the configured entry (or legacy schema files).
function loadGraph(config: ResolvedChxConfig): Effect.Effect<PipelineDefinition[], unknown> {
  return Effect.gen(function* () {
    if (config.schema.length === 0) return []
    return collectPipelines(yield* foreign(() => loadDefinitionModules(config.schema, { cwd: process.cwd() })))
  })
}

function loadSelection(context: IngestPluginCommandContext): Effect.Effect<SelectedStream[], unknown> {
  return Effect.gen(function* () {
    const pipelines = yield* loadGraph(context.config)
    if (pipelines.length === 0) {
      return yield* Effect.fail(new IngestConfigError('No ingestion pipeline is exported. Export a definePipeline(...) value from the module configured as "entry".'))
    }
    const tags = context.flags['--tag']
    return selectStreams(pipelines, Array.isArray(tags) ? tags : typeof tags === 'string' ? [tags] : [])
  })
}

function withTarget<T>(
  context: IngestPluginCommandContext,
  use: (target: IngestTarget) => Effect.Effect<T, unknown, Scope.Scope>
): Effect.Effect<T, unknown> {
  return Effect.scoped(Effect.gen(function* () {
    const target = yield* Effect.acquireRelease(
      sync(() => openTarget(context)),
      (target) => foreign(() => target.close()).pipe(
        Effect.timeoutOrElse({ duration: 5000, orElse: () => Effect.fail(new Error('Ingestion target cleanup timed out')) }),
        Effect.orDie
      )
    )
    return yield* Effect.exit(use(target))
  })).pipe(Effect.flatten)
}

function openTarget(context: IngestPluginCommandContext): IngestTarget {
  const clickhouse = context.config.clickhouse
  // Ingestion requires JSONEachRow and per-insert deduplication settings.
  // The host executor contract does not guarantee either capability.
  // Streams fetch, load and journal concurrently, so the executor must not be
  // bound to one ClickHouse HTTP session (a session allows one in-flight query).
  if (clickhouse) {
    const executor = createStatelessClickHouseExecutor(clickhouse)
    return { executor, database: clickhouse.database, targetId: targetIdOf(clickhouse.url, clickhouse.database), close: () => executor.close() }
  }
  throw new IngestConfigError('Ingestion requires a direct ClickHouse connection for JSON rows and deduplication settings. Configure clickhouse in your clickhouse.config.ts; a host-provided executor is not supported.')
}

function targetIdOf(url: string, database: string): string {
  try {
    return `${new URL(url).host}/${database}`
  } catch {
    return `${url}/${database}`
  }
}

function parseBackfill(flags: IngestPluginCommandContext['flags']): BackfillRequest | undefined {
  const id = flags['--backfill']
  const from = parseTimestamp(flags['--from'], '--from')
  const to = parseTimestamp(flags['--to'], '--to')
  if (typeof id !== 'string') {
    if (from || to) throw new IngestConfigError('--from and --to require --backfill <id>: explicit ranges never touch the scheduled checkpoint.')
    return undefined
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(id)) throw new IngestConfigError(`Invalid --backfill id "${id}".`)
  return { id, from, to }
}

function parseTimestamp(raw: string | string[] | boolean | undefined, flag: string): Date | undefined {
  if (typeof raw !== 'string') return undefined
  const date = new Date(raw)
  if (Number.isNaN(date.getTime())) throw new IngestConfigError(`Invalid timestamp for ${flag}: ${raw}`)
  return date
}

function parseMaxDuration(raw: string | string[] | boolean | undefined): number | undefined {
  if (typeof raw !== 'string') return undefined
  const seconds = Number(raw)
  if (!Number.isFinite(seconds) || seconds <= 0) throw new IngestConfigError(`Invalid value for --max-duration: ${raw}`)
  return seconds
}

function describeStream(entry: SelectedStream) {
  return {
    streamId: entry.stream.id,
    pipelineId: entry.pipeline.id,
    destination: `${entry.stream.destination.database}.${entry.stream.destination.name}`,
    strategy: `${entry.stream.incremental.id}@${entry.stream.incremental.version}`,
    tags: [...entry.effectiveTags],
  }
}
