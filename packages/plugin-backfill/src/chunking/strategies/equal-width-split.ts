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

export async function splitSliceWithEqualWidthRanges(
  context: PlannerContext,
  partition: Partition,
  slice: PartitionSlice,
  sortKeys: SortKey[],
  dimensionIndex: number,
  rangeFrom: string,
  rangeTo: string,
  subCount: number,
): Promise<PartitionSlice[]> {
  const sortKey = sortKeys[dimensionIndex]
  if (!sortKey) return [slice]

  const boundaries = Array.from(
    new Set(buildEvenlySpacedBoundaries(rangeFrom, rangeTo, subCount, sortKey))
  )
  if (boundaries.length <= 2) return [slice]

  const slices: PartitionSlice[] = []

  for (let index = 0; index < boundaries.length - 1; index++) {
    const from = boundaries[index]
    const to = boundaries[index + 1]
    if (from === undefined || to === undefined || from === to) continue

    const ranges = replaceChunkRange(slice, dimensionIndex, from, to)
    const rows = await estimateRows(
      context,
      {
        partitionId: partition.partitionId,
        ranges,
      },
      sortKeys
    )
    if (rows <= 0) continue

    slices.push(
      buildSliceFromRows(partition, {
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
    )
  }

  return slices.length > 0 ? slices : [slice]
}
