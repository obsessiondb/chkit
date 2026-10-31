import type { TableDefinition } from '@chkit/core'

import { IngestConfigError } from './errors.js'
import { fullSync } from './incremental.js'
import type {
  AnyStreamDefinition,
  ErrorClassifier,
  IncrementalStrategy,
  LoaderFactory,
  PipelineDefinition,
  ReadContext,
  RetryOptions,
  Row,
  SourceChunk,
  StreamBudget,
  StreamDefinition,
} from './types.js'

const STREAM_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.:-]*$/
/** Prefixes of the tags every stream derives from its own and its pipeline's id. */
const DERIVED_TAG_PREFIXES = ['stream:', 'pipeline:']

export interface StreamInput<TRow extends Row, TState, TSelection> {
  id: string
  destination: TableDefinition
  tags?: readonly string[]
  incremental: IncrementalStrategy<TState, TSelection>
  read: (context: ReadContext<TSelection, TState>) => AsyncIterable<SourceChunk<TRow, TState>>
  loader?: LoaderFactory
  retry?: RetryOptions
  batchSize?: number
  budget?: StreamBudget
  classifyError?: ErrorClassifier
}

export interface FullSyncStreamInput<TRow extends Row>
  extends Omit<StreamInput<TRow, undefined, undefined>, 'incremental'> {
  incremental?: undefined
}

export interface PipelineInput {
  id: string
  tags?: readonly string[]
  streams: readonly AnyStreamDefinition[]
  maxStreams?: number
  maxFetches?: number
  maxLoads?: number
  retry?: RetryOptions
}

export interface SelectedStream {
  stream: AnyStreamDefinition
  pipeline: PipelineDefinition
  effectiveTags: readonly string[]
}

export function defineStream<TRow extends Row>(input: FullSyncStreamInput<TRow>): StreamDefinition<TRow, undefined, undefined>
export function defineStream<TRow extends Row, TState, TSelection>(
  input: StreamInput<TRow, TState, TSelection>
): StreamDefinition<TRow, TState, TSelection>
export function defineStream(
  input: StreamInput<Row, unknown, unknown> | FullSyncStreamInput<Row>
): AnyStreamDefinition {
  assertValidId('stream', input.id)
  const scope = `Stream "${input.id}"`
  const destination: unknown = input.destination
  if (typeof destination !== 'object' || destination === null || !('kind' in destination) || destination.kind !== 'table') {
    throw new IngestConfigError(`${scope}: destination must be a table definition.`)
  }
  if (typeof input.read !== 'function') throw new IngestConfigError(`${scope}: read must be a function returning an async iterable.`)
  assertPositiveInteger(scope, 'batchSize', input.batchSize)
  assertPositiveInteger(scope, 'budget.maxChunks', input.budget?.maxChunks)
  assertPositiveInteger(scope, 'budget.maxChunkRows', input.budget?.maxChunkRows)
  assertRetryOptions(scope, input.retry)
  return {
    kind: 'ingest_stream',
    id: input.id,
    destination: input.destination,
    tags: declaredTags(scope, input.tags),
    incremental: input.incremental ?? fullSync(),
    read: input.read,
    loader: input.loader,
    retry: input.retry,
    batchSize: input.batchSize,
    budget: input.budget,
    classifyError: input.classifyError,
  }
}

/**
 * Define a non-durable named group of streams. Pipeline identity never
 * participates in checkpoint or batch identity, so moving a stream between
 * pipelines does not reset its state.
 */
export function definePipeline(input: PipelineInput): PipelineDefinition {
  assertValidId('pipeline', input.id)
  const scope = `Pipeline "${input.id}"`
  const streams: unknown = input.streams
  if (!Array.isArray(streams)) throw new IngestConfigError(`${scope}: streams must be an array of defineStream(...) values.`)
  for (const stream of streams) {
    if (typeof stream !== 'object' || stream === null || !('kind' in stream) || stream.kind !== 'ingest_stream') {
      throw new IngestConfigError(`${scope}: streams must contain only defineStream(...) values.`)
    }
  }
  assertRetryOptions(scope, input.retry)
  const pipeline: PipelineDefinition = {
    kind: 'ingest_pipeline',
    id: input.id,
    tags: declaredTags(scope, input.tags),
    streams: [...input.streams],
    maxStreams: positiveCeiling(input.id, 'maxStreams', input.maxStreams, 4),
    maxFetches: positiveCeiling(input.id, 'maxFetches', input.maxFetches, 4),
    maxLoads: positiveCeiling(input.id, 'maxLoads', input.maxLoads, 2),
    retry: input.retry,
  }

  const seen = new Set<string>()
  for (const stream of pipeline.streams) {
    if (seen.has(stream.id)) {
      throw new IngestConfigError(`Pipeline "${pipeline.id}" lists stream "${stream.id}" more than once.`)
    }
    seen.add(stream.id)
  }

  return pipeline
}

