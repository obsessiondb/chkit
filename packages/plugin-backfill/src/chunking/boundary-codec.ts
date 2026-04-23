import type {
  Chunk,
  ChunkPlan,
  ChunkRange,
  FocusedValue,
  SortKey,
} from './types.js'

function encodeBoundary(
  value: string | undefined,
  sortKey: SortKey | undefined,
): string | undefined {
  if (value === undefined || sortKey === undefined) return value
  if (sortKey.boundaryEncoding === 'hex-latin1') {
    return Buffer.from(value, 'latin1').toString('hex')
  }
  return value
}

function decodeBoundary(
  value: string | undefined,
  sortKey: SortKey | undefined,
): string | undefined {
  if (value === undefined || sortKey === undefined) return value
  if (sortKey.boundaryEncoding === 'hex-latin1') {
    return Buffer.from(value, 'hex').toString('latin1')
  }
  return value
}

function encodeRangesForPlan(
  ranges: ChunkRange[],
  sortKeys: SortKey[],
): ChunkRange[] {
  return ranges.map((range) => ({
    dimensionIndex: range.dimensionIndex,
    from: encodeBoundary(range.from, sortKeys[range.dimensionIndex]),
    to: encodeBoundary(range.to, sortKeys[range.dimensionIndex]),
  }))
}

function decodeRangesFromPlan(
  ranges: ChunkRange[],
  sortKeys: SortKey[],
): ChunkRange[] {
  return ranges.map((range) => ({
    dimensionIndex: range.dimensionIndex,
    from: decodeBoundary(range.from, sortKeys[range.dimensionIndex]),
    to: decodeBoundary(range.to, sortKeys[range.dimensionIndex]),
  }))
}

function encodeFocusedValue(
  focusedValue: FocusedValue | undefined,
  sortKeys: SortKey[],
): FocusedValue | undefined {
  if (!focusedValue) return undefined
  return {
    dimensionIndex: focusedValue.dimensionIndex,
    value: encodeBoundary(focusedValue.value, sortKeys[focusedValue.dimensionIndex]) ?? focusedValue.value,
  }
}

function decodeFocusedValue(
  focusedValue: FocusedValue | undefined,
  sortKeys: SortKey[],
): FocusedValue | undefined {
  if (!focusedValue) return undefined
  return {
    dimensionIndex: focusedValue.dimensionIndex,
    value: decodeBoundary(focusedValue.value, sortKeys[focusedValue.dimensionIndex]) ?? focusedValue.value,
  }
}

function encodeChunkForPlan(chunk: Chunk, sortKeys: SortKey[]): Chunk {
  return {
    ...chunk,
    ranges: encodeRangesForPlan(chunk.ranges, sortKeys),
    analysis: {
      ...chunk.analysis,
      focusedValue: encodeFocusedValue(chunk.analysis.focusedValue, sortKeys),
    },
  }
}

function decodeChunkFromPlan(chunk: Chunk, sortKeys: SortKey[]): Chunk {
  return {
    ...chunk,
    ranges: decodeRangesFromPlan(chunk.ranges, sortKeys),
    analysis: {
      ...chunk.analysis,
      focusedValue: decodeFocusedValue(chunk.analysis.focusedValue, sortKeys),
    },
  }
}

export function encodeChunkPlanForPersistence(plan: ChunkPlan): ChunkPlan {
  return {
    ...plan,
    chunks: plan.chunks.map((chunk) => encodeChunkForPlan(chunk, plan.table.sortKeys)),
  }
}

export function decodeChunkPlanFromPersistence(plan: ChunkPlan): ChunkPlan {
  return {
    ...plan,
    chunks: plan.chunks.map((chunk) => decodeChunkFromPlan(chunk, plan.table.sortKeys)),
  }
}
