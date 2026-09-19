import process from 'node:process'

import { createStatelessClickHouseExecutor, type ClickHouseExecutor } from '@chkit/clickhouse'
import {
  createPluginRunner,
  defineFlags,
  withFactoryDefaults,
  type ChxInlinePluginRegistration,
  type ResolvedChxConfig,
} from '@chkit/core'
import { loadSchemaDefinitions } from '@chkit/core/schema-loader'
import { z } from 'zod'

import { BATCH_ID_COLUMN, createClickHouseDestination, INGESTED_AT_COLUMN, RUN_ID_COLUMN } from './destination.js'
import { IngestConfigError } from './errors.js'
import { runIngestion, type BackfillRequest } from './executor.js'
import { createClickHouseJournal, DEFAULT_JOURNAL_TABLE } from './journal.js'
import { listPipelines, selectStreams, type SelectedStream } from './registry.js'
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

export interface IngestPluginCommandContext {
  args: string[]
  flags: Record<string, string | string[] | boolean | undefined>
  jsonMode: boolean
  options: IngestOptions
  config: ResolvedChxConfig
  configPath: string
  print: (value: unknown) => void
  pluginContext?: { executor: ClickHouseExecutor; hasExecutor: boolean }
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
          fn: async (context) => {
            const selected = await loadSelection(context)
            const backfill = parseBackfill(context.flags)
            const maxDurationSeconds = parseMaxDuration(context.flags['--max-duration']) ?? context.options.maxDurationSeconds
            const target = openTarget(context)
            const abort = new AbortController()
            const onSignal = () => abort.abort(new DOMException('Interrupted', 'AbortError'))
            process.once('SIGINT', onSignal)
            process.once('SIGTERM', onSignal)

            try {
              const result = await runIngestion(
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
              )
              if (context.jsonMode) {
                context.print({ command: 'run', ...result })
              } else {
                const rows = result.streams.reduce((sum, stream) => sum + stream.rows, 0)
                context.print(`Ingest run ${result.runId}: ${result.ok ? 'ok' : 'incomplete'} (${result.streams.length} streams, ${rows} rows)`)
              }
              return result.ok ? 0 : 1
            } finally {
              process.off('SIGINT', onSignal)
              process.off('SIGTERM', onSignal)
              await target.close()
            }
          },
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
          fn: async (context) => {
            const selected = await loadSelection(context)
            const streams = selected.map(describeStream)
            if (context.jsonMode) {
              context.print({ ok: true, command: 'list', streams })
            } else {
              for (const stream of streams) {
                context.print(`${stream.streamId} -> ${stream.destination} [${stream.tags.join(', ')}]`)
              }
            }
            return 0
          },
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
          fn: async (context) => {
            const selected = await loadSelection(context)
            const target = openTarget(context)
            try {
              const journal = createClickHouseJournal({
                executor: target.executor,
                database: target.database,
                targetId: target.targetId,
                table: context.options.journalTable,
              })
              await journal.ensure()
              const streams = await Promise.all(
                selected.map(async (entry) => {
                  const checkpoint = await journal.readCheckpoint(entry.stream.id)
                  return { ...describeStream(entry), checkpointVersion: checkpoint.version, checkpoint: checkpoint.envelope ?? null }
                })
              )
              if (context.jsonMode) {
                context.print({ ok: true, command: 'status', targetId: target.targetId, streams })
              } else {
                for (const stream of streams) {
                  context.print(`${stream.streamId}: v${stream.checkpointVersion} ${stream.checkpoint ? JSON.stringify(stream.checkpoint.state) : '(no checkpoint)'}`)
                }
              }
              return 0
            } finally {
              await target.close()
            }
          },
        }),
      },
    ],
    hooks: {
      async onCheck(context: { config: ResolvedChxConfig }) {
        const findings = checkGraph(await loadGraph(context.config))
        return {
          plugin: 'ingest',
          evaluated: true,
          ok: findings.every((finding) => finding.severity !== 'error'),
          findings,
        }
      },
    },
  }
}

export type IngestPlugin = ReturnType<typeof createIngestPlugin>

export function ingest(options: IngestPluginOptions = {}): ChxInlinePluginRegistration<IngestPlugin, IngestPluginOptions> {
  return { plugin: createIngestPlugin(options), name: 'ingest', enabled: true, options }
}

/** Local, zero-network graph checks: they hold in `--offline` mode too. */
export function checkGraph(pipelines: readonly PipelineDefinition[]) {
  const findings: Array<{ code: string; message: string; severity: 'info' | 'warn' | 'error' }> = []
  if (pipelines.length === 0) {
    findings.push({ code: 'ingest_no_pipelines', message: 'No ingestion pipeline is registered by the project entry.', severity: 'warn' })
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

// Importing the entry (or legacy schema files) is what lets definePipeline
// self-register; the module cache guarantees this happens once per process.
async function loadGraph(config: ResolvedChxConfig): Promise<PipelineDefinition[]> {
  if (config.schema.length > 0) await loadSchemaDefinitions(config.schema, { cwd: process.cwd() })
  return listPipelines()
}

async function loadSelection(context: IngestPluginCommandContext): Promise<SelectedStream[]> {
  const pipelines = await loadGraph(context.config)
  if (pipelines.length === 0) {
    throw new IngestConfigError('No ingestion pipeline is registered. Call definePipeline(...) from the module configured as "entry".')
  }
  const tags = context.flags['--tag']
  return selectStreams(pipelines, Array.isArray(tags) ? tags : typeof tags === 'string' ? [tags] : [])
}

function openTarget(context: IngestPluginCommandContext) {
  const clickhouse = context.config.clickhouse
  // A direct connection carries per-insert settings (the deduplication token);
  // fall back to the host-provided executor only when no URL is configured.
  // Streams fetch, load and journal concurrently, so the executor must not be
  // bound to one ClickHouse HTTP session (a session allows one in-flight query).
  if (clickhouse) {
    const executor = createStatelessClickHouseExecutor(clickhouse)
    return { executor, database: clickhouse.database, targetId: targetIdOf(clickhouse.url, clickhouse.database), close: () => executor.close() }
  }
  if (context.pluginContext?.hasExecutor) {
    return { executor: context.pluginContext.executor, database: 'default', targetId: 'host-executor/default', close: async () => undefined }
  }
  throw new IngestConfigError('Ingestion needs a ClickHouse target. Configure clickhouse in your clickhouse.config.ts.')
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
