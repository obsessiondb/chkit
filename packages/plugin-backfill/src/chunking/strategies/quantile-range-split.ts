import * as Effect from 'effect/Effect'
import { fromPromise } from '../../effect-runtime.js'
import { buildSliceFromRows } from '../partition-slices.js'
import { estimateRows, parsePlannerDateTime } from '../services/row-probe.js'
import type { Partition, PartitionSlice, PlannerContext, SortKey } from '../types.js'
import { bigIntToStr, strToBigInt } from '../utils/binary-string.js'
import { getChunkRange, replaceChunkRange } from '../utils/ranges.js'
const BINARY_SEARCH_STEPS = 24
const ESTIMATE_CONCURRENCY = 50
export function splitSliceWithQuantiles(
  context: PlannerContext,
  partition: Partition,
  slice: PartitionSlice,
  sortKeys: SortKey[],
  dimensionIndex: number,
  boundaries: string[],
): Effect.Effect<PartitionSlice[], unknown> {
  return Effect.gen(function* () {
    const intervals: Array<{
      from: string
      to: string
    }> = []
    for (let index = 0; index < boundaries.length - 1; index++) {
      const from = boundaries[index]
      const to = boundaries[index + 1]
      if (from === undefined || to === undefined || from === to) continue
      intervals.push({ from, to })
    }
    const results = yield* Effect.forEach(
      intervals,
      ({ from, to }) =>
        Effect.gen(function* () {
          const ranges = replaceChunkRange(slice, dimensionIndex, from, to)
          const rows = yield* fromPromise(() =>
            estimateRows(context, { partitionId: partition.partitionId, ranges }, sortKeys),
          )
          if (rows <= 0) return null
          return buildSliceFromRows(partition, {
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
        }),
      { concurrency: ESTIMATE_CONCURRENCY },
    )
    return results.filter((s): s is PartitionSlice => s !== null)
  })
}
export function findQuantileBoundaryOnDimension(
  context: PlannerContext,
  slice: PartitionSlice,
  sortKeys: SortKey[],
  dimensionIndex: number,
  targetCumRows: number,
): Effect.Effect<string, unknown> {
  return Effect.gen(function* () {
    const sortKey = sortKeys[dimensionIndex]
    if (!sortKey) {
      throw new Error(`Missing sort key at dimension ${dimensionIndex}`)
    }
    const range = getChunkRange(slice, dimensionIndex)
    if (range.from === undefined || range.to === undefined) {
      throw new Error(`Missing range for quantile split on dimension ${dimensionIndex}`)
    }
    if (sortKey.category === 'string') {
      return yield* findStringBoundary(context, slice, sortKeys, dimensionIndex, range.from, range.to, targetCumRows)
    }
    if (sortKey.category === 'datetime') {
      return yield* findDateTimeBoundary(context, slice, sortKeys, dimensionIndex, range.from, range.to, targetCumRows)
    }
    return yield* findNumericBoundary(context, slice, sortKeys, dimensionIndex, range.from, range.to, targetCumRows)
  })
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
      new Date(start + Math.floor(((end - start) * index) / subCount)).toISOString(),
    )
  }
  if (sortKey.category === 'numeric') {
    const start = Number(rangeFrom)
    const end = Number(rangeTo)
    return Array.from({ length: subCount + 1 }, (_, index) =>
      String(start + Math.floor(((end - start) * index) / subCount)),
    )
  }
  const width = Math.max(rangeFrom.length, rangeTo.length)
  const start = strToBigInt(rangeFrom, width)
  const end = strToBigInt(rangeTo, width)
  const boundaries = Array.from({ length: subCount + 1 }, (_, index) =>
    bigIntToStr(start + ((end - start) * BigInt(index)) / BigInt(subCount), width, width),
  )
  // Use original values at endpoints to avoid round-trip length changes
  boundaries[0] = rangeFrom
  boundaries[boundaries.length - 1] = rangeTo
  return boundaries
}
function findStringBoundary(
  context: PlannerContext,
  slice: PartitionSlice,
  sortKeys: SortKey[],
  dimensionIndex: number,
  rangeFrom: string,
  rangeTo: string,
  targetCumRows: number,
): Effect.Effect<string, unknown> {
  return Effect.gen(function* () {
    const width = Math.max(rangeFrom.length, rangeTo.length)
    let low = strToBigInt(rangeFrom, width)
    let high = strToBigInt(rangeTo, width)
    for (let step = 0; step < BINARY_SEARCH_STEPS; step++) {
      const midpoint = (low + high) / 2n
      if (midpoint === low || midpoint === high) break
      const mid = bigIntToStr(midpoint, width, width)
      const rows = yield* estimateRowsUntil(context, slice, sortKeys, dimensionIndex, rangeFrom, mid)
      if (rows < targetCumRows) low = midpoint
      else high = midpoint
    }
    return bigIntToStr((low + high) / 2n, width, width)
  })
}
function findDateTimeBoundary(
  context: PlannerContext,
  slice: PartitionSlice,
  sortKeys: SortKey[],
  dimensionIndex: number,
  rangeFrom: string,
  rangeTo: string,
  targetCumRows: number,
): Effect.Effect<string, unknown> {
  return Effect.gen(function* () {
    let low = parsePlannerDateTime(rangeFrom)
    let high = parsePlannerDateTime(rangeTo)
    for (let step = 0; step < BINARY_SEARCH_STEPS; step++) {
      const midpoint = Math.floor((low + high) / 2)
      if (midpoint === low || midpoint === high) break
      const mid = new Date(midpoint).toISOString()
      const rows = yield* estimateRowsUntil(context, slice, sortKeys, dimensionIndex, rangeFrom, mid)
      if (rows < targetCumRows) low = midpoint
      else high = midpoint
    }
    return new Date(Math.floor((low + high) / 2)).toISOString()
  })
}
function findNumericBoundary(
  context: PlannerContext,
  slice: PartitionSlice,
  sortKeys: SortKey[],
  dimensionIndex: number,
  rangeFrom: string,
  rangeTo: string,
  targetCumRows: number,
): Effect.Effect<string, unknown> {
  return Effect.gen(function* () {
    let low = Number(rangeFrom)
    let high = Number(rangeTo)
    for (let step = 0; step < BINARY_SEARCH_STEPS; step++) {
      const midpoint = Math.floor((low + high) / 2)
      if (midpoint === low || midpoint === high) break
      const rows = yield* estimateRowsUntil(context, slice, sortKeys, dimensionIndex, rangeFrom, String(midpoint))
      if (rows < targetCumRows) low = midpoint
      else high = midpoint
    }
    return String(Math.floor((low + high) / 2))
  })
}
function estimateRowsUntil(
  context: PlannerContext,
  slice: PartitionSlice,
  sortKeys: SortKey[],
  dimensionIndex: number,
  rangeFrom: string,
  rangeTo: string,
): Effect.Effect<number, unknown> {
  return Effect.gen(function* () {
    return yield* fromPromise(() =>
      estimateRows(
        context,
        {
          partitionId: slice.partitionId,
          ranges: replaceChunkRange(slice, dimensionIndex, rangeFrom, rangeTo),
        },
        sortKeys,
      ),
    )
  })
}
