import type { PartitionSlice, SortKey } from './types.js'

export function getCandidateDimensions(
  sortKeys: SortKey[],
  _slice?: PartitionSlice,
): number[] {
  return sortKeys.map((_, index) => index)
}
