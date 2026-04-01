import { dirname } from 'node:path'

import { loadSchemaDefinitions } from '@chkit/core/schema-loader'
import type { ResolvedChxConfig } from '@chkit/core'

import { analyzeAndChunk } from './chunking/analyze.js'
import { buildChunkSql } from './chunking/sql.js'
import { findMvForTarget } from './detect.js'
import { BackfillConfigError } from './errors.js'
import type { PlanOptions } from './options.js'
import {
  backfillPaths,
  computeBackfillStateDir,
  computeEnvironmentFingerprint,
  writeJson,
} from './state.js'
import type {
  BackfillChunk,
  BuildBackfillPlanOutput,
  PartitionInfo,
} from './types.js'

export async function buildBackfillPlan(input: {
  opts: PlanOptions
  configPath: string
  config: Pick<ResolvedChxConfig, 'metaDir' | 'schema'>
  clickhouse?: { url: string; database: string }
  clickhouseQuery: <T>(sql: string) => Promise<T[]>
}): Promise<BuildBackfillPlanOutput> {
  const { opts } = input
  const [database, table] = opts.target.split('.')
  if (!database || !table) {
    throw new BackfillConfigError('Invalid target format. Expected <database.table>.')
  }

  const env = computeEnvironmentFingerprint(input.clickhouse)

  // 1. Analyze table and build planned chunks
  const {
    planId,
    partitions,
    sortKey,
    sortKeys,
    chunks: plannedChunks,
    partitionDiagnostics,
  } = await analyzeAndChunk({
    database,
    table,
    from: opts.from,
    to: opts.to,
    maxChunkBytes: opts.maxChunkBytes,
    requireIdempotencyToken: opts.requireIdempotencyToken,
    query: input.clickhouseQuery,
  })

  if (partitions.length === 0) {
    throw new BackfillConfigError(
      `No partitions found for ${opts.target}${opts.from || opts.to ? ' within the specified time range' : ''}. The table may be empty.`
    )
  }

  const firstPartition = partitions[0] as PartitionInfo
  const derivedFrom = opts.from ?? partitions.reduce((min, p) => (p.minTime < min ? p.minTime : min), firstPartition.minTime)
  const derivedTo = opts.to ?? partitions.reduce((max, p) => (p.maxTime > max ? p.maxTime : max), firstPartition.maxTime)

  const stateDir = computeBackfillStateDir(input.config, input.configPath, opts.stateDir)
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
      target: opts.target,
      sortKey,
      sortKeys,
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
      ...(planned.estimatedRows !== undefined ? { estimatedRows: planned.estimatedRows } : {}),
      ...(planned.ranges ? { ranges: planned.ranges } : {}),
      ...(planned.sortKeyFrom !== undefined ? { sortKeyFrom: planned.sortKeyFrom } : {}),
      ...(planned.sortKeyTo !== undefined ? { sortKeyTo: planned.sortKeyTo } : {}),
      ...(planned.isHotKey !== undefined ? { isHotKey: planned.isHotKey } : {}),
      ...(planned.hotDimensionIndex !== undefined ? { hotDimensionIndex: planned.hotDimensionIndex } : {}),
      ...(planned.hotKeyValue !== undefined ? { hotKeyValue: planned.hotKeyValue } : {}),
      ...(planned.estimateConfidence !== undefined ? { estimateConfidence: planned.estimateConfidence } : {}),
      ...(planned.estimateReason !== undefined ? { estimateReason: planned.estimateReason } : {}),
      ...(planned.lineage ? { lineage: planned.lineage } : {}),
    }
  })

  const strategy = mvAsQuery ? 'mv_replay' : 'partition'

  const plan = {
    planId,
    target: opts.target,
    createdAt: '1970-01-01T00:00:00.000Z',
    status: 'planned' as const,
    strategy: strategy as 'partition' | 'mv_replay',
    ...(env ? { environment: env } : {}),
    from: derivedFrom,
    to: derivedTo,
    chunks,
    partitions,
    sortKey,
    sortKeys,
    partitionDiagnostics,
    options: {
      maxChunkBytes: opts.maxChunkBytes,
      maxParallelChunks: opts.maxParallelChunks,
      maxRetriesPerChunk: opts.maxRetriesPerChunk,
      requireIdempotencyToken: opts.requireIdempotencyToken,
      sortKeyColumn: sortKey?.column,
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

  await writeJson(paths.planPath, plan)

  return {
    plan,
    planPath: paths.planPath,
  }
}
