import { buildRootSlice, mergeAdjacentSlices } from './partition-slices.js'
import { introspectPartitions, introspectSortKeys } from './services/metadata-source.js'
import { getRowProbeStrategy, getSortKeyRange, parsePlannerDateTime } from './services/row-probe.js'
import { splitSliceWithEqualWidthRanges } from './strategies/equal-width-split.js'
import { buildSingleChunkPartition } from './strategies/metadata-single-chunk.js'
import {
  findQuantileBoundaryOnDimension,
  splitSliceWithQuantiles,
} from './strategies/quantile-range-split.js'
import { refinePartitionSlices } from './strategies/refinement.js'
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
  SortKey,
  TableProfile,
} from './types.js'
import { generateChunkId, generatePlanId } from './utils/ids.js'
import { getChunkRange, isExactChunkRange, replaceChunkRange } from './utils/ranges.js'

const MAX_SPLIT_DEPTH_MULTIPLIER = 3
const STOP_SPLIT_FUZZ_FACTOR = 1.5

export async function generateChunkPlan(input: GenerateChunkPlanInput): Promise<ChunkPlan> {
  const context: PlannerContext = {
    database: input.database,
    table: input.table,
    from: input.from,
    to: input.to,
    targetChunkBytes: input.targetChunkBytes,
    query: input.query,
    querySettings: input.querySettings,
    rowProbeStrategy: input.rowProbeStrategy ?? 'count',
  }

  const partitions = await introspectPartitions(context)
  const sortKeys = await introspectSortKeys(context)
  const table: TableProfile = {
    database: input.database,
    table: input.table,
    sortKeys,
  }
  const planId = generatePlanId()

  const slices: PartitionSlice[] = []
  const plannedPartitions: Partition[] = []
  for (const partition of partitions) {
    const result = await planPartition(context, partition, table)
    slices.push(...result.slices)
    plannedPartitions.push({
      ...partition,
      diagnostics: result.diagnostics,
    })
  }

  const chunks = assignChunkIds(planId, slices)
  const chunkBytes = chunks.map((chunk) => chunk.estimate.bytesCompressed)

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
    stats: {
      totalPartitions: partitions.length,
      oversizedPartitions: partitions.filter((partition) => partition.bytesCompressed > context.targetChunkBytes).length,
      focusedChunks: chunks.filter((chunk) => chunk.analysis.focusedValue !== undefined).length,
      totalChunks: chunks.length,
      avgChunkBytes: chunkBytes.length > 0
        ? Math.round(chunkBytes.reduce((sum, value) => sum + value, 0) / chunkBytes.length)
        : 0,
      maxChunkBytes: chunkBytes.length > 0 ? Math.max(...chunkBytes) : 0,
      minChunkBytes: chunkBytes.length > 0 ? Math.min(...chunkBytes) : 0,
    },
  }
}

async function planPartition(
  context: PlannerContext,
  partition: Partition,
  table: TableProfile,
): Promise<PartitionBuildResult> {
  if (partition.bytesCompressed <= context.targetChunkBytes || table.sortKeys.length === 0) {
    return refinePartitionSlices(
      context,
      partition,
      buildSingleChunkPartition(partition),
      table.sortKeys,
      false
    )
  }

  const rootSlice = buildRootSlice(partition)
  const splitSlices = await splitSliceRecursively(context, partition, rootSlice, table.sortKeys, 0)
  const mergedSlices = mergeAdjacentSlices(splitSlices, context.targetChunkBytes)
  const usedDistributionFallback = mergedSlices.some((slice) =>
    slice.estimate.reason === 'string-prefix-distribution' ||
    slice.estimate.reason === 'temporal-distribution' ||
    slice.estimate.reason === 'equal-width-distribution'
  )

  return refinePartitionSlices(
    context,
    partition,
    mergedSlices,
    table.sortKeys,
    usedDistributionFallback
  )
}

async function splitSliceRecursively(
  context: PlannerContext,
  partition: Partition,
  slice: PartitionSlice,
  sortKeys: SortKey[],
  depth: number,
): Promise<PartitionSlice[]> {
  if (slice.estimate.bytesCompressed <= context.targetChunkBytes * STOP_SPLIT_FUZZ_FACTOR) {
    return [slice]
  }

  if (depth >= sortKeys.length * MAX_SPLIT_DEPTH_MULTIPLIER) {
    return [slice]
  }

  const children = await splitOversizedSlice(context, partition, slice, sortKeys, depth)
  if (children.length <= 1) {
    return [slice]
  }

  const finalized: PartitionSlice[] = []
  for (const child of children) {
    finalized.push(...(await splitSliceRecursively(context, partition, child, sortKeys, depth + 1)))
  }

  return finalized
}

