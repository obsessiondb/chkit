import { splitSortKeyRange } from './splitter.js'
import type { ChunkBoundary, PartitionInfo, SortKeyInfo } from './types.js'

export function buildChunkBoundaries(input: {
  partitions: PartitionInfo[]
  maxChunkBytes: number
  sortKey?: SortKeyInfo
  sortKeyRanges?: Map<string, { min: string; max: string }>
}): ChunkBoundary[] {
  const boundaries: ChunkBoundary[] = []

  for (const partition of input.partitions) {
    if (partition.bytesOnDisk <= input.maxChunkBytes) {
      boundaries.push({
        partitionId: partition.partitionId,
        estimatedBytes: partition.bytesOnDisk,
      })
    } else if (input.sortKey && input.sortKeyRanges) {
      const range = input.sortKeyRanges.get(partition.partitionId)
      if (!range) {
        // No range data — emit as single chunk
        boundaries.push({
          partitionId: partition.partitionId,
          estimatedBytes: partition.bytesOnDisk,
        })
        continue
      }

      // If min === max, splitting would produce empty sub-ranges; emit as single chunk
      if (range.min === range.max) {
        boundaries.push({
          partitionId: partition.partitionId,
          estimatedBytes: partition.bytesOnDisk,
        })
        continue
      }

      const subCount = Math.ceil(partition.bytesOnDisk / input.maxChunkBytes)
      const subRanges = splitSortKeyRange(input.sortKey.category, range.min, range.max, subCount)
      const estimatedBytesPerSub = Math.ceil(partition.bytesOnDisk / subCount)

      for (const sub of subRanges) {
        boundaries.push({
          partitionId: partition.partitionId,
          sortKeyFrom: sub.from,
          sortKeyTo: sub.to,
          estimatedBytes: estimatedBytesPerSub,
        })
      }
    } else {
      // No sort key info — emit as single chunk despite being oversized
      boundaries.push({
        partitionId: partition.partitionId,
        estimatedBytes: partition.bytesOnDisk,
      })
    }
  }

  return boundaries
}
