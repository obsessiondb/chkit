export { executeBackfill, syncProgress } from './async-backfill.js'
export { analyzeAndChunk, analyzeTable } from './chunking/analyze.js'
export {
  decodeChunkPlanFromPersistence,
  encodeChunkPlanForPersistence,
} from './chunking/boundary-codec.js'
export { generateChunkPlan } from './chunking/planner.js'
export {
  buildChunkExecutionSql,
  buildWhereClauseFromChunk,
  injectSortKeyFilter,
  rewriteSelectColumns,
} from './chunking/sql.js'
export { generateIdempotencyToken } from './chunking/utils/ids.js'

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
  Chunk,
  ChunkDerivationStep,
  ChunkPlan,
  ChunkRange,
  EstimateConfidence,
  EstimateReason,
  FocusedValue,
  Partition,
  PartitionDiagnostics,
  SortKey,
} from './chunking/types.js'