/** Validate identities within this graph, without process-wide registration. */
function validatePipelines(pipelines: readonly PipelineDefinition[]): void {
  const ids = new Set<string>()
  const owners = new Map<string, string>()
  for (const pipeline of pipelines) {
    if (ids.has(pipeline.id)) throw new IngestConfigError(`Duplicate pipeline id "${pipeline.id}".`)
    ids.add(pipeline.id)
    for (const stream of pipeline.streams) {
      const owner = owners.get(stream.id)
      if (owner !== undefined) {
        throw new IngestConfigError(
          `Stream id "${stream.id}" occurs in pipelines "${owner}" and "${pipeline.id}". Stream ids must be globally unique.`
        )
      }
      owners.set(stream.id, pipeline.id)
    }
  }
}

/** Only exported pipeline values participate; aliases of the same value count once. */
export function collectPipelines(modules: readonly Record<string, unknown>[]): PipelineDefinition[] {
  const pipelines = [...new Set(modules.flatMap((mod) => Object.values(mod).filter(
    (value): value is PipelineDefinition => typeof value === 'object' && value !== null && 'kind' in value && value.kind === 'ingest_pipeline'
  )))]
  validatePipelines(pipelines)
  return pipelines
}

/**
 * Repeated exact case-sensitive tags with AND semantics over the union of
 * pipeline and stream tags plus derived `pipeline:<id>` and `stream:<id>`.
 * No filter selects the complete graph; an explicit empty selection throws.
 */
export function selectStreams(pipelines: readonly PipelineDefinition[], tags: readonly string[]): SelectedStream[] {
  validatePipelines(pipelines)
  const wanted = dedupe(tags)
  const all: SelectedStream[] = pipelines.flatMap((pipeline) =>
    pipeline.streams.map((stream) => ({
      stream,
      pipeline,
      effectiveTags: dedupe([...pipeline.tags, ...stream.tags, `pipeline:${pipeline.id}`, `stream:${stream.id}`]),
    }))
  )
  if (wanted.length === 0) return all

  const selected = all.filter((entry) => wanted.every((tag) => entry.effectiveTags.includes(tag)))
  if (selected.length === 0) {
    throw new IngestConfigError(
      `No stream matches every requested tag: ${wanted.map((tag) => `--tag ${tag}`).join(' ')}. Nothing was executed.`
    )
  }
  return selected
}

function assertValidId(kind: 'stream' | 'pipeline', id: unknown): asserts id is string {
  if (typeof id !== 'string' || !STREAM_ID_PATTERN.test(id)) {
    throw new IngestConfigError(
      `Invalid ${kind} id ${JSON.stringify(id)}. Use letters, digits, "_", ".", ":" or "-", starting with a letter or digit.`
    )
  }
}

/**
 * Declared tags are exact strings. The `stream:` and `pipeline:` prefixes are
 * derived from ids at selection time, so a declared one could make `--tag
 * stream:<id>` select more than that stream.
 */
function declaredTags(scope: string, tags: unknown): string[] {
  if (tags === undefined) return []
  if (!Array.isArray(tags) || tags.some((tag) => typeof tag !== 'string' || tag.length === 0)) {
    throw new IngestConfigError(`${scope}: tags must be an array of non-empty strings.`)
  }
  const reserved = tags.find((tag) => DERIVED_TAG_PREFIXES.some((prefix) => tag.startsWith(prefix)))
  if (reserved !== undefined) {
    throw new IngestConfigError(
      `${scope}: tag "${reserved}" uses a reserved prefix; "stream:<id>" and "pipeline:<id>" are derived from the ids.`
    )
  }
  return dedupe(tags)
}

function positiveCeiling(pipelineId: string, name: string, value: number | undefined, fallback: number): number {
  if (value === undefined) return fallback
  assertPositiveInteger(`Pipeline "${pipelineId}"`, name, value)
  return value
}

function assertPositiveInteger(scope: string, name: string, value: unknown): void {
  if (value !== undefined && (!Number.isInteger(value) || (value as number) <= 0)) {
    throw new IngestConfigError(`${scope}: ${name} must be a positive integer.`)
  }
}

function assertRetryOptions(scope: string, retry: RetryOptions | undefined): void {
  if (retry === undefined) return
  const retries: unknown = retry.retries
  if (retries !== undefined && retries !== Number.POSITIVE_INFINITY && (!Number.isInteger(retries) || (retries as number) < 0)) {
    throw new IngestConfigError(`${scope}: retry.retries must be a non-negative integer or Infinity.`)
  }
  for (const name of ['factor', 'minTimeout', 'maxTimeout', 'maxRetryTime'] as const) {
    const value: unknown = retry[name]
    if (value !== undefined && (typeof value !== 'number' || !Number.isFinite(value) || value < 0) && !((name === 'maxTimeout' || name === 'maxRetryTime') && value === Number.POSITIVE_INFINITY)) {
      throw new IngestConfigError(`${scope}: retry.${name} must be a non-negative number.`)
    }
  }
}

function dedupe(values: readonly string[]): string[] {
  return [...new Set(values)]
}
