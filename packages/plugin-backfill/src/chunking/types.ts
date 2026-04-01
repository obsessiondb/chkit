export interface PartitionInfo {
  partitionId: string
  rows: number
  bytesOnDisk: number
  bytesUncompressed?: number
  minTime: string
  maxTime: string
}

export interface SortKeyInfo {
  column: string
  type: string
  category: 'numeric' | 'datetime' | 'string'
}

export interface SliceRange {
  dimensionIndex: number
  from?: string
  to?: string
}

export interface SliceLineageStep {
  strategyId: string
  dimensionIndex?: number
  reason: string
}

export type EstimateConfidence = 'high' | 'low' | 'exact'

export type EstimateReason =
  | 'partition-metadata'
  | 'quantile-estimate'
  | 'string-prefix-distribution'
  | 'temporal-distribution'
  | 'equal-width-distribution'
  | 'exact-count'

export interface ChunkBoundary {
  partitionId: string
  ranges?: SliceRange[]
  sortKeyFrom?: string
  sortKeyTo?: string
  estimatedBytes: number
  estimatedRows?: number
  isHotKey?: boolean
  hotDimensionIndex?: number
  hotKeyValue?: string
  estimateConfidence?: EstimateConfidence
  estimateReason?: EstimateReason
  lineage?: SliceLineageStep[]
}

export interface PlannedChunk {
  id: string
  partitionId: string
  ranges?: SliceRange[]
  sortKeyFrom?: string
  sortKeyTo?: string
  estimatedBytes: number
  estimatedRows?: number
  idempotencyToken: string
  from: string
  to: string
  isHotKey?: boolean
  hotDimensionIndex?: number
  hotKeyValue?: string
  estimateConfidence?: EstimateConfidence
  estimateReason?: EstimateReason
  lineage?: SliceLineageStep[]
}

export interface PartitionDiagnostics {
  partitionId: string
  estimatedRowSum: number
  exactPartitionRows: number
  estimateToExactRatio: number
  suspiciousEstimate: boolean
  lowConfidenceChunkCount: number
  usedDistributionFallback: boolean
  usedLowConfidenceChunkRefinement: boolean
  usedExactCountFallback: boolean
}
