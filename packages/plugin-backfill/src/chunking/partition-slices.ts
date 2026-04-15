import type {
  ChunkEstimate,
  EstimateConfidence,
  EstimateReason,
  Partition,
  PartitionSlice,
  ChunkDerivationStep,
  ChunkRange,
} from './types.js'

export function buildRootSlice(partition: Partition): PartitionSlice {
  return {
    partitionId: partition.partitionId,
    ranges: [],
    estimate: {
      rows: partition.rows,
      bytesCompressed: partition.bytesCompressed,
      bytesUncompressed: partition.bytesUncompressed,
      confidence: 'high',
      reason: 'partition-metadata',
    },
    analysis: {
      lineage: [],
    },
  }
}

export function buildSliceEstimate(
  partition: Partition,
  rows: number,
  confidence: EstimateConfidence,
  reason: EstimateReason,
): ChunkEstimate {
  const bytesCompressed = partition.rows > 0
    ? Math.round((rows / partition.rows) * partition.bytesCompressed)
    : 0
  const bytesUncompressed = partition.rows > 0
    ? Math.round((rows / partition.rows) * partition.bytesUncompressed)
    : 0

  return {
    rows,
    bytesCompressed,
    bytesUncompressed,
    confidence,
    reason,
  }
}

export function buildSliceFromRows(
  partition: Partition,
  input: {
    ranges: ChunkRange[]
    rows: number
    focusedValue?: PartitionSlice['analysis']['focusedValue']
    confidence: EstimateConfidence
    reason: EstimateReason
    lineage: ChunkDerivationStep[]
  },
): PartitionSlice {
  return {
    partitionId: partition.partitionId,
    ranges: input.ranges,
    estimate: buildSliceEstimate(partition, input.rows, input.confidence, input.reason),
    analysis: {
      focusedValue: input.focusedValue,
      lineage: input.lineage,
    },
  }
}

export function getTargetChunkRows(
  partition: Partition,
  targetChunkBytes: number,
): number {
  if (partition.bytesUncompressed <= 0) return partition.rows
  return (targetChunkBytes * partition.rows) / partition.bytesUncompressed
}

export function mergeAdjacentSlices(
  slices: PartitionSlice[],
  targetChunkBytes: number,
): PartitionSlice[] {
  if (slices.length <= 1) return slices

  const merged: PartitionSlice[] = []
  let current: PartitionSlice | undefined

  for (const slice of slices) {
    if (!current) {
      current = slice
      continue
    }

    const canMerge =
      !current.analysis.focusedValue &&
      !slice.analysis.focusedValue &&
      haveSameTrailingRanges(current.ranges, slice.ranges) &&
      current.estimate.bytesUncompressed + slice.estimate.bytesUncompressed <= targetChunkBytes * 1.1

    if (!canMerge) {
      merged.push(current)
      current = slice
      continue
    }

    current = {
      ...current,
      ranges: mergeRanges(current.ranges, slice.ranges),
      estimate: {
        ...current.estimate,
        rows: current.estimate.rows + slice.estimate.rows,
        bytesCompressed: current.estimate.bytesCompressed + slice.estimate.bytesCompressed,
        bytesUncompressed: current.estimate.bytesUncompressed + slice.estimate.bytesUncompressed,

      },
    }
  }

  if (current) merged.push(current)
  return merged
}

function mergeRanges(left: ChunkRange[], right: ChunkRange[]): ChunkRange[] {
  return left.map((leftRange) => {
    const rightRange = right.find((candidate) => candidate.dimensionIndex === leftRange.dimensionIndex)
    return rightRange === undefined
      ? leftRange
      : {
        dimensionIndex: leftRange.dimensionIndex,
        from: leftRange.from,
        to: rightRange.to,
      }
  })
}

function haveSameTrailingRanges(left: ChunkRange[], right: ChunkRange[]): boolean {
  if (left.length !== right.length) return false

  let differingDimensions = 0

  for (const leftRange of left) {
    const rightRange = right.find((candidate) => candidate.dimensionIndex === leftRange.dimensionIndex)
    if (!rightRange) return false

    const same = leftRange.from === rightRange.from && leftRange.to === rightRange.to
    if (!same) {
      differingDimensions += 1
      if (leftRange.to !== rightRange.from) return false
    }
  }

  return differingDimensions <= 1
}
