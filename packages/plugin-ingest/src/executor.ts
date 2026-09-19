import { randomUUID } from 'node:crypto'

import { SpanStatusCode, trace, type Span } from '@opentelemetry/api'

import { BudgetExhausted, classifyFailure, FetchFailure, IngestConfigError, isAbortError } from './errors.js'
import { canonicalJson, digest } from './journal.js'
import { simpleLoader } from './loader.js'
import { createBoundedQueue } from './queue.js'
import type { SelectedStream } from './registry.js'
import { DEFAULT_RETRY, mergeRetry, runAttempt, sleep } from './retry.js'
import { createSemaphore, type Semaphore } from './semaphore.js'
import type {
  AnyStreamDefinition,
  CheckpointEnvelope,
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

const RUN_NAMESPACE = '@run'
const DEFAULT_BATCH_SIZE = 10_000
const DEFAULT_PREFETCH_BATCHES = 1
const DEFAULT_MAX_DURATION_MS = 60 * 60_000
const LOAD_ATTEMPTS = 3
const JOURNAL_APPEND_ATTEMPTS = 4
const DEFAULT_MAX_CHUNK_ROWS = 100_000
// How long a failed stream waits for an uncooperative reader before abandoning it.
const READER_SHUTDOWN_GRACE_MS = 5000
const tracer = trace.getTracer('@chkit/plugin-ingest')

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
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>
  random?: () => number
  log?: (message: string) => void
}

interface ResolvedEnv extends Required<Omit<ExecutionEnv, 'signal'>> {
  /** Host cancellation combined with the execution deadline. */
  signal: AbortSignal
  /** Host cancellation only: distinguishes a cancelled run from an exhausted budget. */
  hostSignal: AbortSignal
}

interface PipelinePermits {
  streams: Semaphore
  fetches: Semaphore
  loads: Semaphore
}

interface PendingBatch {
  rows: Row[]
  /** Declared source-interval ids, or `undefined` once any chunk omitted its id. */
  intervalIds: string[] | undefined
  /** Candidate provider state that becomes safe once these rows have sink evidence. */
  state: { value: unknown } | undefined
}

interface StreamProgress {
  /** Last journal sequence confirmed for this namespace. */
  seq: number
  /** Serializes appends so a sequence number is only consumed by a confirmed fact. */
  appendChain: Promise<void>
  version: number
  envelope: CheckpointEnvelope | undefined
  rows: number
  batches: number
  chunks: number
}

/**
 * One transient execution context for one exact stream selection. The run id
 * correlates journal and telemetry evidence only: every stream plans and
 * recovers independently from its own journal-backed checkpoint.
 */
export async function runIngestion(request: ExecutionRequest, input: ExecutionEnv): Promise<ExecutionResult> {
  const deadline = new AbortController()
  const env = resolveEnv(input, deadline.signal)
  // The budget is a real bound: it interrupts hung readers, retry timers and waits.
  const deadlineTimer = setTimeout(() => deadline.abort(new BudgetExhausted('execution budget exhausted')), env.maxDurationMs)
  const runId = randomUUID()
  const cutoff = env.now()
  const streamIds = request.selected.map((entry) => entry.stream.id)

  return tracer.startActiveSpan('chkit.ingest.execution', async (span) => {
    span.setAttribute('chkit.ingest.run_id', runId)
    span.setAttribute('chkit.ingest.stream_ids', streamIds)
    try {
      await env.journal.ensure()
      const runHead = (await env.journal.readCheckpoint(RUN_NAMESPACE)).headSeq
      await env.journal.append(
        runEvent(runHead + 1, 'run_started', runId, '', {
          streamIds,
          cutoff: cutoff.toISOString(),
          backfill: request.backfill?.id,
        })
      )

      const permits = new Map<string, PipelinePermits>()
      const streams = await Promise.all(
        request.selected.map((entry) =>
          executeSelectedStream(entry, permitsFor(permits, entry.pipeline), request.backfill, runId, cutoff, env)
        )
      )

      const ok = streams.every((stream) => stream.outcome === 'succeeded')
      await env.journal.append(
        runEvent(runHead + 2, 'run_finished', runId, ok ? 'succeeded' : 'failed', {
          outcomes: Object.fromEntries(streams.map((stream) => [stream.namespaceId, stream.outcome])),
        })
      )
      if (!ok) span.setStatus({ code: SpanStatusCode.ERROR })
      return { runId, cutoff: cutoff.toISOString(), streams, ok }
    } finally {
      clearTimeout(deadlineTimer)
      span.end()
    }
  })
}

