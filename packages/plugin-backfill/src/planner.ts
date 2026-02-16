import type { ResolvedChxConfig } from '@chkit/core'

import { BackfillConfigError } from './errors.js'
import {
  backfillPaths,
  computeBackfillStateDir,
  hashId,
  planIdentity,
  readExistingPlan,
  stableSerialize,
  writeJson,
} from './state.js'
import type {
  BackfillChunk,
  BackfillPluginLimits,
  BuildBackfillPlanOutput,
  NormalizedBackfillPluginOptions,
} from './types.js'

function ensureHoursWithinLimits(input: {
  from: string
  to: string
  limits: Required<BackfillPluginLimits>
  forceLargeWindow: boolean
}): void {
  const fromMillis = new Date(input.from).getTime()
  const toMillis = new Date(input.to).getTime()
  if (toMillis <= fromMillis) {
    throw new BackfillConfigError('Invalid backfill window. Expected --to to be after --from.')
  }

  const durationHours = (toMillis - fromMillis) / (1000 * 60 * 60)
  if (durationHours > input.limits.maxWindowHours && !input.forceLargeWindow) {
    throw new BackfillConfigError(
      `Requested window (${durationHours.toFixed(2)} hours) exceeds limits.maxWindowHours=${input.limits.maxWindowHours}. Retry with --force-large-window to acknowledge risk.`
    )
  }
}

function buildChunkSqlTemplate(chunk: {
  planId: string
  chunkId: string
  token: string
  target: string
  from: string
  to: string
}): string {
  return [
    `/* chkit backfill plan=${chunk.planId} chunk=${chunk.chunkId} token=${chunk.token} */`,
    `INSERT INTO ${chunk.target}`,
    `SELECT *`,
    `FROM ${chunk.target}`,
    `WHERE event_time >= toDateTime('${chunk.from}')`,
    `  AND event_time < toDateTime('${chunk.to}');`,
  ].join('\n')
}

function buildChunks(input: {
  planId: string
  target: string
  from: string
  to: string
  chunkHours: number
  requireIdempotencyToken: boolean
}): BackfillChunk[] {
  const fromMillis = new Date(input.from).getTime()
  const toMillis = new Date(input.to).getTime()
  const chunkMillis = input.chunkHours * 60 * 60 * 1000

  const chunks: BackfillChunk[] = []
  let current = fromMillis

  while (current < toMillis) {
    const next = Math.min(current + chunkMillis, toMillis)
    const chunkFrom = new Date(current).toISOString()
    const chunkTo = new Date(next).toISOString()
    const idSeed = `${input.planId}:${chunkFrom}:${chunkTo}`
    const chunkId = hashId(`chunk:${idSeed}`).slice(0, 16)
    const token = input.requireIdempotencyToken ? hashId(`token:${idSeed}`) : ''

    chunks.push({
      id: chunkId,
      from: chunkFrom,
      to: chunkTo,
      status: 'pending',
      attempts: 0,
      idempotencyToken: token,
      sqlTemplate: buildChunkSqlTemplate({
        planId: input.planId,
        chunkId,
        token,
        target: input.target,
        from: chunkFrom,
        to: chunkTo,
      }),
    })

    current = next
  }

  return chunks
}

export async function buildBackfillPlan(input: {
  target: string
  from: string
  to: string
  configPath: string
  config: Pick<ResolvedChxConfig, 'metaDir'>
  options: NormalizedBackfillPluginOptions
  chunkHours?: number
  forceLargeWindow?: boolean
}): Promise<BuildBackfillPlanOutput> {
  const chunkHours = input.chunkHours ?? input.options.defaults.chunkHours
  if (chunkHours * 60 < input.options.limits.minChunkMinutes) {
    throw new BackfillConfigError(
      `Chunk size ${chunkHours}h is below limits.minChunkMinutes=${input.options.limits.minChunkMinutes}.`
    )
  }

  ensureHoursWithinLimits({
    from: input.from,
    to: input.to,
    limits: input.options.limits,
    forceLargeWindow: input.forceLargeWindow ?? false,
  })

  const planId = hashId(planIdentity(input.target, input.from, input.to, chunkHours)).slice(0, 16)
  const stateDir = computeBackfillStateDir(input.config, input.configPath, input.options)
  const paths = backfillPaths(stateDir, planId)

  const plan = {
    planId,
    target: input.target,
    createdAt: '1970-01-01T00:00:00.000Z',
    status: 'planned' as const,
    from: input.from,
    to: input.to,
    chunks: buildChunks({
      planId,
      target: input.target,
      from: input.from,
      to: input.to,
      chunkHours,
      requireIdempotencyToken: input.options.defaults.requireIdempotencyToken,
    }),
    options: {
      chunkHours,
      maxParallelChunks: input.options.defaults.maxParallelChunks,
      maxRetriesPerChunk: input.options.defaults.maxRetriesPerChunk,
      requireIdempotencyToken: input.options.defaults.requireIdempotencyToken,
    },
    policy: input.options.policy,
    limits: input.options.limits,
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
