import { buildSliceFromRows, getTargetChunkRows } from '../partition-slices.js'
import { probeTemporalDistribution } from '../services/distribution-source.js'
import { parsePlannerDateTime } from '../services/row-probe.js'
import type {
  Partition,
  PartitionSlice,
  PlannerContext,
  SortKey,
  TemporalBucket,
} from '../types.js'
import { getChunkRange, replaceChunkRange } from '../utils/ranges.js'

const TARGET_BYTES_FUZZ_FACTOR = 1.15

export async function splitSliceWithTemporalBuckets(
  context: PlannerContext,
  partition: Partition,
  slice: PartitionSlice,
  sortKeys: SortKey[],
  dimensionIndex: number,
): Promise<PartitionSlice[]> {
  const dayBuckets = await probeTemporalDistribution(
    context,
    partition.partitionId,
    slice.ranges,
    sortKeys,
    dimensionIndex,
    'day'
  )
  if (dayBuckets.length === 0) return [slice]

  const daySlices = buildTemporalSlices(partition, slice, dimensionIndex, dayBuckets, context.targetChunkBytes)
  if (daySlices.every((candidate) => candidate.estimate.bytesUncompressed <= context.targetChunkBytes * TARGET_BYTES_FUZZ_FACTOR)) {
    return daySlices
  }

  const hourBuckets = await probeTemporalDistribution(
    context,
    partition.partitionId,
    slice.ranges,
    sortKeys,
    dimensionIndex,
    'hour'
  )
  if (hourBuckets.length === 0) return daySlices

  return buildTemporalSlices(partition, slice, dimensionIndex, hourBuckets, context.targetChunkBytes)
}

function getPartitionEndExclusive(partition: Partition): string {
  return new Date(parsePlannerDateTime(partition.maxTime) + 1000).toISOString()
}

function buildTemporalSlices(
  partition: Partition,
  parentSlice: PartitionSlice,
  dimensionIndex: number,
  buckets: TemporalBucket[],
  targetChunkBytes: number,
): PartitionSlice[] {
  const targetChunkRows = getTargetChunkRows(partition, targetChunkBytes)
  const slices: PartitionSlice[] = []
  let currentStart: string | undefined
  let currentRows = 0
  const parentRange = getChunkRange(parentSlice, dimensionIndex)
  const sliceStart = parentRange.from
  const sliceEnd = parentRange.to ?? getPartitionEndExclusive(partition)

  for (let index = 0; index < buckets.length; index++) {
    const bucket = buckets[index]
    if (!bucket) continue

    const bucketStart = sliceStart && bucket.start < sliceStart ? sliceStart : bucket.start
    if (currentStart === undefined) {
      currentStart = bucketStart
    }

    const wouldExceed = currentRows > 0 && currentRows + bucket.rowCount > targetChunkRows * TARGET_BYTES_FUZZ_FACTOR
    if (wouldExceed && currentStart !== undefined && currentStart < bucketStart) {
      slices.push(buildSlice(parentSlice, partition, dimensionIndex, currentStart, bucketStart, currentRows))
      currentStart = bucketStart
      currentRows = 0
    }

    currentRows += bucket.rowCount

    if (index === buckets.length - 1 && currentStart !== undefined && currentStart < sliceEnd) {
      slices.push(buildSlice(parentSlice, partition, dimensionIndex, currentStart, sliceEnd, currentRows))
    }
  }

  return slices.length > 0 ? slices : [parentSlice]
}

function buildSlice(
  parentSlice: PartitionSlice,
  partition: Partition,
  dimensionIndex: number,
  from: string,
  to: string,
  rows: number,
): PartitionSlice {
  return buildSliceFromRows(partition, {
    ranges: replaceChunkRange(parentSlice, dimensionIndex, from, to),
    rows,
    focusedValue: parentSlice.analysis.focusedValue,
    confidence: 'low',
    reason: 'temporal-distribution',
    lineage: parentSlice.analysis.lineage.concat([
      {
        strategyId: 'temporal-bucket-split',
        dimensionIndex,
        reason: 'split slice using temporal distribution buckets',
      },
    ]),
  })
}