// An ordinary failure in one stream never prevents unrelated selected streams
// from being attempted: every failure is folded into that stream's result.
async function executeSelectedStream(
  entry: SelectedStream,
  permits: PipelinePermits,
  backfill: BackfillRequest | undefined,
  runId: string,
  cutoff: Date,
  env: ResolvedEnv
): Promise<StreamResult> {
  const { stream, pipeline } = entry
  const namespaceId = backfill ? `${stream.id}#backfill:${backfill.id}` : stream.id
  const progress: StreamProgress = { seq: 0, appendChain: Promise.resolve(), version: 0, envelope: undefined, rows: 0, batches: 0, chunks: 0 }
  const result = (outcome: StreamOutcome, error: string | undefined): StreamResult => ({
    streamId: stream.id,
    pipelineId: pipeline.id,
    namespaceId,
    outcome,
    rows: progress.rows,
    batches: progress.batches,
    chunks: progress.chunks,
    checkpointVersion: progress.version,
    error,
  })

  let release: (() => void) | undefined
  try {
    release = await permits.streams.acquire(env.signal)
  } catch {
    return result('cancelled', 'cancelled before start')
  }

  return tracer.startActiveSpan('chkit.ingest.stream', async (span) => {
    span.setAttribute('chkit.ingest.stream_id', stream.id)
    span.setAttribute('chkit.ingest.namespace_id', namespaceId)
    try {
      const outcome = await executeStream({ stream, pipeline, namespaceId, backfill, runId, cutoff, permits, progress, env })
      env.log?.(`${namespaceId}: ${outcome} (${progress.rows} rows, ${progress.batches} batches, checkpoint v${progress.version})`)
      return result(outcome, undefined)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      const outcome: StreamOutcome = env.hostSignal.aborted ? 'cancelled' : env.signal.aborted ? 'budget_exhausted' : 'failed'
      recordFailure(span, error)
      env.log?.(`${namespaceId}: ${outcome} — ${message}`)
      return result(outcome, message)
    } finally {
      span.end()
      release?.()
    }
  })
}

async function executeStream(input: {
  stream: AnyStreamDefinition
  pipeline: PipelineDefinition
  namespaceId: string
  backfill: BackfillRequest | undefined
  runId: string
  cutoff: Date
  permits: PipelinePermits
  progress: StreamProgress
  env: ResolvedEnv
}): Promise<StreamOutcome> {
  const { stream, pipeline, namespaceId, progress, env } = input
  const committed = await env.journal.readCheckpoint(namespaceId)
  progress.seq = committed.headSeq
  progress.version = committed.version
  progress.envelope = committed.envelope

  const retry = mergeRetry(pipeline.retry, stream.retry)
  const readerAttempts = (retry.retries ?? DEFAULT_RETRY.retries) + 1
  let workId = ''
  let outcome: StreamOutcome = 'failed'
  let failure: unknown

  for (let attemptNo = 1; attemptNo <= readerAttempts; attemptNo += 1) {
    try {
      // Re-plan from the latest durable boundary on every reader (re)creation.
      const state = restoreState(stream, progress.envelope, namespaceId)
      const selection: unknown = stream.incremental.plan({
        state,
        cutoff: input.cutoff,
        range: input.backfill ? { from: input.backfill.from, to: input.backfill.to } : undefined,
      })
      const nextWorkId = digest([namespaceId, String(progress.version), canonicalJson(selection)]).slice(0, 24)
      if (nextWorkId !== workId) {
        workId = nextWorkId
        await append(input, 'work_planned', { workId, workState: 'planned', detail: { selection, strategy: stream.incremental.id, strategyVersion: stream.incremental.version, pipelineId: pipeline.id } })
      }
      await append(input, 'attempt_started', { workId, attemptNo, workState: 'running' })
      outcome = await readAndLoad({ ...input, workId, attemptNo, state, selection, retry })
      failure = undefined
      break
    } catch (error) {
      failure = error
      if (error instanceof IngestConfigError) break
      const classification = error instanceof FetchFailure ? error.classification : classifyFailure(error, env.signal, stream.classifyError)
      if (classification.kind === 'cancelled') {
        outcome = env.hostSignal.aborted ? 'cancelled' : 'budget_exhausted'
        // Exhausting the budget is an incomplete result, not a failure: committed progress stands.
        if (outcome === 'budget_exhausted') failure = undefined
        break
      }
      // A FetchFailure already exhausted its fine-grained retries; an opaque
      // iterator failure gets coarse reader recreation from the last checkpoint.
      if (error instanceof FetchFailure || classification.kind === 'permanent' || attemptNo === readerAttempts) break
      const retryDelay = Math.min(retry.maxTimeout ?? DEFAULT_RETRY.maxTimeout, (retry.minTimeout ?? DEFAULT_RETRY.minTimeout) * 2 ** (attemptNo - 1))
      await append(input, 'retry_scheduled', { workId, attemptNo, retryAt: new Date(env.now().getTime() + retryDelay), errorClass: classification.kind, detail: { error: messageOf(error) } })
      await env.sleep(retryDelay, env.signal)
    }
  }

  await append(input, 'work_finished', {
    workId,
    workState: failure === undefined ? outcome : outcome === 'cancelled' ? 'cancelled' : 'failed',
    errorClass: failure === undefined ? '' : failureKind(failure, env.signal, stream),
    detail: { rows: progress.rows, batches: progress.batches, chunks: progress.chunks, error: failure === undefined ? undefined : messageOf(failure) },
  })
  if (failure !== undefined) throw failure
  return outcome
}

