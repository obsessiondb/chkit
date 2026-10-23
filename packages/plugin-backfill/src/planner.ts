import { dirname } from 'node:path'

import type { MaterializedViewDefinition, ResolvedChxConfig } from '@chkit/core'
import { loadSchemaDefinitions } from '@chkit/core/schema-loader'

import { encodeChunkPlanForPersistence } from './chunking/boundary-codec.js'
import { generateChunkPlan } from './chunking/planner.js'
import { findMvsForTarget, resolveMvReplaySource } from './detect.js'
import { BackfillConfigError } from './errors.js'
import type { PlanOptions } from './options.js'
import {
  backfillPaths,
  computeBackfillStateDir,
  computeEnvironmentFingerprint,
  nowIso,
  writeJson,
} from './state.js'
import type { BuildBackfillPlanOutput } from './types.js'

interface BackfillStrategy {
  mvs: MaterializedViewDefinition[]
  mvReplayQueries?: string[]
}

type ClickHouseQuery = <T>(sql: string, settings?: Record<string, string | number | boolean | undefined>) => Promise<T[]>

/**
 * The same pins every chunk INSERT carries (see `chunking/sql.ts`), so `*` in a
 * view's query expands to the same columns at plan time as at run time, whatever
 * the user's settings profile says. Inline, like the INSERT's, so no client or
 * URL-level setting can override them.
 */
const ASTERISK_SETTINGS = 'asterisk_include_materialized_columns=0, asterisk_include_alias_columns=0'

/**
 * Inspect the schema to decide how the target gets populated. When one or more
 * materialized views feed it, this is an mv_replay backfill and their queries
 * drive the insert; otherwise it's a plain copy. A schema that can't be loaded
 * falls back to copy — the same lenient behaviour as before.
 */
async function detectBackfillStrategy(input: {
  schema: ResolvedChxConfig['schema']
  configDir: string
  database: string
  table: string
}): Promise<BackfillStrategy> {
  try {
    const definitions = await loadSchemaDefinitions(input.schema, { cwd: input.configDir })
    const mvs = findMvsForTarget(definitions, input.database, input.table)
    if (mvs.length === 0) return { mvs: [] }

    const tableDef = definitions.find(
      (definition) =>
        definition.kind === 'table' &&
        definition.database === input.database &&
        definition.name === input.table
    )
    if (tableDef?.kind === 'table' && tableDef.columns.some((column) => column.defaultKind === 'EPHEMERAL')) {
      throw new BackfillConfigError('Automatic backfill cannot reconstruct EPHEMERAL inputs; use an explicit INSERT with an input column mapping.')
    }
    return { mvs, mvReplayQueries: mvs.map((mv) => mv.as) }
  } catch (error) {
    if (error instanceof BackfillConfigError) throw error
    // Schema load failed, fall back to direct copy.
    return { mvs: [] }
  }
}

/**
 * Missing, unreadable or unsupported metadata must never bypass the safety gate.
 * Copy mode re-inserts `SELECT *`, which keeps stored DEFAULT values but
 * recomputes MATERIALIZED ones. Expressions are not parsed, so a copy is refused
 * whenever a MATERIALIZED column could read an EPHEMERAL input.
 *
 * Returns the live target's insertable columns (no MATERIALIZED, ALIAS or
 * EPHEMERAL) in table order.
 */
export async function assertBackfillTargetSafe(input: {
  database: string
  table: string
  mode: 'copy' | 'mv_replay'
  query: ClickHouseQuery
  querySettings?: Record<string, string | number | boolean | undefined>
}): Promise<string[]> {
  const quote = (value: string) => `'${value.replaceAll('\\', '\\\\').replaceAll("'", "\\'")}'`
  const target = `${input.database}.${input.table}`
  const rows = await input.query<{ name: string; default_kind: string }>(
    `SELECT name, default_kind FROM system.columns WHERE database = ${quote(input.database)} AND table = ${quote(input.table)} ORDER BY position`,
    input.querySettings
  )
  if (!rows.length) {
    const tables = await input.query<{ name: string }>(
      `SELECT name FROM system.tables WHERE database = ${quote(input.database)} AND name = ${quote(input.table)}`,
      input.querySettings
    )
    if (!tables.length) {
      throw new BackfillConfigError(`Backfill target ${target} does not exist or is not visible yet. DDL may still be propagating on managed ClickHouse (e.g. ObsessionDB); check the name and retry.`)
    }
  }
  if (!rows.length || rows.some((column) => !column.name || !['', 'DEFAULT', 'MATERIALIZED', 'ALIAS', 'EPHEMERAL'].includes(column.default_kind))) {
    throw new BackfillConfigError('Cannot verify live target column kinds; automatic backfill is blocked. Check metadata access and use an explicit INSERT if needed.')
  }
  const namesOf = (kind: string) => rows.filter((column) => column.default_kind === kind).map((column) => column.name)
  const ephemeral = namesOf('EPHEMERAL')
  const materialized = namesOf('MATERIALIZED')
  if (ephemeral.length && input.mode === 'mv_replay') {
    throw new BackfillConfigError('Automatic backfill cannot reconstruct EPHEMERAL inputs; use an explicit INSERT with an input column mapping.')
  }
  if (ephemeral.length && materialized.length) {
    throw new BackfillConfigError(`Automatic backfill cannot reconstruct EPHEMERAL inputs; copying ${target} recomputes MATERIALIZED column(s) ${materialized.join(', ')}, which may read EPHEMERAL column(s) ${ephemeral.join(', ')}. Use an explicit INSERT with an input column mapping.`)
  }
  return rows.filter((column) => ['', 'DEFAULT'].includes(column.default_kind)).map((column) => column.name)
}

