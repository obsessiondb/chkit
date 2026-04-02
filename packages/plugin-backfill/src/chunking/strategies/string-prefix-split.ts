import { buildSliceFromRows } from '../partition-slices.js'
import { probeStringPrefixDistribution } from '../services/distribution-source.js'
import type {
  Partition,
  PartitionSlice,
  PlannerContext,
  SortKey,
  StringPrefixBucket,
} from '../types.js'
import {
  buildObservedStringUpperBound,
  maxBinaryString,
  minBinaryString,
  nextPrefixValue,
} from '../utils/binary-string.js'
import { getChunkRange, replaceChunkRange } from '../utils/ranges.js'

const TARGET_BYTES_FUZZ_FACTOR = 1.15
const PREFIX_START_DEPTH = 1
const PREFIX_MAX_DEPTH = 4

export async function splitSliceWithStringPrefixes(
  context: PlannerContext,
  partition: Partition,
  slice: PartitionSlice,
  sortKeys: SortKey[],
  dimensionIndex: number,
): Promise<PartitionSlice[]> {
  const sortKey = sortKeys[dimensionIndex]
  if (!sortKey || sortKey.category !== 'string') return []

  const range = getChunkRange(slice, dimensionIndex)
  if (range.from === undefined || range.to === undefined) return []

  return buildPrefixSlices(
    context,
    partition,
    slice,
    sortKeys,
    dimensionIndex,
    range.from,
    range.to,
    PREFIX_START_DEPTH
  )
}

export function buildRootStringUpperBound(maxValue: string): string {
  return buildObservedStringUpperBound(maxValue)
}

async function buildPrefixSlices(
  context: PlannerContext,
  partition: Partition,
  slice: PartitionSlice,
  sortKeys: SortKey[],
  dimensionIndex: number,
  rangeFrom: string,
  rangeTo: string,
  depth: number,
): Promise<PartitionSlice[]> {
  const sortKey = sortKeys[dimensionIndex]
  if (!sortKey) return []

  const buckets = await probeStringPrefixDistribution(
    context,
    partition.partitionId,
    replaceChunkRange(slice, dimensionIndex, rangeFrom, rangeTo),
    sortKey,
    dimensionIndex,
    depth,
    sortKeys
  )

  const slices: PartitionSlice[] = []
  for (const bucket of buckets) {
    if (bucket.rowCount <= 0) continue

    const bucketSlice = buildBucketSlice(partition, slice, dimensionIndex, rangeFrom, rangeTo, bucket)
    if (!bucketSlice) continue

    if (bucketSlice.estimate.bytesCompressed <= context.targetChunkBytes * TARGET_BYTES_FUZZ_FACTOR) {
      slices.push(bucketSlice)
      continue
    }

    if (!bucket.isExactValue && depth < PREFIX_MAX_DEPTH) {
      const bucketRange = getChunkRange(bucketSlice, dimensionIndex)
      if (bucketRange.from !== undefined && bucketRange.to !== undefined) {
        slices.push(
          ...(await buildPrefixSlices(
            context,
            partition,
            slice,
            sortKeys,
            dimensionIndex,
            bucketRange.from,
            bucketRange.to,
            depth + 1
          ))
        )
        continue
      }
    }

    slices.push(bucketSlice)
  }

  return slices
}

function buildBucketSlice(
  partition: Partition,
  parentSlice: PartitionSlice,
  dimensionIndex: number,
  rangeFrom: string,
  rangeTo: string,
  bucket: StringPrefixBucket,
): PartitionSlice | undefined {
  const bucketFrom = maxBinaryString(rangeFrom, bucket.value)
  const bucketUpper = bucket.isExactValue ? `${bucket.value}\0` : nextPrefixValue(bucket.value)
  if (bucketUpper === undefined) return undefined

  const bucketTo = minBinaryString(rangeTo, bucketUpper)
  if (bucketFrom === bucketTo) return undefined

  const focusedValue = bucket.isExactValue
    ? { dimensionIndex, value: bucket.value }
    : parentSlice.analysis.focusedValue

  return buildSliceFromRows(partition, {
    ranges: replaceChunkRange(parentSlice, dimensionIndex, bucketFrom, bucketTo),
    rows: bucket.rowCount,
    focusedValue,
    confidence: 'high',
    reason: 'string-prefix-distribution',
    lineage: parentSlice.analysis.lineage.concat([
      {
        strategyId: 'string-prefix-split',
        dimensionIndex,
        reason: 'split slice using string prefix distribution',
      },
    ]),
  })
}
