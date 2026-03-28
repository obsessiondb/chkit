export interface PartitionInfo {
  partitionId: string
  rows: number
  bytesOnDisk: number
  minTime: string
  maxTime: string
}

export interface SortKeyInfo {
  column: string
  type: string
  category: 'numeric' | 'datetime' | 'string'
}

export interface ChunkBoundary {
  partitionId: string
  sortKeyFrom?: string
  sortKeyTo?: string
  estimatedBytes: number
}

export interface PlannedChunk {
  id: string
  partitionId: string
  sortKeyFrom?: string
  sortKeyTo?: string
  estimatedBytes: number
  idempotencyToken: string
  from: string
  to: string
}