export async function buildBackfillPlan(input: {
  opts: PlanOptions
  configPath: string
  config: Pick<ResolvedChxConfig, 'metaDir' | 'schema'>
  clickhouse?: { url: string; database: string }
  clickhouseQuery: ClickHouseQuery
  querySettings?: Record<string, string | number | boolean | undefined>
}): Promise<BuildBackfillPlanOutput> {
  const { opts } = input
  const [database, table] = opts.target.split('.')
  if (!database || !table) {
    throw new BackfillConfigError('Invalid target format. Expected <database.table>.')
  }

  // Detect the execution strategy before chunk planning: an mv_replay backfill
  // sizes its chunks against the MV *source* (the table its SELECT reads),
  // because the injected chunk conditions run against that source — not the
  // target, which is legitimately empty when bootstrapping an aggregate. Target column safety is checked separately for both paths.
  const strategy = await detectBackfillStrategy({
    schema: input.config.schema,
    configDir: dirname(input.configPath),
    database,
    table,
  })
  const insertableColumns = await assertBackfillTargetSafe({
    database, table, mode: strategy.mvReplayQueries ? 'mv_replay' : 'copy',
    query: input.clickhouseQuery, querySettings: input.querySettings,
  })
  const targetColumns = strategy.mvReplayQueries
    ? await resolveReplayColumns({
      target: opts.target,
      mvs: strategy.mvs,
      insertableColumns,
      query: input.clickhouseQuery,
      querySettings: input.querySettings,
    })
    : undefined
  const replaySource = strategy.mvReplayQueries ? resolveMvReplaySource(strategy.mvs) : undefined
  const chunkSource = replaySource ?? { database, table }

  const chunkPlan = await generateChunkPlan({
    database: chunkSource.database,
    table: chunkSource.table,
    from: opts.from,
    to: opts.to,
    targetChunkBytes: opts.maxChunkBytes,
    query: input.clickhouseQuery,
    querySettings: input.querySettings,
  })

  const firstPartition = chunkPlan.partitions[0]
  if (!firstPartition) {
    throw new BackfillConfigError(
      `No partitions found for ${chunkSource.database}.${chunkSource.table}${opts.from || opts.to ? ' within the specified time range' : ''}. The table may be empty.`
    )
  }

  const env = computeEnvironmentFingerprint(input.clickhouse)
  const derivedFrom = opts.from ?? chunkPlan.partitions.reduce(
    (min, partition) => (partition.minTime < min ? partition.minTime : min),
    firstPartition.minTime
  )
  const derivedTo = opts.to ?? chunkPlan.partitions.reduce(
    (max, partition) => (partition.maxTime > max ? partition.maxTime : max),
    firstPartition.maxTime
  )

  const stateDir = computeBackfillStateDir(input.config, input.configPath, opts.stateDir)
  const paths = backfillPaths(stateDir, chunkPlan.planId)

  const { mvReplayQueries } = strategy

  const plan = {
    planId: chunkPlan.planId,
    target: opts.target,
    createdAt: nowIso(),
    ...(env ? { environment: env } : {}),
    from: derivedFrom,
    to: derivedTo,
    chunkPlan,
    execution: {
      mode: mvReplayQueries ? 'mv_replay' as const : 'copy' as const,
      sourceTarget: opts.target,
      ...(mvReplayQueries ? { mvReplayQueries } : {}),
      ...(targetColumns ? { targetColumns } : {}),
      requireIdempotencyToken: opts.requireIdempotencyToken,
    },
    options: {
      maxChunkBytes: opts.maxChunkBytes,
      maxParallelChunks: opts.maxParallelChunks,
      maxRetriesPerChunk: opts.maxRetriesPerChunk,
      requireIdempotencyToken: opts.requireIdempotencyToken,
      sortKeyColumn: chunkPlan.table.sortKeys[0]?.name,
    },
    policy: {
      requireDryRunBeforeRun: opts.requireDryRunBeforeRun,
      requireExplicitWindow: opts.requireExplicitWindow,
      blockOverlappingRuns: opts.blockOverlappingRuns,
      failCheckOnRequiredPendingBackfill: opts.failCheckOnRequiredPendingBackfill,
    },
    limits: {
      maxWindowHours: opts.maxWindowHours,
      minChunkMinutes: opts.minChunkMinutes,
    },
  }

  await writeJson(paths.planPath, {
    ...plan,
    chunkPlan: encodeChunkPlanForPersistence(plan.chunkPlan),
  })

  return {
    plan,
    planPath: paths.planPath,
  }
}

