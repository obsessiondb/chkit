export type RowProbeStrategy = 'explain-estimate' | 'count'

export type SortKeyCategory = 'numeric' | 'datetime' | 'string'

type SortKeyBoundaryEncoding = 'literal' | 'hex-latin1'

export type EstimateConfidence = 'high' | 'low' | 'exact'

export type EstimateReason =
  | 'partition-metadata'
  | 'quantile-estimate'
  | 'string-prefix-distribution'
  | 'group-by-key-distribution'
  | 'temporal-distribution'
  | 'equal-width-distribution'
  | 'exact-count'

export interface SortKey {
  name: string
  type: string
  category: SortKeyCategory
  boundaryEncoding: SortKeyBoundaryEncoding
}

export interface ChunkRange {
  dimensionIndex: number
  from?: string
  to?: string
}

export interface ChunkDerivationStep {
  strategyId: string
  dimensionIndex?: number
  reason: string
}

export interface ChunkEstimate {
  rows: number
  bytesCompressed: number
  bytesUncompressed: number
  confidence: EstimateConfidence
  reason: EstimateReason
}

export interface FocusedValue {
  dimensionIndex: number
  value: string
}

interface ChunkAnalysis {
  focusedValue?: FocusedValue
  lineage: ChunkDerivationStep[]
}

export interface Chunk {
  id: string
  partitionId: string
  ranges: ChunkRange[]
  estimate: ChunkEstimate
  analysis: ChunkAnalysis
}

export interface PartitionDiagnostics {
  estimatedRowSum: number
  exactPartitionRows: number
  estimateToExactRatio: number
  suspiciousEstimate: boolean
  lowConfidenceChunkCount: number
  usedDistributionFallback: boolean
  usedLowConfidenceChunkRefinement: boolean
  usedExactCountFallback: boolean
}

export interface Partition {
  partitionId: string
  rows: number
  bytesCompressed: number
  bytesUncompressed: number
  minTime: string
  maxTime: string
  diagnostics?: PartitionDiagnostics
}

export interface TableProfile {
  database: string
  table: string
  sortKeys: SortKey[]
}

interface ChunkPlanStats {
  totalPartitions: number
  oversizedPartitions: number
  focusedChunks: number
  totalChunks: number
  avgChunkBytes: number
  maxChunkBytes: number
  minChunkBytes: number
}

export interface ChunkPlan {
  planId: string
  generatedAt: string
  rowProbeStrategy: RowProbeStrategy
  targetChunkBytes: number
  table: TableProfile
  partitions: Partition[]
  chunks: Chunk[]
  totalRows: number
  totalBytesCompressed: number
  totalBytesUncompressed: number
  stats: ChunkPlanStats
}

export type PlannerQuery = <T>(sql: string, settings?: Record<string, string | number | boolean | undefined>) => Promise<T[]>

export interface PlannerContext {
  database: string
  table: string
  from?: string
  to?: string
  targetChunkBytes: number
  query: PlannerQuery
  querySettings?: Record<string, string | number | boolean | undefined>
  rowProbeStrategy: RowProbeStrategy
}

export interface EstimateFilter {
  partitionId: string
  ranges: ChunkRange[]
  exactDimensionIndex?: number
  exactValue?: string
}

export interface StringPrefixBucket {
  value: string
  rowCount: number
  isExactValue: boolean
}

export interface TemporalBucket {
  start: string
  rowCount: number
}

export interface PartitionSlice {
  partitionId: string
  ranges: ChunkRange[]
  estimate: ChunkEstimate
  analysis: ChunkAnalysis
}

export interface PartitionBuildResult {
  slices: PartitionSlice[]
  diagnostics: PartitionDiagnostics
}

export interface GenerateChunkPlanInput {
  database: string
  table: string
  from?: string
  to?: string
  targetChunkBytes: number
  query: PlannerQuery
  querySettings?: Record<string, string | number | boolean | undefined>
  rowProbeStrategy?: RowProbeStrategy
}
