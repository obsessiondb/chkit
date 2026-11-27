export * from '@logtape/logtape'

export { BackfillInterruptedError, CHECKPOINT_VERSION, executeBackfill, syncProgress } from './async-backfill.js'
export { analyzeAndChunk, analyzeTable } from './chunking/analyze.js'
export {
  decodeChunkPlanFromPersistence,
  encodeChunkPlanForPersistence,
} from './chunking/boundary-codec.js'
export { generateChunkPlan } from './chunking/planner.js'
export { assertPinnedInsertSettingsAccepted, buildBackfillPlan, readPinnedSettingAliases } from './planner.js'
export { acquireRunLock, runLockPath } from './run-lock.js'
export {
  backfillPaths,
  clearSubmissionIntent,
  computeBackfillStateDir,
  confirmBackfillSubmission,
  listRemoteSubmissions,
  readPlanSubmission,
  readSubmissionIntent,
  recordBackfillSubmission,
  recordSubmissionIntent,
  submissionIntentPath,
} from './state.js'
export { insertSettingsFromOptions, PlanSchema, SubmitSchema, parseByteSize } from './options.js'
export {
  CHKIT_BACKFILL_LOGGER_CATEGORY,
  CHKIT_LOGGER_CATEGORY,
  getBackfillLogger,
} from './logging.js'
export {
  buildChunkExecutionSql,
  assertInsertSettingsKeepPinned,
  buildWhereClauseFromChunk,
  deliveryOverrideWarning,
  effectiveInsertSettings,
  injectSortKeyFilter,
  type InsertSettings,
  PINNED_INSERT_SETTINGS,
  rewriteSelectColumns,
} from './chunking/sql.js'
export { generateIdempotencyToken } from './chunking/utils/ids.js'

export type { PlanOptions, SubmitOptions } from './options.js'
export type { BackfillPlanState, BackfillSubmissionState, BuildBackfillPlanOutput } from './types.js'

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