/**
 * Pull the reader through a finite buffer into the loader. Exactly one next()
 * is pending at a time, and source progress is appended to the journal only
 * after the covering rows have sink evidence.
 */
async function readAndLoad(input: {
  stream: AnyStreamDefinition
  namespaceId: string
  runId: string
  cutoff: Date
  permits: PipelinePermits
  progress: StreamProgress
  env: ResolvedEnv
  workId: string
  attemptNo: number
  state: unknown
  selection: unknown
  retry: ReturnType<typeof mergeRetry>
}): Promise<StreamOutcome> {
  const { stream, namespaceId, progress, env } = input
  const local = new AbortController()
  const signal = AbortSignal.any([env.signal, local.signal])
  const queue = createBoundedQueue<PendingBatch>(env.prefetchBatches)
  const batchSize = stream.batchSize ?? DEFAULT_BATCH_SIZE
  let budgetExhausted = false

  const produce = async () => {
    let pending = emptyBatch()
    const reader = stream.read({
      streamId: stream.id,
      selection: input.selection,
      state: input.state,
      cutoff: input.cutoff,
      signal,
      attempt: (operation, options) =>
        runAttempt(operation, options?.label ?? 'source', input.retry, {
          signal,
          fetchPermits: input.permits.fetches,
          classifier: stream.classifyError,
          sleep: env.sleep,
          random: env.random,
          now: () => env.now().getTime(),
          onAttempt: () => undefined,
          onRetry: ({ label, context }) =>
            append(input, 'retry_scheduled', {
              workId: input.workId,
              attemptNo: input.attemptNo,
              retryAt: new Date(env.now().getTime() + context.retryDelay),
              errorClass: context.error.classification.kind,
              detail: { label, sourceAttempt: context.attemptNumber, error: context.error.message },
            }),
        }),
    })

    // Iterate by hand so a hung next() can be abandoned on abort; return() still
    // runs on every exit so the reader's finally blocks own cursor cleanup.
    const iterator = reader[Symbol.asyncIterator]()
    const maxChunkRows = stream.budget?.maxChunkRows ?? DEFAULT_MAX_CHUNK_ROWS
    try {
      while (!budgetExhausted) {
        const step = await abortable(iterator.next(), signal)
        if (step.done) break
        const chunk: unknown = step.value
        assertValidChunk(stream.id, chunk, maxChunkRows)
        progress.chunks += 1
        pending.rows.push(...chunk.rows)
        if (pending.intervalIds) {
          if (chunk.id === undefined) pending.intervalIds = undefined
          else pending.intervalIds.push(chunk.id)
        }
        if (chunk.state !== undefined) pending.state = { value: chunk.state }
        if (pending.rows.length >= batchSize) {
          await queue.push(pending, signal)
          pending = emptyBatch()
        }
        if (stream.budget?.maxChunks !== undefined && progress.chunks >= stream.budget.maxChunks) budgetExhausted = true
      }
    } finally {
      // Never await an uncooperative reader: cleanup is best effort once we leave.
      void Promise.resolve(iterator.return?.()).catch(() => undefined)
    }

    // Only a fully consumed selection may claim the strategy's completion state.
    if (!budgetExhausted) {
      const completed: unknown = stream.incremental.complete?.({ state: input.state, selection: input.selection })
      if (completed !== undefined) pending.state = { value: completed }
    }
    if (pending.rows.length > 0 || pending.state !== undefined) await queue.push(pending, signal)
    queue.close()
  }

  const consume = async () => {
    // Batch identity is anchored to the last durable boundary: the committed
    // checkpoint version plus the batch's position since that version, so a
    // replay in a fresh process reproduces the same id and deduplication token.
    // Declared source-interval ids complete the identity; without them a
    // content hash does, preferring a possible duplicate over suppressing rows
    // that changed between attempts.
    let sinceBoundary = 0
    for (let batch = await queue.pop(signal); batch !== undefined; batch = await queue.pop(signal)) {
      const discriminator = batch.intervalIds ? `interval:${canonicalJson(batch.intervalIds)}` : `content:${canonicalJson(batch.rows)}`
      const batchId = digest([namespaceId, String(progress.version), String(sinceBoundary), discriminator]).slice(0, 32)
      const receipt = await loadBatch(input, batchId, batch.rows, signal)
      const envelope: CheckpointEnvelope | undefined = batch.state
        ? { strategy: stream.incremental.id, version: stream.incremental.version, state: batch.state.value }
        : progress.envelope
      const advanced = canonicalJson(envelope ?? null) !== canonicalJson(progress.envelope ?? null)
      const expected = progress.version
      const version = advanced ? expected + 1 : expected
      await append(input, 'batch_committed', {
        workId: input.workId,
        attemptNo: input.attemptNo,
        batchId,
        expectedCheckpointVersion: expected,
        checkpointVersion: version,
        checkpoint: envelope,
        sinkEvidence: receipt.evidence,
        detail: { rows: receipt.rows, writeUnits: receipt.writeUnits },
      })
      sinceBoundary = advanced ? 0 : sinceBoundary + 1
      progress.version = version
      progress.envelope = envelope
      progress.rows += receipt.rows
      progress.batches += 1
    }
  }

  // The first failure is the root cause; the sibling only fails because of the
  // induced abort, so it must not mask what actually went wrong.
  let rootCause: { error: unknown } | undefined
  const settled = Promise.allSettled(
    [produce(), consume()].map((task) =>
      task.catch((error: unknown) => {
        rootCause ??= { error }
        local.abort(error)
      })
    )
  )
  // After a failure, a source operation that ignores its signal must not pin
  // the stream (and its permits) forever.
  await Promise.race([settled, graceAfterAbort(signal, READER_SHUTDOWN_GRACE_MS)])
  if (rootCause) throw rootCause.error
  if (budgetExhausted) {
    env.log?.(`${namespaceId}: ${new BudgetExhausted('execution budget exhausted; committed progress is preserved').message}`)
    return 'budget_exhausted'
  }
  return 'succeeded'
}

