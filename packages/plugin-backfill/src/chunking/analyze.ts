import { hashId, randomPlanId } from '../state.js'

import { introspectTable } from './introspect.js'
import type {
  ChunkBoundary,
  EstimateConfidence,
  EstimateReason,
  PartitionDiagnostics,
  PartitionInfo,
  PlannedChunk,
  SliceLineageStep,
  SliceRange,
  SortKeyInfo,
} from './types.js'

const MAX_SPLIT_DEPTH_MULTIPLIER = 3
const TARGET_BYTES_FUZZ_FACTOR = 1.15
const STOP_SPLIT_FUZZ_FACTOR = 1.5
const STRING_PREFIX_START_DEPTH = 1
const STRING_PREFIX_MAX_DEPTH = 4
const BINARY_SEARCH_STEPS = 24

interface PartitionSlice {
  partitionId: string
  ranges: SliceRange[]
  estimatedRows: number
  estimatedBytes: number
  isHotKey: boolean
  hotDimensionIndex?: number
  hotKeyValue?: string
  estimateConfidence: EstimateConfidence
  estimateReason: EstimateReason
  lineage: SliceLineageStep[]
}

interface QueryContext {
  database: string
  table: string
  sortKeys: SortKeyInfo[]
  query: <T>(sql: string) => Promise<T[]>
}

export interface AnalyzeAndChunkInput {
  database: string
  table: string
  from?: string
  to?: string
  maxChunkBytes: number
  requireIdempotencyToken: boolean
  query: <T>(sql: string) => Promise<T[]>
}

export interface AnalyzeAndChunkResult {
  planId: string
  partitions: PartitionInfo[]
  sortKey?: SortKeyInfo
  sortKeys: SortKeyInfo[]
  chunks: PlannedChunk[]
  partitionDiagnostics: PartitionDiagnostics[]
}

export async function analyzeAndChunk(input: AnalyzeAndChunkInput): Promise<AnalyzeAndChunkResult> {
  const { partitions, sortKey, sortKeys, boundaries, partitionDiagnostics } = await analyzeTable({
    database: input.database,
    table: input.table,
    from: input.from,
    to: input.to,
    maxChunkBytes: input.maxChunkBytes,
    query: input.query,
  })

  const planId = randomPlanId()

  const chunks = buildPlannedChunks({
    planId,
    partitions,
    sortKeys,
    boundaries,
    requireIdempotencyToken: input.requireIdempotencyToken,
  })

  return { planId, partitions, sortKey, sortKeys, chunks, partitionDiagnostics }
}

export interface AnalyzeTableInput {
  database: string
  table: string
  from?: string
  to?: string
  maxChunkBytes: number
  query: <T>(sql: string) => Promise<T[]>
}

export interface AnalyzeTableResult {
  partitions: PartitionInfo[]
  sortKey?: SortKeyInfo
  sortKeys: SortKeyInfo[]
  boundaries: ChunkBoundary[]
  partitionDiagnostics: PartitionDiagnostics[]
}

export async function analyzeTable(input: AnalyzeTableInput): Promise<AnalyzeTableResult> {
  const { partitions, sortKey, sortKeys } = await introspectTable({
    database: input.database,
    table: input.table,
    from: input.from,
    to: input.to,
    query: input.query,
  })

  const context: QueryContext = {
    database: input.database,
    table: input.table,
    sortKeys,
    query: input.query,
  }

  const boundaries: ChunkBoundary[] = []
  const partitionDiagnostics: PartitionDiagnostics[] = []

  for (const partition of partitions) {
    const slices = await planPartition(context, partition, input.maxChunkBytes)
    const merged = mergeAdjacentSlices(slices, input.maxChunkBytes)

    for (const slice of merged) {
      const primaryRange = getSliceRange(slice, 0)
      boundaries.push({
        partitionId: slice.partitionId,
        ranges: slice.ranges,
        sortKeyFrom: primaryRange.from,
        sortKeyTo: primaryRange.to,
        estimatedBytes: slice.estimatedBytes,
        estimatedRows: slice.estimatedRows,
        isHotKey: slice.isHotKey,
        hotDimensionIndex: slice.hotDimensionIndex,
        hotKeyValue: slice.hotKeyValue,
        estimateConfidence: slice.estimateConfidence,
        estimateReason: slice.estimateReason,
        lineage: slice.lineage,
      })
    }

    const estimatedRowSum = merged.reduce((sum, slice) => sum + slice.estimatedRows, 0)
    const estimateToExactRatio = partition.rows > 0 ? estimatedRowSum / partition.rows : 1
    partitionDiagnostics.push({
      partitionId: partition.partitionId,
      estimatedRowSum,
      exactPartitionRows: partition.rows,
      estimateToExactRatio,
      suspiciousEstimate: estimateToExactRatio < 0.7 || estimateToExactRatio > 1.3,
      lowConfidenceChunkCount: merged.filter((slice) => slice.estimateConfidence === 'low').length,
      usedDistributionFallback: merged.some((slice) =>
        slice.estimateReason === 'string-prefix-distribution' ||
        slice.estimateReason === 'temporal-distribution' ||
        slice.estimateReason === 'equal-width-distribution'
      ),
      usedLowConfidenceChunkRefinement: false,
      usedExactCountFallback: false,
    })
  }

  return { partitions, sortKey, sortKeys, boundaries, partitionDiagnostics }
}

