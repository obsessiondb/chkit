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
  targetColumns?: string[]
}

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

    const tableDef = definitions.find(
      (definition) =>
        definition.kind === 'table' &&
        definition.database === input.database &&
        definition.name === input.table
    )
    if (tableDef?.kind === 'table' && tableDef.columns.some((column) => column.defaultKind === 'EPHEMERAL')) {
      throw new BackfillConfigError('Automatic backfill cannot reconstruct EPHEMERAL inputs; use an explicit INSERT with an input column mapping.')
    }
    if (mvs.length === 0) return { mvs: [] }
    return {
      mvs,
      mvReplayQueries: mvs.map((mv) => mv.as),
      targetColumns: tableDef?.kind === 'table'
        ? tableDef.columns
          .filter((column) => !column.defaultKind || column.defaultKind === 'DEFAULT')
          .map((column) => column.name)
        : undefined,
    }
  } catch (error) {
    if (error instanceof BackfillConfigError) throw error
    // Schema load failed, fall back to direct copy.
    return { mvs: [] }
  }
}

/** Missing, unreadable or unsupported metadata must never bypass the safety gate. */
export async function assertBackfillTargetSafe(input: {
  database: string
  table: string
  query: <T>(sql: string, settings?: Record<string, string | number | boolean | undefined>) => Promise<T[]>
  querySettings?: Record<string, string | number | boolean | undefined>
}): Promise<void> {
  const quote = (value: string) => `'${value.replaceAll('\\', '\\\\').replaceAll("'", "\\'")}'`
  const rows = await input.query<{ name: string; default_kind: string }>(
    `SELECT name, default_kind FROM system.columns WHERE database = ${quote(input.database)} AND table = ${quote(input.table)} ORDER BY position`,
    input.querySettings
  )
  if (!rows.length || rows.some((column) => !column.name || !['', 'DEFAULT', 'MATERIALIZED', 'ALIAS', 'EPHEMERAL'].includes(column.default_kind))) {
    throw new BackfillConfigError('Cannot verify live target column kinds; automatic backfill is blocked. Check metadata access and use an explicit INSERT if needed.')
  }
  if (rows.some((column) => column.default_kind === 'EPHEMERAL')) {
    throw new BackfillConfigError('Automatic backfill cannot reconstruct EPHEMERAL inputs; use an explicit INSERT with an input column mapping.')
  }
}

export async function buildBackfillPlan(input: {
  opts: PlanOptions
  configPath: string
  config: Pick<ResolvedChxConfig, 'metaDir' | 'schema'>
  clickhouse?: { url: string; database: string }
  clickhouseQuery: <T>(sql: string, settings?: Record<string, string | number | boolean | undefined>) => Promise<T[]>
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
  await assertBackfillTargetSafe({
    database, table, query: input.clickhouseQuery, querySettings: input.querySettings,
  })
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

  const { mvReplayQueries, targetColumns } = strategy

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
