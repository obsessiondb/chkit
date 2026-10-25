import { randomUUID } from 'node:crypto'

import { SpanStatusCode } from '@opentelemetry/api'
import * as Effect from 'effect/Effect'
import * as Exit from 'effect/Exit'
import * as Queue from 'effect/Queue'
import * as Semaphore from 'effect/Semaphore'

import { toJsonRows } from './destination.js'
import { BudgetExhausted, classifyFailure, FetchFailure, IngestConfigError } from './errors.js'
import { canonicalJson, digest, emptyCheckpoint } from './journal-records.js'
import { simpleLoader } from './loader.js'
import type { SelectedStream } from './registry.js'
import { attemptEffect, mergeRetry, retryEffect, StopRetry } from './retry.js'
import { aborted, abortOn, foreign, promiseBridge, publicError, runPublic, sync, withSpan } from './runtime.js'
import type {
  AnyStreamDefinition,
  CheckpointEnvelope,
  CommittedCheckpoint,
  DestinationAdapter,
  ExecutionResult,
  Journal,
  JournalEvent,
  PipelineDefinition,
  Row,
  SinkReceipt,
  StreamOutcome,
  StreamResult,
} from './types.js'

const RUN_NAMESPACE_PREFIX = '@run:'
const DEFAULT_BATCH_SIZE = 10_000
const DEFAULT_PREFETCH_BATCHES = 1
const DEFAULT_MAX_DURATION_MS = 60 * 60_000
const LOAD_ATTEMPTS = 3
const JOURNAL_APPEND_ATTEMPTS = 4
const TERMINAL_JOURNAL_TIMEOUT_MS = 5000
const DEFAULT_MAX_CHUNK_ROWS = 100_000
const SHUTDOWN_GRACE_MS = 5000
const NEVER_ABORTED = new AbortController().signal

export interface BackfillRequest {
  /** Stable identity: resuming the same backfill reuses its isolated checkpoint namespace. */
  id: string
  from: Date | undefined
  to: Date | undefined
}

export interface ExecutionRequest {
  selected: readonly SelectedStream[]
  backfill: BackfillRequest | undefined
}

export interface ExecutionEnv {
  journal: Journal
  destination: DestinationAdapter
  signal?: AbortSignal
  /** Host-default execution budget. Exhaustion preserves committed progress. */
  maxDurationMs?: number
  /** Finite number of mapped batches buffered between fetch and load. */
  prefetchBatches?: number
  now?: () => Date
  log?: (message: string) => void
}

interface ResolvedEnv extends Required<Omit<ExecutionEnv, 'signal'>> {
  signal: AbortSignal
  hostSignal: AbortSignal
}

interface PipelinePermits {
  streams: Semaphore.Semaphore
  fetches: Semaphore.Semaphore
  loads: Semaphore.Semaphore
}

interface PendingBatch {
  rows: Row[]
  intervalIds: string[] | undefined
  state: { value: unknown } | undefined
}

interface StreamProgress {
  base: CommittedCheckpoint
  startedAt: string
  seq: number
  appends: Semaphore.Semaphore
  appendFailure: { error: unknown } | undefined
  version: number
  checkpointId: string
  successId: string
  envelope: CheckpointEnvelope | undefined
  rows: number
  batches: number
  chunks: number
}

interface StreamInput {
  stream: AnyStreamDefinition
  pipeline: PipelineDefinition
  namespaceId: string
  backfill: BackfillRequest | undefined
  runId: string
  cutoff: Date
  permits: PipelinePermits
  progress: StreamProgress
  env: ResolvedEnv
}

interface ReaderInput extends StreamInput {
  workId: string
  attemptNo: number
  state: unknown
  selection: unknown
  retry: ReturnType<typeof mergeRetry>
}

type AppendInput = { namespaceId: string; runId: string; progress: StreamProgress; env: ResolvedEnv }
type FactFields = Partial<Omit<JournalEvent, 'namespaceId' | 'eventSeq' | 'eventKind' | 'runId'>>

