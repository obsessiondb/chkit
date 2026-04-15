import type { ChunkRange, PartitionSlice } from '../types.js'

export function getChunkRange(
  slice: Pick<PartitionSlice, 'ranges'>,
  dimensionIndex: number,
): ChunkRange {
  return (
    slice.ranges.find((range) => range.dimensionIndex === dimensionIndex) ?? {
      dimensionIndex,
      from: undefined,
      to: undefined,
    }
  )
}

export function replaceChunkRange(
  slice: Pick<PartitionSlice, 'ranges'>,
  dimensionIndex: number,
  from: string | undefined,
  to: string | undefined,
): ChunkRange[] {
  return slice.ranges
    .filter((range) => range.dimensionIndex !== dimensionIndex)
    .concat([{ dimensionIndex, from, to }])
    .sort((left, right) => left.dimensionIndex - right.dimensionIndex)
}

export function isExactChunkRange(range: Pick<ChunkRange, 'from' | 'to'>): boolean {
  if (range.from === undefined || range.to === undefined) return false
  return range.to === `${range.from}\0`
}
