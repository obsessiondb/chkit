import * as Effect from 'effect/Effect'
import { fromPromise, runEffect } from '../effect-runtime.js'
import { formatBytes, getBackfillLogger } from '../logging.js'
import { buildRootSlice, mergeAdjacentSlices } from './partition-slices.js'
import { introspectPartitions, introspectSortKeys } from './services/metadata-source.js'
import { getRowProbeStrategy, getSortKeyRange, parsePlannerDateTime } from './services/row-probe.js'
import { splitSliceWithEqualWidthRanges } from './strategies/equal-width-split.js'
import { buildSingleChunkPartition } from './strategies/metadata-single-chunk.js'
import { findQuantileBoundaryOnDimension, splitSliceWithQuantiles } from './strategies/quantile-range-split.js'
import { refinePartitionSlices } from './strategies/refinement.js'
import { splitSliceWithGroupByKey } from './strategies/group-by-key-split.js'
import { buildRootStringUpperBound, splitSliceWithStringPrefixes } from './strategies/string-prefix-split.js'
import { splitSliceWithTemporalBuckets } from './strategies/temporal-bucket-split.js'
import { getCandidateDimensions } from './strategy-policy.js'
import type {
  Chunk,
  ChunkPlan,
  GenerateChunkPlanInput,
  Partition,
  PartitionBuildResult,
  PartitionSlice,
  PlannerContext,
  PlannerQuery,
  SortKey,
  TableProfile,
} from './types.js'
import { timedPlannerQuery } from './query-runtime.js'
import { generateChunkId, generatePlanId } from './utils/ids.js'
import { getChunkRange, isExactChunkRange, replaceChunkRange } from './utils/ranges.js'
const MAX_SPLIT_DEPTH_MULTIPLIER = 3
const STOP_SPLIT_FUZZ_FACTOR = 1.5
const logger = getBackfillLogger('chunking', 'planner')
export function generateChunkPlanEffect(input: GenerateChunkPlanInput): Effect.Effect<ChunkPlan, unknown> {
  return Effect.scoped(
    Effect.gen(function* () {
      const observer = yield* Effect.acquireRelease(
        Effect.sync(() => new AbortController()),
        (controller) => Effect.sync(() => controller.abort()),
      )
      const planStartedAt = performance.now()
      const context: PlannerContext = {
        database: input.database,
        table: input.table,
        from: input.from,
        to: input.to,
        targetChunkBytes: input.targetChunkBytes,
        query: createTimedPlannerQuery(input, observer.signal),
        querySettings: input.querySettings,
        rowProbeStrategy: input.rowProbeStrategy ?? 'count',
      }
      logger.info(
        `starting chunk plan for ${input.database}.${input.table} (target chunk size ${formatBytes(input.targetChunkBytes)}, row probe ${context.rowProbeStrategy})`,
      )
      const introspectionStartedAt = performance.now()
      const partitions = yield* fromPromise(() => introspectPartitions(context))
      const sortKeys = yield* fromPromise(() => introspectSortKeys(context))
      const table: TableProfile = {
        database: input.database,
        table: input.table,
        sortKeys,
      }
      const planId = generatePlanId()
      logger.info(
        `introspection completed for ${input.database}.${input.table}: ${partitions.length} partitions, ${partitions.filter((partition) => partition.bytesUncompressed > context.targetChunkBytes).length} oversized partitions, ${sortKeys.length} sort keys (${Math.round(performance.now() - introspectionStartedAt)}ms)`,
      )
      const slices: PartitionSlice[] = []
      const plannedPartitions: Partition[] = []
      for (const partition of partitions) {
        const result = yield* planPartition(context, partition, table)
        slices.push(...result.slices)
        plannedPartitions.push({
          ...partition,
          diagnostics: result.diagnostics,
        })
      }
      const chunks = assignChunkIds(planId, slices)
      const chunkBytes = chunks.map((chunk) => chunk.estimate.bytesUncompressed)
      const stats = {
        totalPartitions: partitions.length,
        oversizedPartitions: partitions.filter((partition) => partition.bytesUncompressed > context.targetChunkBytes)
          .length,
        focusedChunks: chunks.filter((chunk) => chunk.analysis.focusedValue !== undefined).length,
        totalChunks: chunks.length,
        avgChunkBytes:
          chunkBytes.length > 0 ? Math.round(chunkBytes.reduce((sum, value) => sum + value, 0) / chunkBytes.length) : 0,
        maxChunkBytes: chunkBytes.length > 0 ? Math.max(...chunkBytes) : 0,
        minChunkBytes: chunkBytes.length > 0 ? Math.min(...chunkBytes) : 0,
      }
      logger.info(
        `finished chunk plan for ${input.database}.${input.table}: ${chunks.length} chunks across ${partitions.length} partitions, ${formatBytes(partitions.reduce((sum, partition) => sum + partition.bytesUncompressed, 0))} uncompressed (${Math.round(performance.now() - planStartedAt)}ms)`,
      )
      return {
        planId,
        generatedAt: new Date().toISOString(),
        rowProbeStrategy: getRowProbeStrategy(context),
        targetChunkBytes: context.targetChunkBytes,
        table,
        partitions: plannedPartitions,
        chunks,
        totalRows: partitions.reduce((sum, partition) => sum + partition.rows, 0),
        totalBytesCompressed: partitions.reduce((sum, partition) => sum + partition.bytesCompressed, 0),
        totalBytesUncompressed: partitions.reduce((sum, partition) => sum + partition.bytesUncompressed, 0),
        stats,
      }
    }),
  )
}
function planPartition(
  context: PlannerContext,
  partition: Partition,
  table: TableProfile,
): Effect.Effect<PartitionBuildResult, unknown> {
  return Effect.gen(function* () {
    const startedAt = performance.now()
    logger.info(
      `planning partition ${partition.partitionId} (${partition.rows.toLocaleString()} rows, ${formatBytes(partition.bytesUncompressed)} uncompressed, target ${formatBytes(context.targetChunkBytes)})`,
    )
    if (partition.bytesUncompressed <= context.targetChunkBytes || table.sortKeys.length === 0) {
      const refined = yield* refinePartitionSlices(
        context,
        partition,
        buildSingleChunkPartition(partition),
        table.sortKeys,
        false,
      )
      logger.info(
        `kept partition ${partition.partitionId} as a single chunk (${Math.round(performance.now() - startedAt)}ms, ${partition.bytesUncompressed <= context.targetChunkBytes ? 'within target size' : 'no sort keys available'})`,
      )
      return refined
    }
    const rootSlice = buildRootSlice(partition)
    const splitSlices = yield* splitSliceRecursively(context, partition, rootSlice, table.sortKeys, 0)
    const mergedSlices = mergeAdjacentSlices(splitSlices, context.targetChunkBytes)
    const usedDistributionFallback = mergedSlices.some(
      (slice) =>
        slice.estimate.reason === 'string-prefix-distribution' ||
        slice.estimate.reason === 'group-by-key-distribution' ||
        slice.estimate.reason === 'temporal-distribution' ||
        slice.estimate.reason === 'equal-width-distribution',
    )
    logger.debug(
      `partition ${partition.partitionId} produced ${splitSlices.length} candidate slices before refinement (${mergedSlices.length} after merge, distribution fallback ${usedDistributionFallback ? 'used' : 'not used'})`,
    )
    const refined = yield* refinePartitionSlices(
      context,
      partition,
      mergedSlices,
      table.sortKeys,
      usedDistributionFallback,
    )
    logger.info(
      `finished partition ${partition.partitionId}: ${refined.slices.length} chunks (${Math.round(performance.now() - startedAt)}ms)`,
    )
    return refined
  })
}
function splitSliceRecursively(
  context: PlannerContext,
  partition: Partition,
  slice: PartitionSlice,
  sortKeys: SortKey[],
  depth: number,
): Effect.Effect<PartitionSlice[], unknown> {
  return Effect.gen(function* () {
    if (slice.estimate.bytesUncompressed <= context.targetChunkBytes * STOP_SPLIT_FUZZ_FACTOR) {
      logger.debug(
        `stopped splitting slice for partition ${partition.partitionId} at depth ${depth}: ${formatBytes(slice.estimate.bytesUncompressed)} is within threshold ${formatBytes(Math.round(context.targetChunkBytes * STOP_SPLIT_FUZZ_FACTOR))}`,
      )
      return [slice]
    }
    if (depth >= sortKeys.length * MAX_SPLIT_DEPTH_MULTIPLIER) {
      logger.debug(
        `stopped splitting slice for partition ${partition.partitionId}: reached max depth ${sortKeys.length * MAX_SPLIT_DEPTH_MULTIPLIER}`,
      )
      return [slice]
    }
    const children = yield* splitOversizedSlice(context, partition, slice, sortKeys, depth)
    if (children.length <= 1) {
      logger.debug(`slice could not be split further for partition ${partition.partitionId} at depth ${depth}`)
      return [slice]
    }
    const finalized: PartitionSlice[] = []
    for (const child of children) {
      finalized.push(...(yield* splitSliceRecursively(context, partition, child, sortKeys, depth + 1)))
    }
    return finalized
  })
}
function splitOversizedSlice(
  context: PlannerContext,
  partition: Partition,
  slice: PartitionSlice,
  sortKeys: SortKey[],
  depth: number,
): Effect.Effect<PartitionSlice[], unknown> {
  return Effect.gen(function* () {
    const candidateDimensions = getCandidateDimensions(sortKeys, slice)
    logger.debug(
      `attempting oversized slice split for partition ${partition.partitionId} at depth ${depth} (${formatBytes(slice.estimate.bytesUncompressed)} uncompressed across ${candidateDimensions.length} candidate dimensions)`,
    )
    for (const dimensionIndex of candidateDimensions) {
      const preparedSlice = yield* hydrateSliceRange(context, slice, sortKeys, dimensionIndex)
      if (!preparedSlice) continue
      const sortKey = sortKeys[dimensionIndex]
      if (!sortKey) continue
      const rootLike = depth === 0
      const focusedValue = findFocusedValue(preparedSlice, sortKeys)
      logger.debug(
        `trying split dimension ${dimensionIndex} on ${partition.partitionId} using ${sortKey.name} (${sortKey.category})`,
      )
      if (sortKey.category === 'string') {
        if (rootLike) {
          // First pass: equal-width EXPLAIN ESTIMATE (fast, metadata-only)
          const estimateSlices = yield* splitWithEqualWidthEstimate(
            context,
            partition,
            preparedSlice,
            sortKeys,
            dimensionIndex,
          )
          if (isEffectiveSplit(preparedSlice, estimateSlices)) {
            logger.debug(
              `equal-width estimate split succeeded for partition ${partition.partitionId}: ${estimateSlices.length} slices`,
            )
            return applyFocusedValue(estimateSlices, focusedValue)
          }
        } else {
          // Refinement pass: full GROUP BY key to detect hot keys directly
          const keySlices = yield* splitSliceWithGroupByKey(context, partition, preparedSlice, sortKeys, dimensionIndex)
          if (keySlices && isEffectiveSplit(preparedSlice, keySlices)) {
            logger.debug(
              `group-by-key split succeeded for partition ${partition.partitionId}: ${keySlices.length} slices`,
            )
            return applyFocusedValue(keySlices, focusedValue)
          }
          // Single hot key: narrow the range and re-enter dispatch so focusedValue is detected
          if (keySlices?.length === 1 && keySlices[0]?.analysis.focusedValue) {
            const refined = keySlices[0]
            const currentRange = getChunkRange(preparedSlice, dimensionIndex)
            const refinedRange = getChunkRange(refined, dimensionIndex)
            if (currentRange.from !== refinedRange.from || currentRange.to !== refinedRange.to) {
              logger.debug(`narrowed single hot key for partition ${partition.partitionId}, re-entering dispatch`)
              return yield* splitOversizedSlice(context, partition, refined, sortKeys, depth)
            }
          }
          // Fallback: GROUP BY prefix when too many distinct keys
          const stringSlices = yield* splitSliceWithStringPrefixes(
            context,
            partition,
            preparedSlice,
            sortKeys,
            dimensionIndex,
          )
          if (isEffectiveSplit(preparedSlice, stringSlices)) {
            logger.debug(
              `string-prefix split succeeded for partition ${partition.partitionId}: ${stringSlices.length} slices`,
            )
            return applyFocusedValue(stringSlices, focusedValue)
          }
        }
      }
      if (sortKey.category === 'datetime' && (!rootLike || focusedValue !== undefined)) {
        const temporalSlices = yield* splitSliceWithTemporalBuckets(
          context,
          partition,
          markFocusedSlice(preparedSlice, focusedValue),
          sortKeys,
          dimensionIndex,
        )
        if (isEffectiveSplit(preparedSlice, temporalSlices)) {
          logger.debug(
            `temporal bucket split succeeded for partition ${partition.partitionId}: ${temporalSlices.length} slices`,
          )
          return applyFocusedValue(temporalSlices, focusedValue)
        }
      }
      const rangedSlices = yield* splitWithRanges(context, partition, preparedSlice, sortKeys, dimensionIndex)
      if (isEffectiveSplit(preparedSlice, rangedSlices)) {
        logger.debug(
          `range-based split succeeded for partition ${partition.partitionId}: ${rangedSlices.length} slices`,
        )
        return applyFocusedValue(rangedSlices, focusedValue)
      }
    }
    logger.debug(`no effective split found for partition ${partition.partitionId} at depth ${depth}`)
    return [slice]
  })
}
function splitWithRanges(
  context: PlannerContext,
  partition: Partition,
  slice: PartitionSlice,
  sortKeys: SortKey[],
  dimensionIndex: number,
): Effect.Effect<PartitionSlice[], unknown> {
  return Effect.gen(function* () {
    const sortKey = sortKeys[dimensionIndex]
    if (!sortKey) return [slice]
    const range = getChunkRange(slice, dimensionIndex)
    if (range.from === undefined || range.to === undefined) return [slice]
    if (sortKey.category === 'string' && isExactChunkRange(range)) return [slice]
    const subCount = Math.ceil(slice.estimate.bytesUncompressed / context.targetChunkBytes)
    if (subCount <= 1) return [slice]
    const quantileBoundaries = yield* buildQuantileBoundaries(context, slice, sortKeys, dimensionIndex, subCount)
    if (quantileBoundaries) {
      logger.debug(
        `using quantile-aligned range split for partition ${partition.partitionId} on dimension ${dimensionIndex} with ${quantileBoundaries.length} boundaries`,
      )
      return yield* splitSliceWithQuantiles(context, partition, slice, sortKeys, dimensionIndex, quantileBoundaries)
    }
    logger.debug(
      `falling back to equal-width range split for partition ${partition.partitionId} on dimension ${dimensionIndex} with ${subCount} subranges`,
    )
    return yield* splitSliceWithEqualWidthRanges(
      context,
      partition,
      slice,
      sortKeys,
      dimensionIndex,
      range.from,
      range.to,
      subCount,
    )
  })
}
function splitWithEqualWidthEstimate(
  context: PlannerContext,
  partition: Partition,
  slice: PartitionSlice,
  sortKeys: SortKey[],
  dimensionIndex: number,
): Effect.Effect<PartitionSlice[], unknown> {
  return Effect.gen(function* () {
    const estimateContext: PlannerContext = {
      ...context,
      rowProbeStrategy: 'explain-estimate',
    }
    return yield* splitWithRanges(estimateContext, partition, slice, sortKeys, dimensionIndex)
  })
}
function buildQuantileBoundaries(
  context: PlannerContext,
  slice: PartitionSlice,
  sortKeys: SortKey[],
  dimensionIndex: number,
  subCount: number,
): Effect.Effect<string[] | undefined, unknown> {
  return Effect.gen(function* () {
    const range = getChunkRange(slice, dimensionIndex)
    if (range.from === undefined || range.to === undefined) return undefined
    const steps = Array.from({ length: subCount - 1 }, (_, i) => i + 1)
    const foundBoundaries = yield* Effect.forEach(
      steps,
      (step) =>
        Effect.gen(function* () {
          const targetCumRows = Math.round((slice.estimate.rows * step) / subCount)
          return yield* findQuantileBoundaryOnDimension(context, slice, sortKeys, dimensionIndex, targetCumRows)
        }),
      { concurrency: 10 },
    )
    const boundaries = [range.from, ...foundBoundaries]
    const uniqueBoundaryCount = new Set(boundaries).size
    if (uniqueBoundaryCount <= Math.max(2, Math.ceil(subCount / 3))) {
      logger.debug(
        `discarded quantile boundaries for partition ${slice.partitionId} on dimension ${dimensionIndex} because only ${uniqueBoundaryCount} unique boundaries remained`,
      )
      return undefined
    }
    return boundaries.concat([range.to])
  })
}
function hydrateSliceRange(
  context: PlannerContext,
  slice: PartitionSlice,
  sortKeys: SortKey[],
  dimensionIndex: number,
): Effect.Effect<PartitionSlice | undefined, unknown> {
  return Effect.gen(function* () {
    const existingRange = getChunkRange(slice, dimensionIndex)
    if (existingRange.from !== undefined && existingRange.to !== undefined) {
      return slice
    }
    const sortKey = sortKeys[dimensionIndex]
    if (!sortKey) return undefined
    const observedRange = yield* fromPromise(() =>
      getSortKeyRange(context, slice.partitionId, slice.ranges, sortKeys, sortKey),
    )
    if (!observedRange) return undefined
    logger.debug(
      `hydrated missing sort-key range for partition ${slice.partitionId} on ${sortKey.name}: [${observedRange.min}, ${observedRange.max}]`,
    )
    return {
      ...slice,
      ranges: replaceChunkRange(
        slice,
        dimensionIndex,
        observedRange.min,
        toExclusiveUpperBound(observedRange.max, sortKey),
      ),
    }
  })
}
function toExclusiveUpperBound(value: string, sortKey: SortKey): string {
  if (sortKey.category === 'string') {
    return buildRootStringUpperBound(value)
  }
  if (sortKey.category === 'datetime') {
    return new Date(parsePlannerDateTime(value) + 1000).toISOString()
  }
  return String(Number(value) + 1)
}
function isEffectiveSplit(parentSlice: PartitionSlice, childSlices: PartitionSlice[]): boolean {
  if (childSlices.length <= 1) return false
  return childSlices.some(
    (childSlice) =>
      childSlice.estimate.rows !== parentSlice.estimate.rows ||
      JSON.stringify(childSlice.ranges) !== JSON.stringify(parentSlice.ranges),
  )
}
function findFocusedValue(
  slice: PartitionSlice,
  sortKeys: SortKey[],
):
  | {
      dimensionIndex: number
      value: string
    }
  | undefined {
  for (const range of slice.ranges) {
    const sortKey = sortKeys[range.dimensionIndex]
    if (sortKey?.category !== 'string') continue
    if (isExactChunkRange(range) && range.from !== undefined) {
      return { dimensionIndex: range.dimensionIndex, value: range.from }
    }
  }
  return undefined
}
function applyFocusedValue(
  slices: PartitionSlice[],
  focusedValue:
    | {
        dimensionIndex: number
        value: string
      }
    | undefined,
): PartitionSlice[] {
  if (!focusedValue) return slices
  return slices.map((slice) => markFocusedSlice(slice, focusedValue))
}
function markFocusedSlice(
  slice: PartitionSlice,
  focusedValue:
    | {
        dimensionIndex: number
        value: string
      }
    | undefined,
): PartitionSlice {
  if (!focusedValue) return slice
  return {
    ...slice,
    analysis: {
      ...slice.analysis,
      focusedValue,
    },
  }
}
function assignChunkIds(planId: string, slices: PartitionSlice[]): Chunk[] {
  const chunkIndexes = new Map<string, number>()
  return slices.map((slice) => {
    const currentIndex = chunkIndexes.get(slice.partitionId) ?? 0
    chunkIndexes.set(slice.partitionId, currentIndex + 1)
    return {
      ...slice,
      id: generateChunkId(planId, slice.partitionId, currentIndex),
    }
  })
}
function createTimedPlannerQuery(
  input: Pick<GenerateChunkPlanInput, 'database' | 'table' | 'query'>,
  signal: AbortSignal,
): PlannerQuery {
  return <T>(sql: string, settings?: Record<string, string | number | boolean | undefined>): Promise<T[]> =>
    runEffect(timedPlannerQuery<T>(input, sql, settings), signal)
}