export function runIngestion(request: ExecutionRequest, input: ExecutionEnv): Promise<ExecutionResult> {
  return runPublic(Effect.scoped(Effect.gen(function* () {
    const deadline = new AbortController()
    const env = yield* sync(() => resolveEnv(input, deadline.signal))
    yield* sync(() => validateSelection(request.selected))
    yield* Effect.sleep(env.maxDurationMs).pipe(
      Effect.andThen(Effect.sync(() => deadline.abort(new BudgetExhausted('execution budget exhausted')))),
      Effect.forkScoped
    )
    const runId = randomUUID()
    const cutoff = yield* sync(env.now)
    const streamIds = request.selected.map((entry) => entry.stream.id)
    return yield* withSpan('chkit.ingest.execution', {
      'chkit.ingest.run_id': runId,
      'chkit.ingest.stream_ids': streamIds,
    }, (span) => Effect.gen(function* () {
      yield* abortOn(foreign(() => env.journal.ensure()), env.signal)
      yield* appendRunEvent(env, runEvent(1, 'run_started', runId, '', {
        streamIds, cutoff: cutoff.toISOString(), backfill: request.backfill?.id,
      }), false)
      const permits = new Map<string, PipelinePermits>()
      const streams = yield* Effect.forEach(request.selected, (entry) =>
        executeSelectedStream(entry, permitsFor(permits, entry.pipeline), request.backfill, runId, cutoff, env),
      { concurrency: 'unbounded' })
      const ok = streams.every((stream) => stream.outcome === 'succeeded')
      yield* appendRunEvent(env, runEvent(2, 'run_finished', runId, ok ? 'succeeded' : 'failed', {
        outcomes: Object.fromEntries(streams.map((stream) => [stream.namespaceId, stream.outcome])),
      }), true)
      if (!ok) span.setStatus({ code: SpanStatusCode.ERROR })
      return { runId, cutoff: cutoff.toISOString(), streams, ok }
    }))
  })))
}

function executeSelectedStream(
  entry: SelectedStream,
  permits: PipelinePermits,
  backfill: BackfillRequest | undefined,
  runId: string,
  cutoff: Date,
  env: ResolvedEnv
): Effect.Effect<StreamResult> {
  return Effect.suspend(() => {
    const { stream, pipeline } = entry
    const namespaceId = backfill ? `${stream.id}#backfill:${backfill.id}` : stream.id
    const progress: StreamProgress = {
      base: emptyCheckpoint(), startedAt: cutoff.toISOString(), seq: 0,
      appends: Semaphore.makeUnsafe(1), appendFailure: undefined,
      version: 0, checkpointId: '', successId: '', envelope: undefined, rows: 0, batches: 0, chunks: 0,
    }
    const result = (outcome: StreamOutcome, error: string | undefined): StreamResult => ({
      streamId: stream.id, pipelineId: pipeline.id, namespaceId, outcome,
      rows: progress.rows, batches: progress.batches, chunks: progress.chunks,
      checkpointVersion: progress.version, error,
    })
    return permits.streams.withPermits(1)(Effect.gen(function* () {
      if (env.signal.aborted) return result(env.hostSignal.aborted ? 'cancelled' : 'budget_exhausted', 'execution interrupted before start')
      return yield* withSpan('chkit.ingest.stream', {
        'chkit.ingest.stream_id': stream.id, 'chkit.ingest.namespace_id': namespaceId,
      }, () => executeStream({ stream, pipeline, namespaceId, backfill, runId, cutoff, permits, progress, env }).pipe(
        Effect.tap((outcome) => sync(() => env.log(`${namespaceId}: ${outcome} (${progress.rows} rows, ${progress.batches} batches, checkpoint v${progress.version})`))),
        Effect.map((outcome) => result(outcome, undefined))
      ))
    })).pipe(Effect.catchCause((cause) => Effect.sync(() => {
      const error = publicError(cause, env.signal)
      const outcome: StreamOutcome = env.hostSignal.aborted ? 'cancelled' : env.signal.aborted ? 'budget_exhausted' : 'failed'
      const message = messageOf(error)
      env.log(`${namespaceId}: ${outcome} — ${message}`)
      return result(outcome, message)
    })))
  })
}