export function buildPlannedChunks(input: {
  planId: string
  partitions: PartitionInfo[]
  sortKeys: SortKeyInfo[]
  boundaries: ChunkBoundary[]
  requireIdempotencyToken: boolean
}): PlannedChunk[] {
  const chunks: PlannedChunk[] = []
  const partitionIndex = new Map<string, number>()

  for (const boundary of input.boundaries) {
    const idx = partitionIndex.get(boundary.partitionId) ?? 0
    partitionIndex.set(boundary.partitionId, idx + 1)

    const idSeed = `${input.planId}:${boundary.partitionId}:${idx}`
    const chunkId = hashId(`chunk:${idSeed}`).slice(0, 16)
    const token = input.requireIdempotencyToken ? hashId(`token:${idSeed}`) : ''

    const partition = input.partitions.find((candidate) => candidate.partitionId === boundary.partitionId)
    const { from, to } = deriveChunkWindow(boundary.ranges ?? [], input.sortKeys, partition)

    chunks.push({
      id: chunkId,
      partitionId: boundary.partitionId,
      ranges: boundary.ranges,
      sortKeyFrom: boundary.sortKeyFrom,
      sortKeyTo: boundary.sortKeyTo,
      estimatedBytes: boundary.estimatedBytes,
      estimatedRows: boundary.estimatedRows,
      idempotencyToken: token,
      from,
      to,
      isHotKey: boundary.isHotKey,
      hotDimensionIndex: boundary.hotDimensionIndex,
      hotKeyValue: boundary.hotKeyValue,
      estimateConfidence: boundary.estimateConfidence,
      estimateReason: boundary.estimateReason,
      lineage: boundary.lineage,
    })
  }

  return chunks
}

async function planPartition(
  context: QueryContext,
  partition: PartitionInfo,
  maxChunkBytes: number,
): Promise<PartitionSlice[]> {
  if (partition.bytesOnDisk <= maxChunkBytes || context.sortKeys.length === 0) {
    return [buildRootSlice(partition)]
  }

  const rootSlice = buildRootSlice(partition)
  return splitSliceRecursively(context, partition, rootSlice, maxChunkBytes, 0)
}

async function splitSliceRecursively(
  context: QueryContext,
  partition: PartitionInfo,
  slice: PartitionSlice,
  maxChunkBytes: number,
  depth: number,
): Promise<PartitionSlice[]> {
  if (slice.estimatedBytes <= maxChunkBytes * STOP_SPLIT_FUZZ_FACTOR) {
    return [slice]
  }

  if (depth >= context.sortKeys.length * MAX_SPLIT_DEPTH_MULTIPLIER) {
    return [slice]
  }

  const children = await splitOversizedSlice(context, partition, slice, maxChunkBytes, depth)
  if (children.length <= 1) {
    return [slice]
  }

  const finalChildren: PartitionSlice[] = []
  for (const child of children) {
    finalChildren.push(...await splitSliceRecursively(context, partition, child, maxChunkBytes, depth + 1))
  }
  return finalChildren
}

