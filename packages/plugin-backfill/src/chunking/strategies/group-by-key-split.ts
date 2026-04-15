import { buildSliceFromRows } from '../partition-slices.js'
import {
  type StringKeyBucket,
  probeStringKeyDistribution,
} from '../services/distribution-source.js'
import type {
  Partition,
  PartitionSlice,
  PlannerContext,
  SortKey,
} from '../types.js'
import { compareBinaryStrings, maxBinaryString, minBinaryString } from '../utils/binary-string.js'
import { getChunkRange, replaceChunkRange } from '../utils/ranges.js'

const KEY_LIMIT = 100

export async function splitSliceWithGroupByKey(
  context: PlannerContext,
  partition: Partition,
  slice: PartitionSlice,
  sortKeys: SortKey[],
  dimensionIndex: number,
): Promise<PartitionSlice[] | undefined> {
  const sortKey = sortKeys[dimensionIndex]
  if (!sortKey || sortKey.category !== 'string') return undefined

  const range = getChunkRange(slice, dimensionIndex)
  if (range.from === undefined || range.to === undefined) return undefined

  const buckets = await probeStringKeyDistribution(
    context,
    slice.partitionId,
    slice.ranges,
    sortKey,
    dimensionIndex,
    sortKeys,
    KEY_LIMIT,
  )

  if (!buckets || buckets.length === 0) return undefined

  // Sort by value for range-ordered slice construction
  const sorted = [...buckets].sort((a, b) => compareBinaryStrings(a.value, b.value))

  return buildKeySlices(partition, slice, dimensionIndex, range.from, range.to, sorted)
}

function buildKeySlices(
  partition: Partition,
  parentSlice: PartitionSlice,
  dimensionIndex: number,
  rangeFrom: string,
  rangeTo: string,
  sortedBuckets: StringKeyBucket[],
): PartitionSlice[] {
  const slices: PartitionSlice[] = []
  let cursor = rangeFrom

  for (const bucket of sortedBuckets) {
    const keyFrom = bucket.value
    const keyTo = `${bucket.value}\0`

    // Gap slice before this key (non-hot residual between keys)
    const gapFrom = maxBinaryString(cursor, rangeFrom)
    const gapTo = minBinaryString(keyFrom, rangeTo)
    if (compareBinaryStrings(gapFrom, gapTo) < 0) {
      // There's a gap — but it has zero rows in our full distribution,
      // so we skip it (all rows are accounted for by the key buckets)
    }

    // Exact key slice
    const sliceFrom = maxBinaryString(keyFrom, rangeFrom)
    const sliceTo = minBinaryString(keyTo, rangeTo)
    if (compareBinaryStrings(sliceFrom, sliceTo) < 0) {
      slices.push(buildSliceFromRows(partition, {
        ranges: replaceChunkRange(parentSlice, dimensionIndex, sliceFrom, sliceTo),
        rows: bucket.rowCount,
        focusedValue: { dimensionIndex, value: bucket.value },
        confidence: 'high',
        reason: 'group-by-key-distribution',
        lineage: parentSlice.analysis.lineage.concat([{
          strategyId: 'group-by-key-split',
          dimensionIndex,
          reason: 'split slice using full GROUP BY key distribution',
        }]),
      }))
    }

    cursor = keyTo
  }

  return slices
}