function executeStream(input: StreamInput): Effect.Effect<StreamOutcome, unknown> {
  return Effect.gen(function* () {
    const { stream, pipeline, namespaceId, progress, env } = input
    const committed = yield* abortOn(foreign(() => env.journal.readCheckpoint(namespaceId)), env.signal)
    progress.base = committed
    progress.version = committed.version
    progress.checkpointId = committed.checkpointId
    progress.successId = committed.successId
    progress.envelope = committed.envelope
    const retry = mergeRetry(pipeline.retry, stream.retry)
    let workId = ''
    const exit = yield* Effect.exit(attemptEffect((attemptNo) => Effect.gen(function* () {
      const state = yield* sync(() => restoreState(stream, progress.envelope, namespaceId))
      const selection: unknown = yield* sync(() => stream.incremental.plan({
        state, cutoff: input.cutoff,
        range: input.backfill ? { from: input.backfill.from, to: input.backfill.to } : undefined,
      }))
      const nextWorkId = digest([namespaceId, progress.successId, progress.checkpointId, canonicalJson(selection)]).slice(0, 24)
      const planned = nextWorkId === workId ? [] : [{
        eventKind: 'work_planned' as const,
        fields: { workId: nextWorkId, workState: 'planned' as const, detail: { selection, strategy: stream.incremental.id, strategyVersion: stream.incremental.version, pipelineId: pipeline.id } },
      }]
      workId = nextWorkId
      yield* appendFacts(input, [...planned, { eventKind: 'attempt_started', fields: { workId, attemptNo, workState: 'running' } }])
      return yield* readAndLoad({ ...input, workId, attemptNo, state, selection, retry })
    }), {
      ...retry,
      shouldRetry: (context) => progress.chunks < (stream.budget?.maxChunks ?? Infinity) && (retry.shouldRetry?.(context) ?? true),
    }, {
      signal: env.signal,
      classifier: stream.classifyError,
      onRetry: (context, retryAfterMs) => append(input, 'retry_scheduled', {
        workId, attemptNo: context.attemptNumber,
        retryAt: retryAfterMs === undefined ? undefined : new Date(env.now().getTime() + retryAfterMs),
        errorClass: context.error.classification.kind, detail: { error: context.error.message },
      }),
    }))
    let outcome: StreamOutcome = Exit.isSuccess(exit) ? exit.value : 'failed'
    let failure = Exit.isFailure(exit) ? { error: publicError(exit.cause, env.signal) } : undefined
    if (Exit.isFailure(exit) && env.signal.aborted) {
      outcome = env.hostSignal.aborted ? 'cancelled' : 'budget_exhausted'
      if (outcome === 'budget_exhausted') failure = undefined
    }
    yield* append(input, 'work_finished', {
      workId,
      workState: failure === undefined ? outcome : outcome === 'cancelled' ? 'cancelled' : 'failed',
      errorClass: failure === undefined ? '' : failureKind(failure.error, env.signal, stream),
      detail: { rows: progress.rows, batches: progress.batches, chunks: progress.chunks, error: failure === undefined ? undefined : messageOf(failure.error) },
    })
    if (failure !== undefined) return yield* Effect.fail(failure.error)
    return outcome
  })
}