async function splitOversizedSlice(
  context: QueryContext,
  partition: PartitionInfo,
  slice: PartitionSlice,
  maxChunkBytes: number,
  depth: number,
): Promise<PartitionSlice[]> {
  for (const dimensionIndex of getCandidateDimensions(context.sortKeys, slice)) {
    const preparedSlice = await hydrateSliceRange(context, slice, dimensionIndex)
    if (!preparedSlice) continue

    const sortKey = context.sortKeys[dimensionIndex]
    if (!sortKey) continue

    const rootLike = depth === 0
    const hotIdentity = findHotIdentity(preparedSlice, context.sortKeys)

    if (sortKey.category === 'string') {
      const stringSlices = await splitSliceWithStringPrefixes(
        context,
        partition,
        preparedSlice,
        dimensionIndex,
        maxChunkBytes,
        STRING_PREFIX_START_DEPTH,
      )
      if (isEffectiveSplit(preparedSlice, stringSlices)) {
        return applyHotIdentity(stringSlices, hotIdentity)
      }
    }

    if (sortKey.category === 'datetime' && (!rootLike || hotIdentity !== undefined)) {
      const temporalSlices = await splitSliceWithTemporalBuckets(
        context,
        partition,
        markHotSlice(preparedSlice, hotIdentity),
        dimensionIndex,
        maxChunkBytes,
      )
      if (isEffectiveSplit(preparedSlice, temporalSlices)) {
        return applyHotIdentity(temporalSlices, hotIdentity)
      }
    }

    const quantileSlices = await splitWithRanges(
      context,
      partition,
      preparedSlice,
      dimensionIndex,
      maxChunkBytes,
    )
    if (isEffectiveSplit(preparedSlice, quantileSlices)) {
      return applyHotIdentity(quantileSlices, hotIdentity)
    }
  }

  return [slice]
}

async function splitWithRanges(
  context: QueryContext,
  partition: PartitionInfo,
  slice: PartitionSlice,
  dimensionIndex: number,
  maxChunkBytes: number,
): Promise<PartitionSlice[]> {
  const sortKey = context.sortKeys[dimensionIndex]
  const range = getSliceRange(slice, dimensionIndex)
  if (!sortKey || range.from === undefined || range.to === undefined) return [slice]
  if (sortKey.category === 'string' && isExactSliceRange(range)) return [slice]

  const subCount = Math.ceil(slice.estimatedBytes / maxChunkBytes)
  if (subCount <= 1) return [slice]

  const boundaries = await buildQuantileBoundaries(context, slice, dimensionIndex, subCount)
  if (boundaries) {
    return splitSliceWithBoundaries(
      context,
      partition,
      slice,
      dimensionIndex,
      boundaries,
      'quantile-range-split',
      'split slice into quantile-aligned ranges',
      'quantile-estimate',
      'high',
    )
  }

  const equalWidthBoundaries = buildEvenlySpacedBoundaries(range.from, range.to, subCount, sortKey)
  return splitSliceWithBoundaries(
    context,
    partition,
    slice,
    dimensionIndex,
    equalWidthBoundaries,
    'equal-width-split',
    'fallback to equal-width ranges',
    'equal-width-distribution',
    'low',
  )
}

async function splitSliceWithBoundaries(
  context: QueryContext,
  partition: PartitionInfo,
  slice: PartitionSlice,
  dimensionIndex: number,
  boundaries: string[],
  strategyId: string,
  reason: string,
  estimateReason: EstimateReason,
  estimateConfidence: EstimateConfidence,
): Promise<PartitionSlice[]> {
  const slices: PartitionSlice[] = []

  for (let index = 0; index < boundaries.length - 1; index++) {
    const from = boundaries[index]
    const to = boundaries[index + 1]
    if (from === undefined || to === undefined || from === to) {
      continue
    }

    const ranges = replaceSliceRange(slice, dimensionIndex, from, to)
    const estimatedRows = await countRows(context, partition.partitionId, ranges)
    if (estimatedRows <= 0) {
      continue
    }

    slices.push(buildSliceFromRows(partition, {
      ranges,
      estimatedRows,
      isHotKey: false,
      hotDimensionIndex: undefined,
      hotKeyValue: undefined,
      estimateConfidence,
      estimateReason,
      lineage: slice.lineage.concat([{ strategyId, dimensionIndex, reason }]),
    }))
  }

  return slices
}

