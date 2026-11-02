export { ingest, createIngestPlugin, checkGraph, type IngestPlugin, type IngestPluginOptions } from './plugin.js'
export { defineStream, definePipeline, selectStreams, type SelectedStream } from './registry.js'
export { fullSync, timestampWindow, cursorState, type TimestampRange, type TimestampWindowOptions, type TimestampWindowState } from './incremental.js'
export { paginate, type Page } from './paginate.js'
export { simpleLoader } from './loader.js'
export { stagedLoader, type StagedLoaderOptions, type StagedLoaderExecutor } from './staged-loader.js'
/**
 * - Create a stateless SQL executor for stagedLoader; pin it to one server.
 * - Reuse the same object for staged writers; its owner must close it.
 * - Wire publication and journal to the same target; CLI --config neither rebinds nor closes it.
 */
export { createStatelessClickHouseExecutor as createStagedLoaderExecutor } from '@chkit/clickhouse'
export { ingestionColumns, rawTable, rawRows, createClickHouseDestination, type RawRow } from './destination.js'
export { createClickHouseJournal, type ClickHouseJournalOptions } from './journal.js'
export { doctorJournal, repairJournal, planJournalRepair, type JournalRecoveryOptions, type JournalRepairPlan, type JournalRepairResult } from './recovery.js'
export { runIngestion, type BackfillRequest, type ExecutionEnv, type ExecutionRequest } from './executor.js'
export { HttpError, FetchFailure, IngestConfigError } from './errors.js'
export type {
  DestinationAdapter,
  ErrorClassifier,
  ExecutionResult,
  FailureClass,
  FetchContext,
  IncrementalStrategy,
  Journal,
  Loader,
  LoaderContext,
  LoaderFactory,
  PipelineDefinition,
  ReadContext,
  RetryOptions,
  Row,
  SinkReceipt,
  SourceChunk,
  StreamDefinition,
  StreamResult,
} from './types.js'