// A fresh Loader instance per attempt. An ambiguous acknowledgement replays the
// same stable batch identity and accepts a possible duplicate over data loss.
async function loadBatch(
  input: { stream: AnyStreamDefinition; runId: string; permits: PipelinePermits; env: ResolvedEnv },
  batchId: string,
  rows: readonly Row[],
  signal: AbortSignal
): Promise<SinkReceipt> {
  const factory = input.stream.loader ?? simpleLoader()
  return tracer.startActiveSpan('chkit.ingest.load', async (span) => {
    span.setAttribute('chkit.ingest.batch_id', batchId)
    span.setAttribute('chkit.ingest.rows', rows.length)
    try {
      for (let attempt = 1; ; attempt += 1) {
        // The load permit covers only the active write, never the backoff timer.
        const release = await input.permits.loads.acquire(signal)
        const loader = factory({
          streamId: input.stream.id,
          runId: input.runId,
          table: input.stream.destination,
          destination: input.env.destination,
          signal,
        })
        try {
          await loader.write({ batchId, rows })
          return await loader.finalize()
        } catch (error) {
          // A cleanup failure must not replace the write failure that decides the retry.
          await loader.abort(error).catch((cleanupError: unknown) => {
            span.recordException(cleanupError instanceof Error ? cleanupError : new Error(String(cleanupError)))
          })
          if (signal.aborted || isAbortError(error) || attempt >= LOAD_ATTEMPTS) throw error
        } finally {
          release()
        }
        await input.env.sleep(1000 * 2 ** (attempt - 1), signal)
      }
    } catch (error) {
      recordFailure(span, error)
      throw error
    } finally {
      span.end()
    }
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

// Appends for one namespace are serialized and the sequence number is taken
// only when the write starts, so a fact that never lands cannot leave a gap.
// An ambiguous failure retries the exact same deterministic fact.
function append(
  input: { namespaceId: string; runId: string; progress: StreamProgress; env: ResolvedEnv },
  eventKind: JournalEvent['eventKind'],
  fields: Partial<Omit<JournalEvent, 'namespaceId' | 'eventSeq' | 'eventKind' | 'runId'>>
): Promise<void> {
  const { progress, env } = input
  const write = progress.appendChain.then(async () => {
    const event: JournalEvent = {
      namespaceId: input.namespaceId,
      eventSeq: progress.seq + 1,
      eventKind,
      runId: input.runId,
      workId: fields.workId ?? '',
      attemptNo: fields.attemptNo ?? 0,
      batchId: fields.batchId ?? '',
      expectedCheckpointVersion: fields.expectedCheckpointVersion ?? progress.version,
      checkpointVersion: fields.checkpointVersion ?? progress.version,
      checkpoint: fields.checkpoint,
      workState: fields.workState ?? '',
      sinkEvidence: fields.sinkEvidence ?? '',
      retryAt: fields.retryAt,
      errorClass: fields.errorClass ?? '',
      detail: fields.detail ?? {},
    }
    for (let attempt = 1; ; attempt += 1) {
      try {
        await env.journal.append(event)
        progress.seq = event.eventSeq
        return
      } catch (error) {
        if (attempt >= JOURNAL_APPEND_ATTEMPTS) throw error
        // Terminal facts must still land after cancellation, so this wait ignores the run signal.
        await env.sleep(250 * 2 ** (attempt - 1), NEVER_ABORTED)
      }
    }
  })
  progress.appendChain = write.catch(() => undefined)
  return write
}

function runEvent(seq: number, eventKind: 'run_started' | 'run_finished', runId: string, workState: JournalEvent['workState'], detail: Record<string, unknown>): JournalEvent {
  return {
    namespaceId: RUN_NAMESPACE,
    eventSeq: seq,
    eventKind,
    runId,
    workId: runId,
    attemptNo: 0,
    batchId: '',
    expectedCheckpointVersion: 0,
    checkpointVersion: 0,
    checkpoint: undefined,
    workState,
    sinkEvidence: '',
    retryAt: undefined,
    errorClass: '',
    detail,
  }
}

function assertValidChunk(
  streamId: string,
  chunk: unknown,
  maxChunkRows: number
): asserts chunk is { rows: readonly Row[]; state?: unknown; id?: string } {
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

/** Resolves a fixed grace period after the signal aborts; never resolves otherwise. */
function graceAfterAbort(signal: AbortSignal, graceMs: number): Promise<void> {
  return new Promise((resolve) => {
    const start = () => {
      const timer = setTimeout(resolve, graceMs)
      if (typeof timer === 'object' && 'unref' in timer) timer.unref()
    }
    if (signal.aborted) start()
    else signal.addEventListener('abort', start, { once: true })
  })
}

/** Settle with the promise, or reject as soon as the signal aborts. */
function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason)
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason)
    signal.addEventListener('abort', onAbort, { once: true })
    promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', onAbort))
  })
}