async function splitSliceWithStringPrefixes(
  context: QueryContext,
  partition: PartitionInfo,
  slice: PartitionSlice,
  dimensionIndex: number,
  maxChunkBytes: number,
  depth: number,
): Promise<PartitionSlice[]> {
  const sortKey = context.sortKeys[dimensionIndex]
  const range = getSliceRange(slice, dimensionIndex)
  if (!sortKey || sortKey.category !== 'string' || range.from === undefined || range.to === undefined) {
    return []
  }

  const rows = await context.query<{ prefix: string; cnt: string }>(`
SELECT
  substring(${sortKey.column}, 1, ${depth}) AS prefix,
  count() AS cnt
FROM ${context.database}.${context.table}
WHERE ${buildWhereClause(partition.partitionId, replaceSliceRange(slice, dimensionIndex, range.from, range.to), context.sortKeys)}
GROUP BY prefix
ORDER BY prefix`)

  const slices: PartitionSlice[] = []

  for (const row of rows) {
    const bucket = {
      value: row.prefix,
      rowCount: Number(row.cnt),
      isExactValue: Buffer.from(row.prefix, 'latin1').length < depth,
    }
    if (bucket.rowCount <= 0) continue

    const bucketFrom = maxBinaryString(range.from, bucket.value)
    const bucketUpper = bucket.isExactValue ? `${bucket.value}\0` : nextPrefixValue(bucket.value)
    if (!bucketUpper) continue

    const bucketTo = minBinaryString(range.to, bucketUpper)
    const bucketSlice = buildSliceFromRows(partition, {
      ranges: replaceSliceRange(slice, dimensionIndex, bucketFrom, bucketTo),
      estimatedRows: bucket.rowCount,
      isHotKey: false,
      hotDimensionIndex: undefined,
      hotKeyValue: undefined,
      estimateConfidence: 'high',
      estimateReason: 'string-prefix-distribution',
      lineage: slice.lineage.concat([{
        strategyId: 'string-prefix-split',
        dimensionIndex,
        reason: 'split slice using string prefix distribution',
      }]),
    })

    if (bucketSlice.estimatedBytes <= maxChunkBytes * TARGET_BYTES_FUZZ_FACTOR) {
      slices.push(bucketSlice)
      continue
    }

    if (!bucket.isExactValue && depth < STRING_PREFIX_MAX_DEPTH) {
      slices.push(...await splitSliceWithStringPrefixes(
        context,
        partition,
        bucketSlice,
        dimensionIndex,
        maxChunkBytes,
        depth + 1,
      ))
      continue
    }

    slices.push(bucketSlice)
  }

  return slices
}

async function splitSliceWithTemporalBuckets(
  context: QueryContext,
  partition: PartitionInfo,
  slice: PartitionSlice,
  dimensionIndex: number,
  maxChunkBytes: number,
): Promise<PartitionSlice[]> {
  const dayBuckets = await probeTemporalBuckets(context, partition.partitionId, slice.ranges, dimensionIndex, 'day')
  if (dayBuckets.length === 0) return [slice]

  const daySlices = buildTemporalSlices(partition, slice, dimensionIndex, dayBuckets, maxChunkBytes)
  if (daySlices.every((candidate) => candidate.estimatedBytes <= maxChunkBytes * TARGET_BYTES_FUZZ_FACTOR)) {
    return daySlices
  }

  const hourBuckets = await probeTemporalBuckets(context, partition.partitionId, slice.ranges, dimensionIndex, 'hour')
  if (hourBuckets.length === 0) return daySlices
  return buildTemporalSlices(partition, slice, dimensionIndex, hourBuckets, maxChunkBytes)
}

async function probeTemporalBuckets(
  context: QueryContext,
  partitionId: string,
  ranges: SliceRange[],
  dimensionIndex: number,
  grain: 'day' | 'hour',
): Promise<Array<{ start: string; rowCount: number }>> {
  const sortKey = context.sortKeys[dimensionIndex]
  if (!sortKey || sortKey.category !== 'datetime') return []

  const bucketExpression = grain === 'day'
    ? `toStartOfDay(${sortKey.column})`
    : `toStartOfHour(${sortKey.column})`

  const rows = await context.query<{ bucket: string; cnt: string }>(`
SELECT
  formatDateTime(${bucketExpression}, '%Y-%m-%dT%H:%i:%sZ') AS bucket,
  count() AS cnt
FROM ${context.database}.${context.table}
WHERE ${buildWhereClause(partitionId, ranges, context.sortKeys)}
GROUP BY bucket
ORDER BY bucket`)

  return rows.map((row) => ({
    start: row.bucket,
    rowCount: Number(row.cnt),
  }))
}

