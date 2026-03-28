import { dirname } from 'node:path'

import { loadSchemaDefinitions } from '@chkit/core/schema-loader'
import type { ResolvedChxConfig } from '@chkit/core'

import { analyzeAndChunk } from './chunking/analyze.js'
import { buildChunkSql } from './chunking/sql.js'
import { findMvForTarget } from './detect.js'
import { BackfillConfigError } from './errors.js'
import {
  backfillPaths,
  computeBackfillStateDir,
  computeEnvironmentFingerprint,
  writeJson,
} from './state.js'
import type {
  BackfillChunk,
  BuildBackfillPlanOutput,
  NormalizedBackfillPluginOptions,
  PartitionInfo,
} from './types.js'

const DEFAULT_MAX_CHUNK_BYTES = 10 * 1024 ** 3 // 10 GiB

export async function buildBackfillPlan(input: {
  target: string
  from?: string
  to?: string
  configPath: string
  config: Pick<ResolvedChxConfig, 'metaDir' | 'schema'>
  options: NormalizedBackfillPluginOptions
  maxChunkBytes?: number
  clickhouse?: { url: string; database: string }
  clickhouseQuery: <T>(sql: string) => Promise<T[]>
}): Promise<BuildBackfillPlanOutput> {
  const [database, table] = input.target.split('.')
  if (!database || !table) {
    throw new BackfillConfigError('Invalid target format. Expected <database.table>.')
  }

  const env = computeEnvironmentFingerprint(input.clickhouse)
  const maxChunkBytes = input.maxChunkBytes ?? DEFAULT_MAX_CHUNK_BYTES

  // 1. Analyze table and build planned chunks
  const { planId, partitions, sortKey, chunks: plannedChunks } = await analyzeAndChunk({
    database,
    table,
    from: input.from,
    to: input.to,
    maxChunkBytes,
    requireIdempotencyToken: input.options.defaults.requireIdempotencyToken,
    query: input.clickhouseQuery,
  })

  if (partitions.length === 0) {
    throw new BackfillConfigError(
      `No partitions found for ${input.target}${input.from || input.to ? ' within the specified time range' : ''}. The table may be empty.`
    )
  }

  const firstPartition = partitions[0] as PartitionInfo
  const derivedFrom = input.from ?? partitions.reduce((min, p) => (p.minTime < min ? p.minTime : min), firstPartition.minTime)
  const derivedTo = input.to ?? partitions.reduce((max, p) => (p.maxTime > max ? p.maxTime : max), firstPartition.maxTime)

  const stateDir = computeBackfillStateDir(input.config, input.configPath, input.options)
  const paths = backfillPaths(stateDir, planId)

  // 2. Detect MV for replay strategy
  let mvAsQuery: string | undefined
  let targetColumns: string[] | undefined

  try {
    const definitions = await loadSchemaDefinitions(input.config.schema, {
      cwd: dirname(input.configPath),
    })
    const mv = findMvForTarget(definitions, database, table)
    if (mv) {
      mvAsQuery = mv.as
      const tableDef = definitions.find(
        (d) => d.kind === 'table' && d.database === database && d.name === table
      )
      if (tableDef && tableDef.kind === 'table') {
        targetColumns = tableDef.columns.map((c) => c.name)
      }
    }
  } catch {
    // Schema load failed — fall back to direct copy
  }

  // 3. Stamp SQL on each planned chunk to produce BackfillChunk[]
  const chunks: BackfillChunk[] = plannedChunks.map(planned => {
    const sqlTemplate = buildChunkSql({
      planId,
      chunk: planned,
      target: input.target,
      sortKey,
      mvAsQuery,
      targetColumns,
    })

    return {
      id: planned.id,
      from: planned.from,
      to: planned.to,
      status: 'pending' as const,
      attempts: 0,
      idempotencyToken: planned.idempotencyToken,
      sqlTemplate,
      partitionId: planned.partitionId,
      estimatedBytes: planned.estimatedBytes,
      ...(planned.sortKeyFrom !== undefined ? { sortKeyFrom: planned.sortKeyFrom } : {}),
      ...(planned.sortKeyTo !== undefined ? { sortKeyTo: planned.sortKeyTo } : {}),
    }
  })

  const strategy = mvAsQuery ? 'mv_replay' : 'partition'

  const plan = {
    planId,
    target: input.target,
    createdAt: '1970-01-01T00:00:00.000Z',
    status: 'planned' as const,
    strategy: strategy as 'partition' | 'mv_replay',
    ...(env ? { environment: env } : {}),
    from: derivedFrom,
    to: derivedTo,
    chunks,
    partitions,
    sortKey,
    options: {
      maxChunkBytes,
      maxParallelChunks: input.options.defaults.maxParallelChunks,
      maxRetriesPerChunk: input.options.defaults.maxRetriesPerChunk,
      requireIdempotencyToken: input.options.defaults.requireIdempotencyToken,
      sortKeyColumn: sortKey?.column,
    },
    policy: input.options.policy,
    limits: input.options.limits,
  }

  await writeJson(paths.planPath, plan)

  return {
    plan,
    planPath: paths.planPath,
  }
}