function readAndLoad(input: ReaderInput): Effect.Effect<StreamOutcome, unknown> {
  return Effect.scoped(Effect.gen(function* () {
    const { stream, namespaceId, progress, env } = input
    const maxChunks = stream.budget?.maxChunks ?? Infinity
    if (progress.chunks >= maxChunks) return 'budget_exhausted' as const
    const lifetime = yield* Effect.acquireRelease(
      Effect.sync(() => new AbortController()),
      (controller) => Effect.sync(() => controller.abort(new DOMException('Reader lifetime ended', 'AbortError')))
    )
    const signal = AbortSignal.any([env.signal, lifetime.signal])
    const bridge = yield* promiseBridge(signal)
    const queue = yield* Queue.bounded<PendingBatch | undefined>(env.prefetchBatches)
    const batchSize = stream.batchSize ?? DEFAULT_BATCH_SIZE
    let budgetExhausted = false
    const produce = Effect.gen(function* () {
      let pending = emptyBatch()
      yield* Effect.acquireUseRelease(
        sync(() => stream.read({
          streamId: stream.id, selection: input.selection, state: input.state, cutoff: input.cutoff, signal,
          attempt: (operation, options) => bridge(attemptEffect(() => input.permits.fetches.withPermits(1)(
            abortOn(foreign(() => operation(signal)), signal)
          ), input.retry, {
            signal, classifier: stream.classifyError,
            onRetry: (context, retryAfterMs) => append(input, 'retry_scheduled', {
              workId: input.workId, attemptNo: input.attemptNo,
              retryAt: retryAfterMs === undefined ? undefined : new Date(env.now().getTime() + retryAfterMs),
              errorClass: context.error.classification.kind,
              detail: { label: options?.label ?? 'source', sourceAttempt: context.attemptNumber, error: context.error.message },
            }),
          })),
        })[Symbol.asyncIterator]()),
        (iterator) => Effect.exit(Effect.gen(function* () {
          while (!budgetExhausted) {
            const step = yield* foreign(() => iterator.next())
            if (step.done) break
            const chunk = yield* sync(() => {
              const value: unknown = step.value
              assertValidChunk(stream.id, value, stream.budget?.maxChunkRows ?? DEFAULT_MAX_CHUNK_ROWS)
              return value
            })
            progress.chunks += 1
            if (chunk.id !== undefined && pending.rows.length > 0) {
              yield* Queue.offer(queue, pending).pipe(Effect.andThen(Queue.flush(queue)))
              pending = emptyBatch()
            }
            pending.rows.push(...chunk.rows)
            if (pending.intervalIds) {
              if (chunk.id === undefined) pending.intervalIds = undefined
              else pending.intervalIds.push(chunk.id)
            }
            if (chunk.state !== undefined) pending.state = { value: chunk.state }
            if (chunk.id !== undefined || pending.rows.length >= batchSize) {
              yield* Queue.offer(queue, pending).pipe(Effect.andThen(Queue.flush(queue)))
              pending = emptyBatch()
            }
            if (progress.chunks >= maxChunks) budgetExhausted = true
          }
        })),
        (iterator) => sync(() => { void Promise.resolve(iterator.return?.()).catch(() => undefined) })
      ).pipe(Effect.flatten)
      if (!budgetExhausted) {
        const completed: unknown = yield* sync(() => stream.incremental.complete?.({ state: input.state, selection: input.selection }))
        if (completed !== undefined) pending.state = { value: completed }
      }
      if (pending.rows.length > 0 || pending.state !== undefined) yield* Queue.offer(queue, pending).pipe(Effect.andThen(Queue.flush(queue)))
      yield* Queue.offer(queue, undefined).pipe(Effect.andThen(Queue.flush(queue)))
    })
    const consume = Effect.gen(function* () {
      let sinceBoundary = 0
      for (let batch = yield* Queue.take(queue); batch !== undefined; batch = yield* Queue.take(queue)) {
        const discriminator = batch.intervalIds ? `interval:${canonicalJson(batch.intervalIds)}` : `content:${canonicalJson(toJsonRows(batch.rows))}`
        const batchId = digest([namespaceId, progress.successId, progress.checkpointId, String(sinceBoundary), discriminator]).slice(0, 32)
        const receipt = yield* loadBatch(input, batchId, batch.rows, signal)
        yield* sync(() => signal.throwIfAborted())
        const envelope: CheckpointEnvelope | undefined = batch.state
          ? { strategy: stream.incremental.id, version: stream.incremental.version, state: batch.state.value }
          : progress.envelope
        const advanced = canonicalJson(envelope ?? null) !== canonicalJson(progress.envelope ?? null)
        const expected = progress.version
        const version = advanced ? expected + 1 : expected
        yield* append(input, 'batch_committed', {
          workId: input.workId, attemptNo: input.attemptNo, batchId,
          expectedCheckpointVersion: expected, checkpointVersion: version, checkpoint: envelope,
          sinkEvidence: receipt.evidence, detail: { rows: receipt.rows, writeUnits: receipt.writeUnits },
        })
        sinceBoundary = advanced ? 0 : sinceBoundary + 1
        progress.version = version
        progress.envelope = envelope
        progress.rows += receipt.rows
        progress.batches += 1
      }
    })
    yield* abortOn(Effect.all([produce, consume].map((task) => task.pipe(
      Effect.tapCause((cause) => Effect.sync(() => lifetime.abort(publicError(cause, signal))))
    )), { concurrency: 'unbounded', discard: true }), signal)
    if (budgetExhausted) {
      yield* sync(() => env.log(`${namespaceId}: ${new BudgetExhausted('execution budget exhausted; committed progress is preserved').message}`))
      return 'budget_exhausted' as const
    }
    return 'succeeded' as const
  }))
}