function buildTemporalSlices(
  partition: PartitionInfo,
  parentSlice: PartitionSlice,
  dimensionIndex: number,
  buckets: Array<{ start: string; rowCount: number }>,
  maxChunkBytes: number,
): PartitionSlice[] {
  const targetChunkRows = getTargetChunkRows(partition, maxChunkBytes)
  const slices: PartitionSlice[] = []
  let currentStart: string | undefined
  let currentRows = 0
  const parentRange = getSliceRange(parentSlice, dimensionIndex)
  const sliceEnd = parentRange.to ?? getPartitionEndExclusive(partition)

  for (let index = 0; index < buckets.length; index++) {
    const bucket = buckets[index]
    if (!bucket) continue

    if (currentStart === undefined) currentStart = bucket.start

    const wouldExceed = currentRows > 0 && currentRows + bucket.rowCount > targetChunkRows * TARGET_BYTES_FUZZ_FACTOR
    if (wouldExceed && currentStart !== undefined) {
      slices.push(buildSliceFromRows(partition, {
        ranges: replaceSliceRange(parentSlice, dimensionIndex, currentStart, bucket.start),
        estimatedRows: currentRows,
        isHotKey: parentSlice.isHotKey,
        hotDimensionIndex: parentSlice.hotDimensionIndex,
        hotKeyValue: parentSlice.hotKeyValue,
        estimateConfidence: 'low',
        estimateReason: 'temporal-distribution',
        lineage: parentSlice.lineage.concat([{
          strategyId: 'temporal-bucket-split',
          dimensionIndex,
          reason: 'split slice using temporal distribution buckets',
        }]),
      }))
      currentStart = bucket.start
      currentRows = 0
    }

    currentRows += bucket.rowCount

    if (index === buckets.length - 1 && currentStart !== undefined) {
      slices.push(buildSliceFromRows(partition, {
        ranges: replaceSliceRange(parentSlice, dimensionIndex, currentStart, sliceEnd),
        estimatedRows: currentRows,
        isHotKey: parentSlice.isHotKey,
        hotDimensionIndex: parentSlice.hotDimensionIndex,
        hotKeyValue: parentSlice.hotKeyValue,
        estimateConfidence: 'low',
        estimateReason: 'temporal-distribution',
        lineage: parentSlice.lineage.concat([{
          strategyId: 'temporal-bucket-split',
          dimensionIndex,
          reason: 'split slice using temporal distribution buckets',
        }]),
      }))
    }
  }

  return slices
}

async function buildQuantileBoundaries(
  context: QueryContext,
  slice: PartitionSlice,
  dimensionIndex: number,
  subCount: number,
): Promise<string[] | undefined> {
  const range = getSliceRange(slice, dimensionIndex)
  if (range.from === undefined || range.to === undefined) return undefined

  const boundaries = [range.from]
  for (let step = 1; step < subCount; step++) {
    const targetCumRows = Math.round((slice.estimatedRows * step) / subCount)
    boundaries.push(await findQuantileBoundaryOnDimension(context, slice, dimensionIndex, targetCumRows))
  }

  const uniqueBoundaryCount = new Set(boundaries).size
  if (uniqueBoundaryCount <= Math.max(2, Math.ceil(subCount / 3))) {
    return undefined
  }

  return boundaries.concat([range.to])
}

async function findQuantileBoundaryOnDimension(
  context: QueryContext,
  slice: PartitionSlice,
  dimensionIndex: number,
  targetCumRows: number,
): Promise<string> {
  const sortKey = context.sortKeys[dimensionIndex]
  const range = getSliceRange(slice, dimensionIndex)
  if (!sortKey || range.from === undefined || range.to === undefined) {
    throw new Error(`Missing range for quantile split on dimension ${dimensionIndex}`)
  }

  if (sortKey.category === 'string') {
    let low = strToBigInt(range.from, 8)
    let high = strToBigInt(range.to, 8)

    for (let step = 0; step < BINARY_SEARCH_STEPS; step++) {
      const midpoint = (low + high) / 2n
      if (midpoint === low || midpoint === high) break

      const mid = bigIntToStr(midpoint, 8)
      const rows = await countRows(context, slice.partitionId, replaceSliceRange(slice, dimensionIndex, range.from, mid))
      if (rows < targetCumRows) low = midpoint
      else high = midpoint
    }

    return bigIntToStr((low + high) / 2n, 8)
  }

  if (sortKey.category === 'datetime') {
    let low = parsePlannerDateTime(range.from)
    let high = parsePlannerDateTime(range.to)

    for (let step = 0; step < BINARY_SEARCH_STEPS; step++) {
      const midpoint = Math.floor((low + high) / 2)
      if (midpoint === low || midpoint === high) break

      const mid = new Date(midpoint).toISOString()
      const rows = await countRows(context, slice.partitionId, replaceSliceRange(slice, dimensionIndex, range.from, mid))
      if (rows < targetCumRows) low = midpoint
      else high = midpoint
    }

    return new Date(Math.floor((low + high) / 2)).toISOString()
  }

  let low = Number(range.from)
  let high = Number(range.to)
  for (let step = 0; step < BINARY_SEARCH_STEPS; step++) {
    const midpoint = Math.floor((low + high) / 2)
    if (midpoint === low || midpoint === high) break

    const rows = await countRows(context, slice.partitionId, replaceSliceRange(slice, dimensionIndex, range.from, String(midpoint)))
    if (rows < targetCumRows) low = midpoint
    else high = midpoint
  }

  return String(Math.floor((low + high) / 2))
}

