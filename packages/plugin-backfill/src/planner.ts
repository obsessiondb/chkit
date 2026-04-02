import { dirname } from 'node:path'

import type { ResolvedChxConfig } from '@chkit/core'
import { loadSchemaDefinitions } from '@chkit/core/schema-loader'

import { encodeChunkPlanForPersistence } from './chunking/boundary-codec.js'
import { generateChunkPlan } from './chunking/planner.js'
import { findMvForTarget } from './detect.js'
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

  const chunkPlan = await generateChunkPlan({
    database,
    table,
    from: opts.from,
    to: opts.to,
    targetChunkBytes: opts.maxChunkBytes,
    query: input.clickhouseQuery,
  })

  const firstPartition = chunkPlan.partitions[0]
  if (!firstPartition) {
    throw new BackfillConfigError(
      `No partitions found for ${opts.target}${opts.from || opts.to ? ' within the specified time range' : ''}. The table may be empty.`
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
        (definition) => definition.kind === 'table' && definition.database === database && definition.name === table
      )
      if (tableDef?.kind === 'table') {
        targetColumns = tableDef.columns.map((column) => column.name)
      }
    }
  } catch {
    // Schema load failed, fall back to direct copy.
  }

  const plan = {
    planId: chunkPlan.planId,
    target: opts.target,
    createdAt: nowIso(),
    ...(env ? { environment: env } : {}),
    from: derivedFrom,
    to: derivedTo,
    chunkPlan,
    execution: {
      mode: mvAsQuery ? 'mv_replay' as const : 'copy' as const,
      sourceTarget: opts.target,
      ...(mvAsQuery ? { mvAsQuery } : {}),
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
