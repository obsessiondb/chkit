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
  signal: AbortSignal
  deadline: number
}

interface PipelinePermits {
  streams: Semaphore
  fetches: Semaphore
  loads: Semaphore
}

interface PendingBatch {
  rows: Row[]
  /** Candidate provider state that becomes safe once these rows have sink evidence. */
  state: { value: unknown } | undefined
}

interface StreamProgress {
  seq: number
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
  const env = resolveEnv(input)
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
  const progress: StreamProgress = { seq: 0, version: 0, envelope: undefined, rows: 0, batches: 0, chunks: 0 }
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
      const outcome: StreamOutcome = env.signal.aborted ? 'cancelled' : 'failed'
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
        outcome = 'cancelled'
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
    let pending: PendingBatch = { rows: [], state: undefined }
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

    // for-await calls iterator.return() on every early exit, so the reader's
    // own finally blocks own cursor and connection cleanup.
    for await (const chunk of reader) {
      signal.throwIfAborted()
      assertValidChunk(stream.id, chunk)
      progress.chunks += 1
      pending.rows.push(...chunk.rows)
      if (chunk.state !== undefined) pending.state = { value: chunk.state }
      if (pending.rows.length >= batchSize) {
        await queue.push(pending, signal)
        pending = { rows: [], state: undefined }
      }
      if (stream.budget?.maxChunks !== undefined && progress.chunks >= stream.budget.maxChunks) budgetExhausted = true
      if (env.now().getTime() >= env.deadline) budgetExhausted = true
      if (budgetExhausted) break
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
    // checkpoint version plus the batch's position since that version. A replay
    // after a crash starts from that same boundary, so identical rows reproduce
    // the identical id (and deduplication token) even in a fresh process.
    let sinceBoundary = 0
    for (let batch = await queue.pop(signal); batch !== undefined; batch = await queue.pop(signal)) {
      const batchId = digest([namespaceId, String(progress.version), String(sinceBoundary), canonicalJson(batch.rows)]).slice(0, 32)
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
  await Promise.allSettled(
    [produce(), consume()].map((task) =>
      task.catch((error: unknown) => {
        rootCause ??= { error }
        local.abort(error)
      })
    )
  )
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
  const release = await input.permits.loads.acquire(signal)
  try {
    return await tracer.startActiveSpan('chkit.ingest.load', async (span) => {
      span.setAttribute('chkit.ingest.batch_id', batchId)
      span.setAttribute('chkit.ingest.rows', rows.length)
      try {
        for (let attempt = 1; ; attempt += 1) {
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
            await loader.abort(error)
            if (signal.aborted || isAbortError(error) || attempt >= LOAD_ATTEMPTS) throw error
            await input.env.sleep(1000 * 2 ** (attempt - 1), signal)
          }
        }
      } catch (error) {
        recordFailure(span, error)
        throw error
      } finally {
        span.end()
      }
    })
  } finally {
    release()
  }
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

async function append(
  input: { namespaceId: string; runId: string; progress: StreamProgress; env: ResolvedEnv },
  eventKind: JournalEvent['eventKind'],
  fields: Partial<Omit<JournalEvent, 'namespaceId' | 'eventSeq' | 'eventKind' | 'runId'>>
): Promise<void> {
  input.progress.seq += 1
  await input.env.journal.append({
    namespaceId: input.namespaceId,
    eventSeq: input.progress.seq,
    eventKind,
    runId: input.runId,
    workId: fields.workId ?? '',
    attemptNo: fields.attemptNo ?? 0,
    batchId: fields.batchId ?? '',
    expectedCheckpointVersion: fields.expectedCheckpointVersion ?? input.progress.version,
    checkpointVersion: fields.checkpointVersion ?? input.progress.version,
    checkpoint: fields.checkpoint,
    workState: fields.workState ?? '',
    sinkEvidence: fields.sinkEvidence ?? '',
    retryAt: fields.retryAt,
    errorClass: fields.errorClass ?? '',
    detail: fields.detail ?? {},
  })
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

function assertValidChunk(streamId: string, chunk: unknown): asserts chunk is { rows: readonly Row[]; state?: unknown } {
  if (typeof chunk !== 'object' || chunk === null || !('rows' in chunk) || !Array.isArray(chunk.rows)) {
    throw new IngestConfigError(`Stream "${streamId}" yielded a chunk without a "rows" array.`)
  }
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

function resolveEnv(input: ExecutionEnv): ResolvedEnv {
  const now = input.now ?? (() => new Date())
  const maxDurationMs = input.maxDurationMs ?? DEFAULT_MAX_DURATION_MS
  return {
    journal: input.journal,
    destination: input.destination,
    signal: input.signal ?? new AbortController().signal,
    maxDurationMs,
    prefetchBatches: input.prefetchBatches ?? DEFAULT_PREFETCH_BATCHES,
    now,
    sleep: input.sleep ?? sleep,
    random: input.random ?? Math.random,
    log: input.log ?? (() => undefined),
    deadline: now().getTime() + maxDurationMs,
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
