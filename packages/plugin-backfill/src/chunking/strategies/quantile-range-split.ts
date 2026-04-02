import { buildSliceFromRows } from '../partition-slices.js'
import { estimateRows, parsePlannerDateTime } from '../services/row-probe.js'
import type {
  Partition,
  PartitionSlice,
  PlannerContext,
  SortKey,
} from '../types.js'
import { bigIntToStr, strToBigInt } from '../utils/binary-string.js'
import { getChunkRange, replaceChunkRange } from '../utils/ranges.js'

const BINARY_SEARCH_STEPS = 24

export async function splitSliceWithQuantiles(
  context: PlannerContext,
  partition: Partition,
  slice: PartitionSlice,
  sortKeys: SortKey[],
  dimensionIndex: number,
  boundaries: string[],
): Promise<PartitionSlice[]> {
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
        confidence: context.rowProbeStrategy === 'count' ? 'exact' : 'high',
        reason: context.rowProbeStrategy === 'count' ? 'exact-count' : 'quantile-estimate',
        lineage: slice.analysis.lineage.concat([
          {
            strategyId: 'quantile-range-split',
            dimensionIndex,
            reason: 'split slice into quantile-aligned ranges',
          },
        ]),
      })
    )
  }

  return slices
}

export async function findQuantileBoundaryOnDimension(
  context: PlannerContext,
  slice: PartitionSlice,
  sortKeys: SortKey[],
  dimensionIndex: number,
  targetCumRows: number,
): Promise<string> {
  const sortKey = sortKeys[dimensionIndex]
  if (!sortKey) {
    throw new Error(`Missing sort key at dimension ${dimensionIndex}`)
  }

  const range = getChunkRange(slice, dimensionIndex)
  if (range.from === undefined || range.to === undefined) {
    throw new Error(`Missing range for quantile split on dimension ${dimensionIndex}`)
  }

  if (sortKey.category === 'string') {
    return findStringBoundary(context, slice, sortKeys, dimensionIndex, range.from, range.to, targetCumRows)
  }
  if (sortKey.category === 'datetime') {
    return findDateTimeBoundary(context, slice, sortKeys, dimensionIndex, range.from, range.to, targetCumRows)
  }
  return findNumericBoundary(context, slice, sortKeys, dimensionIndex, range.from, range.to, targetCumRows)
}

export function buildEvenlySpacedBoundaries(
  rangeFrom: string,
  rangeTo: string,
  subCount: number,
  sortKey: SortKey,
): string[] {
  if (subCount <= 1) return [rangeFrom, rangeTo]

  if (sortKey.category === 'datetime') {
    const start = parsePlannerDateTime(rangeFrom)
    const end = parsePlannerDateTime(rangeTo)
    return Array.from({ length: subCount + 1 }, (_, index) =>
      new Date(start + Math.floor(((end - start) * index) / subCount)).toISOString()
    )
  }

  if (sortKey.category === 'numeric') {
    const start = Number(rangeFrom)
    const end = Number(rangeTo)
    return Array.from({ length: subCount + 1 }, (_, index) =>
      String(start + Math.floor(((end - start) * index) / subCount))
    )
  }

  const start = strToBigInt(rangeFrom, 8)
  const end = strToBigInt(rangeTo, 8)
  return Array.from({ length: subCount + 1 }, (_, index) =>
    bigIntToStr(start + ((end - start) * BigInt(index)) / BigInt(subCount), 8)
  )
}

async function findStringBoundary(
  context: PlannerContext,
  slice: PartitionSlice,
  sortKeys: SortKey[],
  dimensionIndex: number,
  rangeFrom: string,
  rangeTo: string,
  targetCumRows: number,
): Promise<string> {
  let low = strToBigInt(rangeFrom, 8)
  let high = strToBigInt(rangeTo, 8)

  for (let step = 0; step < BINARY_SEARCH_STEPS; step++) {
    const midpoint = (low + high) / 2n
    if (midpoint === low || midpoint === high) break

    const mid = bigIntToStr(midpoint, 8)
    const rows = await estimateRowsUntil(context, slice, sortKeys, dimensionIndex, rangeFrom, mid)
    if (rows < targetCumRows) low = midpoint
    else high = midpoint
  }

  return bigIntToStr((low + high) / 2n, 8)
}

async function findDateTimeBoundary(
  context: PlannerContext,
  slice: PartitionSlice,
  sortKeys: SortKey[],
  dimensionIndex: number,
  rangeFrom: string,
  rangeTo: string,
  targetCumRows: number,
): Promise<string> {
  let low = parsePlannerDateTime(rangeFrom)
  let high = parsePlannerDateTime(rangeTo)

  for (let step = 0; step < BINARY_SEARCH_STEPS; step++) {
    const midpoint = Math.floor((low + high) / 2)
    if (midpoint === low || midpoint === high) break

    const mid = new Date(midpoint).toISOString()
    const rows = await estimateRowsUntil(context, slice, sortKeys, dimensionIndex, rangeFrom, mid)
    if (rows < targetCumRows) low = midpoint
    else high = midpoint
  }

  return new Date(Math.floor((low + high) / 2)).toISOString()
}

async function findNumericBoundary(
  context: PlannerContext,
  slice: PartitionSlice,
  sortKeys: SortKey[],
  dimensionIndex: number,
  rangeFrom: string,
  rangeTo: string,
  targetCumRows: number,
): Promise<string> {
  let low = Number(rangeFrom)
  let high = Number(rangeTo)

  for (let step = 0; step < BINARY_SEARCH_STEPS; step++) {
    const midpoint = Math.floor((low + high) / 2)
    if (midpoint === low || midpoint === high) break

    const rows = await estimateRowsUntil(context, slice, sortKeys, dimensionIndex, rangeFrom, String(midpoint))
    if (rows < targetCumRows) low = midpoint
    else high = midpoint
  }

  return String(Math.floor((low + high) / 2))
}

async function estimateRowsUntil(
  context: PlannerContext,
  slice: PartitionSlice,
  sortKeys: SortKey[],
  dimensionIndex: number,
  rangeFrom: string,
  rangeTo: string,
): Promise<number> {
  return estimateRows(
    context,
    {
      partitionId: slice.partitionId,
      ranges: replaceChunkRange(slice, dimensionIndex, rangeFrom, rangeTo),
    },
    sortKeys
  )
}
