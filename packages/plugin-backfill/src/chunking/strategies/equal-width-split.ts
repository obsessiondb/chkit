import pMap from 'p-map'
import { buildSliceFromRows } from '../partition-slices.js'
import { estimateRows } from '../services/row-probe.js'
import type {
  Partition,
  PartitionSlice,
  PlannerContext,
  SortKey,
} from '../types.js'
import { replaceChunkRange } from '../utils/ranges.js'
import { buildEvenlySpacedBoundaries } from './quantile-range-split.js'

const DEFAULT_OVERSAMPLING_MULTIPLIER = 3
const ESTIMATE_CONCURRENCY = 50

export async function splitSliceWithEqualWidthRanges(
  context: PlannerContext,
  partition: Partition,
  slice: PartitionSlice,
  sortKeys: SortKey[],
  dimensionIndex: number,
  rangeFrom: string,
  rangeTo: string,
  subCount: number,
  oversamplingMultiplier: number = DEFAULT_OVERSAMPLING_MULTIPLIER,
): Promise<PartitionSlice[]> {
  const sortKey = sortKeys[dimensionIndex]
  if (!sortKey) return [slice]

  const boundaries = Array.from(
    new Set(buildEvenlySpacedBoundaries(rangeFrom, rangeTo, subCount * oversamplingMultiplier, sortKey))
  )
  if (boundaries.length <= 2) return [slice]

  const intervals: Array<{ from: string; to: string }> = []
  for (let index = 0; index < boundaries.length - 1; index++) {
    const from = boundaries[index]
    const to = boundaries[index + 1]
    if (from === undefined || to === undefined || from === to) continue
    intervals.push({ from, to })
  }

  const results = await pMap(
    intervals,
    async ({ from, to }) => {
      const ranges = replaceChunkRange(slice, dimensionIndex, from, to)
      const rows = await estimateRows(
        context,
        { partitionId: partition.partitionId, ranges },
        sortKeys,
      )
      if (rows <= 0) return null
      return buildSliceFromRows(partition, {
        ranges,
        rows,
        focusedValue: slice.analysis.focusedValue,
        confidence: context.rowProbeStrategy === 'count' ? 'exact' : 'low',
        reason: context.rowProbeStrategy === 'count' ? 'exact-count' : 'equal-width-distribution',
        lineage: slice.analysis.lineage.concat([
          {
            strategyId: 'equal-width-split',
            dimensionIndex,
            reason: 'fallback to equal-width ranges',
          },
        ]),
      })
    },
    { concurrency: ESTIMATE_CONCURRENCY },
  )

  const slices = results.filter((s): s is PartitionSlice => s !== null)
  return slices.length > 0 ? slices : [slice]
}