/**
 * Name the columns an mv_replay INSERT writes, the way ClickHouse does when a
 * materialized view inserts into its `TO` table: each view's output column goes
 * to the target column of the same name, whatever the order, and target columns
 * the view does not output get their DEFAULT. Chunk SQL renders this list on
 * both sides of `INSERT … SELECT`, so a `SELECT *` view never lines up by
 * position. The list is persisted in the plan, so `run` does not depend on
 * what the target looks like later.
 *
 * Fails when a view outputs a column the target cannot take (missing,
 * MATERIALIZED or ALIAS), which ClickHouse also refuses when the view is
 * created, and when views feeding one target output different column sets:
 * one INSERT cannot leave a column to its DEFAULT for some rows only.
 */
async function resolveReplayColumns(input: {
  target: string
  mvs: MaterializedViewDefinition[]
  insertableColumns: string[]
  query: ClickHouseQuery
  querySettings?: Record<string, string | number | boolean | undefined>
}): Promise<string[]> {
  const outputs = await Promise.all(input.mvs.map(async (mv) => {
    const rows = await input.query<{ name: string }>(
      `DESCRIBE TABLE (\n${mv.as}\n) SETTINGS ${ASTERISK_SETTINGS}`,
      input.querySettings
    )
    const names = rows.map((row) => row.name)
    if (!names.length) {
      throw new BackfillConfigError(`Cannot read the output columns of materialized view ${mv.database}.${mv.name}; automatic backfill is blocked.`)
    }
    const rejected = names.filter((name) => !input.insertableColumns.includes(name))
    if (rejected.length) {
      throw new BackfillConfigError(`Materialized view ${mv.database}.${mv.name} outputs column(s) ${rejected.join(', ')}, which ${input.target} cannot take (missing, MATERIALIZED or ALIAS). ClickHouse matches view output to target columns by name and refuses such a view by default; align the view's SELECT with the target (use AS to rename) before backfilling.`)
    }
    return { mv, names: new Set(names) }
  }))

  const [first, ...rest] = outputs
  if (!first) return []
  const mismatch = rest.find(({ names }) => names.size !== first.names.size || [...names].some((name) => !first.names.has(name)))
  if (mismatch) {
    const describe = ({ mv, names }: typeof first) => `${mv.database}.${mv.name} (${[...names].join(', ')})`
    throw new BackfillConfigError(`Materialized views feeding ${input.target} output different columns: ${describe(first)} vs ${describe(mismatch)}. Backfill replays them in one INSERT, which cannot leave a column to its DEFAULT for only some views' rows.`)
  }
  return input.insertableColumns.filter((name) => first.names.has(name))
}

/**
 * A plan names its replay columns at plan time. Before running it, make sure
 * the live target still takes every one of them, so a target altered after
 * planning fails with a clear message instead of on every chunk.
 */
export function assertReplayColumnsStillInsertable(input: {
  planId: string
  target: string
  targetColumns?: string[]
  insertableColumns: string[]
}): void {
  const missing = (input.targetColumns ?? []).filter((name) => !input.insertableColumns.includes(name))
  if (missing.length) {
    throw new BackfillConfigError(`Target ${input.target} changed since plan ${input.planId} was created: column(s) ${missing.join(', ')} are gone or no longer insertable. Create a new plan with backfill plan.`)
  }
}