async function splitOversizedSlice(
  context: PlannerContext,
  partition: Partition,
  slice: PartitionSlice,
  sortKeys: SortKey[],
  depth: number,
): Promise<PartitionSlice[]> {
  const candidateDimensions = getCandidateDimensions(sortKeys, slice)

  for (const dimensionIndex of candidateDimensions) {
    const preparedSlice = await hydrateSliceRange(context, slice, sortKeys, dimensionIndex)
    if (!preparedSlice) continue

    const sortKey = sortKeys[dimensionIndex]
    if (!sortKey) continue

    const rootLike = depth === 0
    const focusedValue = findFocusedValue(preparedSlice, sortKeys)

    if (sortKey.category === 'string') {
      const stringSlices = await splitSliceWithStringPrefixes(context, partition, preparedSlice, sortKeys, dimensionIndex)
      if (isEffectiveSplit(preparedSlice, stringSlices)) {
        return applyFocusedValue(stringSlices, focusedValue)
      }
    }

    if (sortKey.category === 'datetime' && (!rootLike || focusedValue !== undefined)) {
      const temporalSlices = await splitSliceWithTemporalBuckets(
        context,
        partition,
        markFocusedSlice(preparedSlice, focusedValue),
        sortKeys,
        dimensionIndex
      )
      if (isEffectiveSplit(preparedSlice, temporalSlices)) {
        return applyFocusedValue(temporalSlices, focusedValue)
      }
    }

    const rangedSlices = await splitWithRanges(context, partition, preparedSlice, sortKeys, dimensionIndex)
    if (isEffectiveSplit(preparedSlice, rangedSlices)) {
      return applyFocusedValue(rangedSlices, focusedValue)
    }
  }

  return [slice]
}

async function splitWithRanges(
  context: PlannerContext,
  partition: Partition,
  slice: PartitionSlice,
  sortKeys: SortKey[],
  dimensionIndex: number,
): Promise<PartitionSlice[]> {
  const sortKey = sortKeys[dimensionIndex]
  if (!sortKey) return [slice]

  const range = getChunkRange(slice, dimensionIndex)
  if (range.from === undefined || range.to === undefined) return [slice]
  if (sortKey.category === 'string' && isExactChunkRange(range)) return [slice]

  const subCount = Math.ceil(slice.estimate.bytesCompressed / context.targetChunkBytes)
  if (subCount <= 1) return [slice]

  const quantileBoundaries = await buildQuantileBoundaries(context, slice, sortKeys, dimensionIndex, subCount)
  if (quantileBoundaries) {
    return splitSliceWithQuantiles(context, partition, slice, sortKeys, dimensionIndex, quantileBoundaries)
  }

  return splitSliceWithEqualWidthRanges(
    context,
    partition,
    slice,
    sortKeys,
    dimensionIndex,
    range.from,
    range.to,
    subCount
  )
}

async function buildQuantileBoundaries(
  context: PlannerContext,
  slice: PartitionSlice,
  sortKeys: SortKey[],
  dimensionIndex: number,
  subCount: number,
): Promise<string[] | undefined> {
  const range = getChunkRange(slice, dimensionIndex)
  if (range.from === undefined || range.to === undefined) return undefined

  const boundaries: string[] = [range.from]
  for (let step = 1; step < subCount; step++) {
    const targetCumRows = Math.round((slice.estimate.rows * step) / subCount)
    const boundary = await findQuantileBoundaryOnDimension(
      context,
      slice,
      sortKeys,
      dimensionIndex,
      targetCumRows
    )
    boundaries.push(boundary)
  }

  const uniqueBoundaryCount = new Set(boundaries).size
  if (uniqueBoundaryCount <= Math.max(2, Math.ceil(subCount / 3))) {
    return undefined
  }

  return boundaries.concat([range.to])
}

async function hydrateSliceRange(
  context: PlannerContext,
  slice: PartitionSlice,
  sortKeys: SortKey[],
  dimensionIndex: number,
): Promise<PartitionSlice | undefined> {
  const existingRange = getChunkRange(slice, dimensionIndex)
  if (existingRange.from !== undefined && existingRange.to !== undefined) {
    return slice
  }

  const sortKey = sortKeys[dimensionIndex]
  if (!sortKey) return undefined

  const observedRange = await getSortKeyRange(context, slice.partitionId, slice.ranges, sortKeys, sortKey)
  if (!observedRange) return undefined

  return {
    ...slice,
    ranges: replaceChunkRange(
      slice,
      dimensionIndex,
      observedRange.min,
      toExclusiveUpperBound(observedRange.max, sortKey)
    ),
  }
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

  return childSlices.some((childSlice) =>
    childSlice.estimate.rows !== parentSlice.estimate.rows ||
    JSON.stringify(childSlice.ranges) !== JSON.stringify(parentSlice.ranges)
  )
}

function findFocusedValue(
  slice: PartitionSlice,
  sortKeys: SortKey[],
): { dimensionIndex: number; value: string } | undefined {
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
  focusedValue: { dimensionIndex: number; value: string } | undefined,
): PartitionSlice[] {
  if (!focusedValue) return slices
  return slices.map((slice) => markFocusedSlice(slice, focusedValue))
}

function markFocusedSlice(
  slice: PartitionSlice,
  focusedValue: { dimensionIndex: number; value: string } | undefined,
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
