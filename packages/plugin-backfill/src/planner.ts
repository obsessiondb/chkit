import { dirname } from 'node:path'
import { unlink } from 'node:fs/promises'

import { loadSchemaDefinitions } from '@chkit/core/schema-loader'
import type { ResolvedChxConfig } from '@chkit/core'

import { analyzeTable, buildPlannedChunks } from './chunking/index.js'
import { buildChunkSql } from './chunking/sql.js'
import { findMvForTarget } from './detect.js'
import { BackfillConfigError } from './errors.js'
import {
  backfillPaths,
  computeBackfillStateDir,
  computeEnvironmentFingerprint,
  hashId,
  planIdentity,
  readExistingPlan,
  stableSerialize,
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
  force?: boolean
  clickhouse?: { url: string; database: string }
  clickhouseQuery: <T>(sql: string) => Promise<T[]>
}): Promise<BuildBackfillPlanOutput> {
  const [database, table] = input.target.split('.')
  if (!database || !table) {
    throw new BackfillConfigError('Invalid target format. Expected <database.table>.')
  }

  const env = computeEnvironmentFingerprint(input.clickhouse)
  const maxChunkBytes = input.maxChunkBytes ?? DEFAULT_MAX_CHUNK_BYTES

  // 1. Analyze table: introspect partitions, sort key, and build chunk boundaries
  const { partitions, sortKey, boundaries } = await analyzeTable({
    database,
    table,
    from: input.from,
    to: input.to,
    maxChunkBytes,
    query: input.clickhouseQuery,
  })

  if (partitions.length === 0) {
    throw new BackfillConfigError(
      `No partitions found for ${input.target}${input.from || input.to ? ' within the specified time range' : ''}. The table may be empty.`
    )
  }

  // 2. Compute plan identity (requires partition data for derived time bounds)
  const firstPartition = partitions[0] as PartitionInfo
  const derivedFrom = input.from ?? partitions.reduce((min, p) => (p.minTime < min ? p.minTime : min), firstPartition.minTime)
  const derivedTo = input.to ?? partitions.reduce((max, p) => (p.maxTime > max ? p.maxTime : max), firstPartition.maxTime)

  const chunkParam = `partition:${maxChunkBytes}`
  const sortKeyColumn = sortKey?.column ?? ''
  const planId = hashId(planIdentity(input.target, derivedFrom, derivedTo, chunkParam, sortKeyColumn, env?.fingerprint)).slice(0, 16)
  const stateDir = computeBackfillStateDir(input.config, input.configPath, input.options)
  const paths = backfillPaths(stateDir, planId)

  // 3. Build planned chunks from boundaries (now that we have planId for deterministic IDs)
  const plannedChunks = buildPlannedChunks({
    planId,
    partitions,
    boundaries,
    requireIdempotencyToken: input.options.defaults.requireIdempotencyToken,
  })

  // 4. Detect MV for replay strategy
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

  // 5. Stamp SQL on each planned chunk to produce BackfillChunk[]
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

  return persistPlan(plan, paths, input.force)
}

async function persistPlan(
  plan: BuildBackfillPlanOutput['plan'],
  paths: ReturnType<typeof backfillPaths>,
  force?: boolean
): Promise<BuildBackfillPlanOutput> {
  if (force) {
    for (const filePath of [paths.planPath, paths.runPath, paths.eventPath]) {
      await unlink(filePath).catch((err: NodeJS.ErrnoException) => {
        if (err.code !== 'ENOENT') throw err
      })
    }
  }

  const existing = await readExistingPlan(paths.planPath)
  if (existing) {
    if (stableSerialize(existing) !== stableSerialize(plan)) {
      throw new BackfillConfigError(
        `Backfill plan already exists at ${paths.planPath} but differs from current planning output. Remove it if you intentionally changed planning parameters.`
      )
    }
    return {
      plan: existing,
      planPath: paths.planPath,
      existed: true,
    }
  }

  await writeJson(paths.planPath, plan)

  return {
    plan,
    planPath: paths.planPath,
    existed: false,
  }
}