function loadBatch(input: StreamInput, batchId: string, rows: readonly Row[], signal: AbortSignal): Effect.Effect<SinkReceipt, unknown> {
  return withSpan('chkit.ingest.load', { 'chkit.ingest.batch_id': batchId, 'chkit.ingest.rows': rows.length }, (span) => {
    const factory = input.stream.loader ?? simpleLoader()
    return retryEffect(() => input.permits.loads.withPermits(1)(Effect.scoped(Effect.gen(function* () {
      yield* sync(() => signal.throwIfAborted())
      const loader = yield* sync(() => factory({
        streamId: input.stream.id, runId: input.runId, table: input.stream.destination,
        destination: input.env.destination, signal,
      })).pipe(Effect.mapError((error) => new StopRetry(error instanceof Error ? error : new Error(String(error)))))
      return yield* foreign(() => loader.write({ batchId, rows })).pipe(
        Effect.andThen(foreign(() => loader.finalize())),
        Effect.onExit((exit) => {
          if (Exit.isSuccess(exit)) return Effect.void
          return foreign(() => loader.abort(publicError(exit.cause, signal))).pipe(
            Effect.catchCause((cause) => Effect.sync(() => {
              const error = publicError(cause, signal)
              span.recordException(error instanceof Error ? error : new Error(String(error)))
            })),
            Effect.timeoutOption(SHUTDOWN_GRACE_MS),
            Effect.asVoid
          )
        })
      )
    }))), { retries: LOAD_ATTEMPTS - 1, minTimeout: 1000 }, signal)
  })
}

function restoreState(stream: AnyStreamDefinition, envelope: CheckpointEnvelope | undefined, namespaceId: string): unknown {
  if (!envelope) return undefined
  if (envelope.strategy !== stream.incremental.id || envelope.version !== stream.incremental.version) {
    throw new IngestConfigError(
      `Checkpoint for "${namespaceId}" was written by strategy ${envelope.strategy}@${envelope.version}, but the stream now declares ${stream.incremental.id}@${stream.incremental.version}. ` +
        'ChKit never silently reinterprets a checkpoint: migrate the state explicitly, use a new stream id, or run a separately namespaced backfill.'
    )
  }
  return stream.incremental.parseState(envelope.state)
}

function append(input: AppendInput, eventKind: JournalEvent['eventKind'], fields: FactFields): Effect.Effect<void, unknown> {
  return appendFacts(input, [{ eventKind, fields }])
}

function appendFacts(input: AppendInput, facts: ReadonlyArray<{ eventKind: JournalEvent['eventKind']; fields: FactFields }>): Effect.Effect<void, unknown> {
  const { progress, env } = input
  const terminal = facts.some((fact) => fact.eventKind === 'work_finished')
  const write = progress.appends.withPermits(1)(Effect.gen(function* () {
    if (progress.appendFailure) return yield* Effect.fail(progress.appendFailure.error)
    const events = facts.map(({ eventKind, fields }, index): JournalEvent => ({
      namespaceId: input.namespaceId, eventSeq: progress.seq + 1 + index, eventKind, runId: input.runId,
      workId: fields.workId ?? '', attemptNo: fields.attemptNo ?? 0, batchId: fields.batchId ?? '',
      expectedCheckpointVersion: fields.expectedCheckpointVersion ?? progress.version,
      checkpointVersion: fields.checkpointVersion ?? progress.version,
      checkpoint: fields.checkpoint, workState: fields.workState ?? '', sinkEvidence: fields.sinkEvidence ?? '',
      retryAt: fields.retryAt, errorClass: fields.errorClass ?? '',
      detail: progress.seq === 0 && index === 0
        ? { ...fields.detail, journal: { version: 2, startedAt: progress.startedAt, base: progress.base } }
        : fields.detail ?? {},
    }))
    yield* retryEffect(() => foreign(() => env.journal.append(events)), {
      retries: JOURNAL_APPEND_ATTEMPTS - 1, minTimeout: 250,
    }, terminal ? NEVER_ABORTED : env.signal).pipe(Effect.onExit((exit) => Effect.sync(() => {
      if (Exit.isFailure(exit)) progress.appendFailure = { error: publicError(exit.cause, env.signal) }
    })))
    for (const event of events) {
      if (event.eventKind === 'batch_committed' && event.checkpointVersion > event.expectedCheckpointVersion) {
        progress.checkpointId = `${event.runId}:${event.eventSeq}`
      }
    }
    progress.seq += events.length
  }))
  return terminal ? terminalWrite(write, env.signal) : abortOn(write, env.signal)
}

function appendRunEvent(env: ResolvedEnv, event: JournalEvent, terminal: boolean): Effect.Effect<void, unknown> {
  const write = retryEffect(() => foreign(() => env.journal.append([event])), {
    retries: JOURNAL_APPEND_ATTEMPTS - 1, minTimeout: 250,
  }, terminal ? NEVER_ABORTED : env.signal)
  return terminal ? terminalWrite(write, env.signal) : write
}