async function hydrateSliceRange(
  context: QueryContext,
  slice: PartitionSlice,
  dimensionIndex: number,
): Promise<PartitionSlice | undefined> {
  const currentRange = getSliceRange(slice, dimensionIndex)
  if (currentRange.from !== undefined && currentRange.to !== undefined) return slice

  const sortKey = context.sortKeys[dimensionIndex]
  if (!sortKey) return undefined

  const rows = await context.query<{ minVal: string; maxVal: string }>(`
SELECT
  toString(min(${sortKey.column})) AS minVal,
  toString(max(${sortKey.column})) AS maxVal
FROM ${context.database}.${context.table}
WHERE ${buildWhereClause(slice.partitionId, slice.ranges, context.sortKeys)}`)

  const observed = rows[0]
  if (!observed) return undefined

  return {
    ...slice,
    ranges: replaceSliceRange(slice, dimensionIndex, observed.minVal, toExclusiveUpperBound(observed.maxVal, sortKey)),
  }
}

function buildRootSlice(partition: PartitionInfo): PartitionSlice {
  return {
    partitionId: partition.partitionId,
    ranges: [],
    estimatedRows: partition.rows,
    estimatedBytes: partition.bytesOnDisk,
    isHotKey: false,
    estimateConfidence: 'high',
    estimateReason: 'partition-metadata',
    lineage: [],
  }
}

function buildSliceFromRows(
  partition: PartitionInfo,
  input: {
    ranges: SliceRange[]
    estimatedRows: number
    isHotKey: boolean
    hotDimensionIndex?: number
    hotKeyValue?: string
    estimateConfidence: EstimateConfidence
    estimateReason: EstimateReason
    lineage: SliceLineageStep[]
  },
): PartitionSlice {
  return {
    partitionId: partition.partitionId,
    ranges: input.ranges,
    estimatedRows: input.estimatedRows,
    estimatedBytes: partition.rows > 0
      ? Math.round((input.estimatedRows / partition.rows) * partition.bytesOnDisk)
      : 0,
    isHotKey: input.isHotKey,
    hotDimensionIndex: input.hotDimensionIndex,
    hotKeyValue: input.hotKeyValue,
    estimateConfidence: input.estimateConfidence,
    estimateReason: input.estimateReason,
    lineage: input.lineage,
  }
}

function getTargetChunkRows(partition: PartitionInfo, maxChunkBytes: number): number {
  if (partition.bytesOnDisk <= 0) return partition.rows
  return (maxChunkBytes * partition.rows) / partition.bytesOnDisk
}

function mergeAdjacentSlices(slices: PartitionSlice[], maxChunkBytes: number): PartitionSlice[] {
  if (slices.length <= 1) return slices

  const merged: PartitionSlice[] = []
  let current: PartitionSlice | undefined

  for (const slice of slices) {
    if (!current) {
      current = slice
      continue
    }

    const canMerge =
      !current.isHotKey &&
      !slice.isHotKey &&
      haveSameTrailingRanges(current.ranges, slice.ranges) &&
      current.estimatedBytes + slice.estimatedBytes <= maxChunkBytes * 1.1

    if (!canMerge) {
      merged.push(current)
      current = slice
      continue
    }

    current = {
      ...current,
      ranges: mergeRanges(current.ranges, slice.ranges),
      estimatedRows: current.estimatedRows + slice.estimatedRows,
      estimatedBytes: current.estimatedBytes + slice.estimatedBytes,
    }
  }

  if (current) merged.push(current)
  return merged
}

function mergeRanges(left: SliceRange[], right: SliceRange[]): SliceRange[] {
  return left.map((leftRange) => {
    const rightRange = right.find((candidate) => candidate.dimensionIndex === leftRange.dimensionIndex)
    return rightRange === undefined
      ? leftRange
      : {
        dimensionIndex: leftRange.dimensionIndex,
        from: leftRange.from,
        to: rightRange.to,
      }
  })
}

