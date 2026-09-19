import type { TableDefinition } from '@chkit/core'

import type { FetchFailure } from './errors.js'

// ───── Authoring: streams and pipelines ─────

export type Row = Record<string, unknown>

/**
 * One bounded unit produced by a stream reader. Rows are already shaped for the
 * destination table: mapping is ordinary code inside the reader.
 *
 * `state` is optional and, when present, must be the COMPLETE candidate
 * provider state that is safe to commit once every row up to and including
 * this chunk has sink evidence. The executor never infers ordering: a reader
 * that cannot claim a safe frontier simply omits `state`.
 */
export interface SourceChunk<TRow extends Row = Row, TState = unknown> {
  rows: readonly TRow[]
  state?: TState
}

export interface AttemptOptions {
  /** Short non-secret label used in journal and telemetry, e.g. `GET /v2/objects`. */
  label?: string
}

export interface ReadContext<TSelection, TState> {
  streamId: string
  /** What to read this execution, planned by the incremental strategy. */
  selection: TSelection
  /** Last committed provider state, already validated by the strategy. */
  state: TState | undefined
  /** Immutable cutoff shared by every stream selected in this execution. */
  cutoff: Date
  signal: AbortSignal
  /**
   * Run one source operation under executor authority: fetch permit, retry
   * policy, failure classification and cancellation. Operations that bypass it
   * only get coarse recovery (reader recreation from the last checkpoint).
   */
  attempt<T>(operation: (signal: AbortSignal) => Promise<T>, options?: AttemptOptions): Promise<T>
}

/**
 * Provider-owned incremental strategy inside the ChKit-owned checkpoint
 * envelope `{ strategy, version, state }`. Core treats `state` as opaque.
 */
export interface IncrementalStrategy<TState, TSelection> {
  readonly id: string
  readonly version: number
  /** Validate previously committed state. Throw when it cannot be trusted. */
  parseState(raw: unknown): TState
  plan(input: PlanInput<TState>): TSelection
  /**
   * Candidate state once the WHOLE selection has sink evidence. Return
   * `undefined` to leave the checkpoint untouched.
   */
  complete?(input: { state: TState | undefined; selection: TSelection }): TState | undefined
}

export interface PlanInput<TState> {
  state: TState | undefined
  cutoff: Date
  /** Explicit historical range from a backfill invocation. */
  range: { from: Date | undefined; to: Date | undefined } | undefined
}

export interface RetryContext {
  error: FetchFailure
  attemptNumber: number
  retriesLeft: number
  retriesConsumed: number
  retryDelay: number
}

/** Portable p-retry-shaped subset. */
export interface RetryOptions {
  retries?: number
  factor?: number
  minTimeout?: number
  maxTimeout?: number
  randomize?: boolean
  maxRetryTime?: number
  shouldRetry?: (context: RetryContext) => boolean | Promise<boolean>
  shouldConsumeRetry?: (context: RetryContext) => boolean | Promise<boolean>
}

export interface StreamBudget {
  /** Maximum source chunks pulled in one execution of this stream. */
  maxChunks?: number
}

export interface StreamDefinition<TRow extends Row = Row, TState = unknown, TSelection = unknown> {
  readonly kind: 'ingest_stream'
  /** Globally stable identity. Owns the checkpoint; never derived from the pipeline. */
  readonly id: string
  readonly destination: TableDefinition
  readonly tags: readonly string[]
  readonly incremental: IncrementalStrategy<TState, TSelection>
  readonly read: (context: ReadContext<TSelection, TState>) => AsyncIterable<SourceChunk<TRow, TState>>
  readonly loader: LoaderFactory | undefined
  readonly retry: RetryOptions | undefined
  readonly batchSize: number | undefined
  readonly budget: StreamBudget | undefined
  readonly classifyError: ErrorClassifier | undefined
}

// biome-ignore lint/suspicious/noExplicitAny: a heterogeneous stream list cannot share row/state generics
export type AnyStreamDefinition = StreamDefinition<any, any, any>

export interface PipelineDefinition {
  readonly kind: 'ingest_pipeline'
  readonly id: string
  readonly tags: readonly string[]
  readonly streams: readonly AnyStreamDefinition[]
  readonly maxStreams: number
  readonly maxFetches: number
  readonly maxLoads: number
  readonly retry: RetryOptions | undefined
}

// ───── Failure classification ─────

export type FailureClass =
  | { kind: 'cancelled' }
  | { kind: 'rate_limited'; retryAfterMs: number | undefined }
  | { kind: 'transient' }
  | { kind: 'permanent' }
  | { kind: 'unknown' }

export type ErrorClassifier = (cause: unknown, fallback: FailureClass) => FailureClass | undefined

// ───── Loading ─────

export type SinkEvidenceKind = 'clickhouse_ack' | 'none_required'

export interface SinkReceipt {
  evidence: SinkEvidenceKind
  rows: number
  writeUnits: number
}

export interface LoadBatch {
  /** Stable across every retry and crash replay of the same logical batch. */
  batchId: string
  rows: readonly Row[]
}

export interface LoaderContext {
  streamId: string
  runId: string
  table: TableDefinition
  destination: DestinationAdapter
  signal: AbortSignal
}

export interface Loader {
  readonly ctx: LoaderContext
  write(batch: LoadBatch): Promise<void>
  finalize(): Promise<SinkReceipt>
  abort(reason: unknown): Promise<void>
}

export type LoaderFactory = (ctx: LoaderContext) => Loader

/** Low-level destination writes performed on behalf of a portable Loader. */
export interface DestinationAdapter {
  insert(input: {
    table: TableDefinition
    rows: readonly Row[]
    /** Deterministic `insert_deduplication_token` for this write unit. */
    token: string
  }): Promise<void>
}

// ───── Journal ─────

export type JournalEventKind =
  | 'run_started'
  | 'work_planned'
  | 'attempt_started'
  | 'retry_scheduled'
  | 'batch_committed'
  | 'work_finished'
  | 'run_finished'

export type WorkState = '' | 'planned' | 'running' | 'succeeded' | 'failed' | 'budget_exhausted' | 'cancelled'

export interface CheckpointEnvelope {
  strategy: string
  version: number
  state: unknown
}

export interface JournalEvent {
  namespaceId: string
  eventSeq: number
  eventKind: JournalEventKind
  runId: string
  workId: string
  attemptNo: number
  batchId: string
  expectedCheckpointVersion: number
  checkpointVersion: number
  checkpoint: CheckpointEnvelope | undefined
  workState: WorkState
  sinkEvidence: SinkEvidenceKind | ''
  retryAt: Date | undefined
  errorClass: string
  detail: Record<string, unknown>
}

export interface CommittedCheckpoint {
  version: number
  envelope: CheckpointEnvelope | undefined
  /** Highest journal sequence observed for the namespace (any event kind). */
  headSeq: number
}

/** Authoritative append-only control state. Checkpoints are projections of it. */
export interface Journal {
  ensure(): Promise<void>
  append(event: JournalEvent): Promise<void>
  readCheckpoint(namespaceId: string): Promise<CommittedCheckpoint>
}

// ───── Execution ─────

export type StreamOutcome = 'succeeded' | 'failed' | 'budget_exhausted' | 'cancelled'

export interface StreamResult {
  streamId: string
  pipelineId: string
  namespaceId: string
  outcome: StreamOutcome
  rows: number
  batches: number
  chunks: number
  checkpointVersion: number
  error: string | undefined
}

export interface ExecutionResult {
  runId: string
  cutoff: string
  streams: StreamResult[]
  ok: boolean
}