function terminalWrite<T, E, R>(effect: Effect.Effect<T, E, R>, signal: AbortSignal): Effect.Effect<T, unknown, R> {
  return Effect.raceFirst(effect, aborted(signal).pipe(
    Effect.catch(() => Effect.sleep(TERMINAL_JOURNAL_TIMEOUT_MS)),
    Effect.andThen(Effect.fail(new DOMException('The operation timed out.', 'TimeoutError')))
  ))
}

function runEvent(seq: number, eventKind: 'run_started' | 'run_finished', runId: string, workState: JournalEvent['workState'], detail: Record<string, unknown>): JournalEvent {
  return {
    namespaceId: `${RUN_NAMESPACE_PREFIX}${runId}`, eventSeq: seq, eventKind, runId, workId: runId,
    attemptNo: 0, batchId: '', expectedCheckpointVersion: 0, checkpointVersion: 0,
    checkpoint: undefined, workState, sinkEvidence: '', retryAt: undefined, errorClass: '', detail,
  }
}

function assertValidChunk(streamId: string, chunk: unknown, maxChunkRows: number): asserts chunk is { rows: readonly Row[]; state?: unknown; id?: string } {
  if (typeof chunk !== 'object' || chunk === null || !('rows' in chunk) || !Array.isArray(chunk.rows)) {
    throw new IngestConfigError(`Stream "${streamId}" yielded a chunk without a "rows" array.`)
  }
  if ('id' in chunk && chunk.id !== undefined && typeof chunk.id !== 'string') {
    throw new IngestConfigError(`Stream "${streamId}" yielded a chunk whose "id" is not a string.`)
  }
  if (chunk.rows.length > maxChunkRows) {
    throw new IngestConfigError(
      `Stream "${streamId}" yielded a chunk of ${chunk.rows.length} rows, above the ${maxChunkRows}-row bound. Yield smaller chunks or raise budget.maxChunkRows.`
    )
  }
}

function emptyBatch(): PendingBatch {
  return { rows: [], intervalIds: [], state: undefined }
}

function permitsFor(cache: Map<string, PipelinePermits>, pipeline: PipelineDefinition): PipelinePermits {
  const existing = cache.get(pipeline.id)
  if (existing) return existing
  const created: PipelinePermits = {
    streams: Semaphore.makeUnsafe(pipeline.maxStreams), fetches: Semaphore.makeUnsafe(pipeline.maxFetches), loads: Semaphore.makeUnsafe(pipeline.maxLoads),
  }
  cache.set(pipeline.id, created)
  return created
}

function resolveEnv(input: ExecutionEnv, deadlineSignal: AbortSignal): ResolvedEnv {
  const maxDurationMs = input.maxDurationMs ?? DEFAULT_MAX_DURATION_MS
  if (!Number.isFinite(maxDurationMs) || maxDurationMs <= 0) throw new IngestConfigError('maxDurationMs must be a positive finite number.')
  const prefetchBatches = input.prefetchBatches ?? DEFAULT_PREFETCH_BATCHES
  positiveCapacity('prefetchBatches', prefetchBatches)
  return {
    journal: input.journal, destination: input.destination,
    signal: AbortSignal.any([input.signal ?? NEVER_ABORTED, deadlineSignal]), hostSignal: input.signal ?? NEVER_ABORTED,
    maxDurationMs, prefetchBatches, now: input.now ?? (() => new Date()), log: input.log ?? (() => undefined),
  }
}

function validateSelection(selected: readonly SelectedStream[]): void {
  for (const { pipeline, stream } of selected) {
    for (const name of ['maxStreams', 'maxFetches', 'maxLoads'] as const) positiveCapacity(`Pipeline "${pipeline.id}": ${name}`, pipeline[name])
    positiveCapacity(`Stream "${stream.id}": batchSize`, stream.batchSize ?? DEFAULT_BATCH_SIZE)
    positiveCapacity(`Stream "${stream.id}": maxChunkRows`, stream.budget?.maxChunkRows ?? DEFAULT_MAX_CHUNK_ROWS)
    if (stream.budget?.maxChunks !== undefined) positiveCapacity(`Stream "${stream.id}": maxChunks`, stream.budget.maxChunks)
  }
}

function positiveCapacity(name: string, value: number): void {
  if (!Number.isSafeInteger(value) || value <= 0) throw new IngestConfigError(`${name} must be a positive finite safe integer.`)
}

function failureKind(error: unknown, signal: AbortSignal, stream: AnyStreamDefinition): string {
  if (error instanceof IngestConfigError) return 'config'
  if (error instanceof FetchFailure) return error.classification.kind
  return classifyFailure(error, signal, stream.classifyError).kind
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