function haveSameTrailingRanges(left: SliceRange[], right: SliceRange[]): boolean {
  if (left.length !== right.length) return false

  let differingDimensions = 0
  for (const leftRange of left) {
    const rightRange = right.find((candidate) => candidate.dimensionIndex === leftRange.dimensionIndex)
    if (!rightRange) return false

    const same = leftRange.from === rightRange.from && leftRange.to === rightRange.to
    if (!same) {
      differingDimensions += 1
      if (leftRange.to !== rightRange.from) return false
    }
  }

  return differingDimensions <= 1
}

function getCandidateDimensions(sortKeys: SortKeyInfo[], slice: PartitionSlice): number[] {
  return sortKeys
    .map((sortKey, index) => ({
      index,
      priority: getDimensionPriority(sortKey.category, slice.isHotKey, slice.hotDimensionIndex, index),
    }))
    .sort((left, right) => left.priority - right.priority)
    .map((candidate) => candidate.index)
}

function getDimensionPriority(
  category: SortKeyInfo['category'],
  isHotKey: boolean,
  hotDimensionIndex: number | undefined,
  dimensionIndex: number,
): number {
  if (isHotKey && hotDimensionIndex === dimensionIndex) return 100
  if (category === 'string') return 0
  if (category === 'datetime') return 1
  return 2
}

function getSliceRange(slice: Pick<PartitionSlice, 'ranges'>, dimensionIndex: number): SliceRange {
  return slice.ranges.find((range) => range.dimensionIndex === dimensionIndex)
    ?? { dimensionIndex, from: undefined, to: undefined }
}

function replaceSliceRange(
  slice: Pick<PartitionSlice, 'ranges'>,
  dimensionIndex: number,
  from: string | undefined,
  to: string | undefined,
): SliceRange[] {
  return slice.ranges
    .filter((range) => range.dimensionIndex !== dimensionIndex)
    .concat([{ dimensionIndex, from, to }])
    .sort((left, right) => left.dimensionIndex - right.dimensionIndex)
}

function isExactSliceRange(range: Pick<SliceRange, 'from' | 'to'>): boolean {
  if (range.from === undefined || range.to === undefined) return false
  return range.to === `${range.from}\0`
}

function findHotIdentity(
  slice: PartitionSlice,
  sortKeys: SortKeyInfo[],
): { dimensionIndex: number; value: string } | undefined {
  for (const range of slice.ranges) {
    const sortKey = sortKeys[range.dimensionIndex]
    if (sortKey?.category !== 'string') continue
    if (isExactSliceRange(range) && range.from !== undefined) {
      return { dimensionIndex: range.dimensionIndex, value: range.from }
    }
  }
}

function applyHotIdentity(
  slices: PartitionSlice[],
  hotIdentity: { dimensionIndex: number; value: string } | undefined,
): PartitionSlice[] {
  if (!hotIdentity) return slices
  return slices.map((slice) => markHotSlice(slice, hotIdentity))
}

function markHotSlice(
  slice: PartitionSlice,
  hotIdentity: { dimensionIndex: number; value: string } | undefined,
): PartitionSlice {
  if (!hotIdentity) return slice
  return {
    ...slice,
    isHotKey: true,
    hotDimensionIndex: hotIdentity.dimensionIndex,
    hotKeyValue: hotIdentity.value,
  }
}

function isEffectiveSplit(parent: PartitionSlice, children: PartitionSlice[]): boolean {
  if (children.length <= 1) return false
  return children.some((child) =>
    child.estimatedRows !== parent.estimatedRows ||
    JSON.stringify(child.ranges) !== JSON.stringify(parent.ranges)
  )
}

function toExclusiveUpperBound(value: string, sortKey: SortKeyInfo): string {
  if (sortKey.category === 'string') return `${value}\0`
  if (sortKey.category === 'datetime') return new Date(parsePlannerDateTime(value) + 1000).toISOString()
  return String(Number(value) + 1)
}

function getPartitionEndExclusive(partition: PartitionInfo): string {
  return new Date(parsePlannerDateTime(partition.maxTime) + 1000).toISOString()
}

function deriveChunkWindow(
  ranges: SliceRange[],
  sortKeys: SortKeyInfo[],
  partition: PartitionInfo | undefined,
): { from: string; to: string } {
  for (const range of ranges) {
    const sortKey = sortKeys[range.dimensionIndex]
    if (sortKey?.category !== 'datetime') continue
    return {
      from: range.from ?? partition?.minTime ?? '',
      to: range.to ?? partition?.maxTime ?? '',
    }
  }

  return {
    from: partition?.minTime ?? '',
    to: partition?.maxTime ?? '',
  }
}