function permitsFor(cache: Map<string, PipelinePermits>, pipeline: PipelineDefinition): PipelinePermits {
  const existing = cache.get(pipeline.id)
  if (existing) return existing
  const created: PipelinePermits = {
    streams: createSemaphore(pipeline.maxStreams),
    fetches: createSemaphore(pipeline.maxFetches),
    loads: createSemaphore(pipeline.maxLoads),
  }
  cache.set(pipeline.id, created)
  return created
}

const NEVER_ABORTED = new AbortController().signal

function resolveEnv(input: ExecutionEnv, deadlineSignal: AbortSignal): ResolvedEnv {
  const now = input.now ?? (() => new Date())
  const maxDurationMs = input.maxDurationMs ?? DEFAULT_MAX_DURATION_MS
  return {
    journal: input.journal,
    destination: input.destination,
    signal: AbortSignal.any([input.signal ?? NEVER_ABORTED, deadlineSignal]),
    hostSignal: input.signal ?? NEVER_ABORTED,
    maxDurationMs,
    prefetchBatches: input.prefetchBatches ?? DEFAULT_PREFETCH_BATCHES,
    now,
    sleep: input.sleep ?? sleep,
    random: input.random ?? Math.random,
    log: input.log ?? (() => undefined),
  }
}

function failureKind(error: unknown, signal: AbortSignal, stream: AnyStreamDefinition): string {
  if (error instanceof IngestConfigError) return 'config'
  if (error instanceof FetchFailure) return error.classification.kind
  return classifyFailure(error, signal, stream.classifyError).kind
}

function recordFailure(span: Span, error: unknown): void {
  span.setStatus({ code: SpanStatusCode.ERROR, message: messageOf(error) })
  if (error instanceof Error) span.recordException(error)
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
