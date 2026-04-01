export { executeBackfill, syncProgress } from './async-backfill.js'
export { analyzeAndChunk, analyzeTable, buildPlannedChunks } from './chunking/analyze.js'
export { buildChunkSql, injectSortKeyFilter, rewriteSelectColumns } from './chunking/sql.js'

export type {
  BackfillOptions,
  BackfillChunkState,
  BackfillProgress,
  BackfillResult,
} from './async-backfill.js'

export type {
  AnalyzeAndChunkInput,
  AnalyzeAndChunkResult,
  AnalyzeTableInput,
  AnalyzeTableResult,
} from './chunking/analyze.js'

export type {
  ChunkBoundary,
  EstimateConfidence,
  EstimateReason,
  PartitionDiagnostics,
  PartitionInfo,
  PlannedChunk,
  SliceLineageStep,
  SliceRange,
  SortKeyInfo,
} from './chunking/types.js'