async function countRows(context: QueryContext, partitionId: string, ranges: SliceRange[]): Promise<number> {
  const rows = await context.query<{ cnt: string }>(`
SELECT count() AS cnt
FROM ${context.database}.${context.table}
WHERE ${buildWhereClause(partitionId, ranges, context.sortKeys)}`)
  return Number(rows[0]?.cnt ?? 0)
}

function buildWhereClause(partitionId: string, ranges: SliceRange[], sortKeys: SortKeyInfo[]): string {
  const conditions = [`_partition_id = ${quoteSqlString(partitionId)}`]

  for (const range of ranges) {
    const sortKey = sortKeys[range.dimensionIndex]
    if (!sortKey) continue
    if (range.from !== undefined) conditions.push(`${sortKey.column} >= ${formatBound(range.from, sortKey)}`)
    if (range.to !== undefined) conditions.push(`${sortKey.column} < ${formatBound(range.to, sortKey)}`)
  }

  return conditions.join('\n  AND ')
}

function quoteSqlString(value: string): string {
  return `'${value.replaceAll('\\', '\\\\').replaceAll('\'', '\\\'')}'`
}

function formatBound(value: string, sortKey: SortKeyInfo): string {
  if (sortKey.category === 'datetime') {
    return `parseDateTimeBestEffort(${quoteSqlString(value)})`
  }
  if (sortKey.category === 'string') {
    return `unhex('${Buffer.from(value, 'latin1').toString('hex')}')`
  }
  return value
}

function buildEvenlySpacedBoundaries(
  from: string,
  to: string,
  subCount: number,
  sortKey: SortKeyInfo,
): string[] {
  if (sortKey.category === 'datetime') {
    const start = parsePlannerDateTime(from)
    const end = parsePlannerDateTime(to)
    return uniqueBoundaries(Array.from({ length: subCount + 1 }, (_, index) =>
      new Date(start + Math.floor(((end - start) * index) / subCount)).toISOString()
    ))
  }

  if (sortKey.category === 'numeric') {
    const start = Number(from)
    const end = Number(to)
    return uniqueBoundaries(Array.from({ length: subCount + 1 }, (_, index) =>
      String(start + Math.floor(((end - start) * index) / subCount))
    ))
  }

  const start = strToBigInt(from, 8)
  const end = strToBigInt(to, 8)
  return uniqueBoundaries(Array.from({ length: subCount + 1 }, (_, index) =>
    bigIntToStr(start + ((end - start) * BigInt(index)) / BigInt(subCount), 8)
  ))
}

function uniqueBoundaries(boundaries: string[]): string[] {
  const unique: string[] = []
  for (const boundary of boundaries) {
    if (unique[unique.length - 1] !== boundary) {
      unique.push(boundary)
    }
  }
  return unique
}

function parsePlannerDateTime(value: string): number {
  const normalized = value.includes('T') ? value : value.replace(' ', 'T')
  return Date.parse(normalized.endsWith('Z') ? normalized : `${normalized}Z`)
}

function strToBigInt(value: string, padTo: number): bigint {
  const buffer = Buffer.from(value, 'latin1')
  let result = 0n
  for (let index = 0; index < padTo; index++) {
    const byte = index < buffer.length ? (buffer[index] ?? 0) : 0
    result = (result << 8n) | BigInt(byte)
  }
  return result
}

function bigIntToStr(value: bigint, length: number): string {
  const buffer = Buffer.alloc(length)
  let remaining = value
  for (let index = length - 1; index >= 0; index--) {
    buffer[index] = Number(remaining & 0xffn)
    remaining >>= 8n
  }
  return buffer.toString('latin1')
}

function compareBinaryStrings(left: string, right: string): number {
  return Buffer.from(left, 'latin1').compare(Buffer.from(right, 'latin1'))
}

function minBinaryString(left: string, right: string): string {
  return compareBinaryStrings(left, right) <= 0 ? left : right
}

function maxBinaryString(left: string, right: string): string {
  return compareBinaryStrings(left, right) >= 0 ? left : right
}

function nextPrefixValue(prefix: string): string | undefined {
  if (prefix === '') return undefined

  const buffer = Buffer.from(prefix, 'latin1')
  for (let index = buffer.length - 1; index >= 0; index--) {
    const byte = buffer[index]
    if (byte === undefined) continue
    if (byte === 0xff) continue

    const next = Buffer.from(buffer.subarray(0, index + 1))
    next[index] = (next[index] ?? 0) + 1
    return next.toString('latin1')
  }

  return undefined
}
