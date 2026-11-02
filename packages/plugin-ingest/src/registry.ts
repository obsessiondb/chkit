import type { TableDefinition } from '@chkit/core'

import { fullSync } from './incremental.js'
import type {
  AnyStreamDefinition,
  IncrementalStrategy,
  LoaderFactory,
  PipelineDefinition,
  ReadContext,
  Row,
  SourceChunk,
  StreamBudget,
  StreamDefinition,
} from './types.js'

const STREAM_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.:-]*$/
/** Prefixes of the tags every stream derives from its own and its pipeline's id. */
const DERIVED_TAG_PREFIXES = ['stream:', 'pipeline:']
const DEFAULT_LIMITS = { maxStreams: 4, maxFetches: 4, maxLoads: 2 }

export interface StreamInput<TRow extends Row, TState, TSelection> {
  id: string
  destination: TableDefinition
  tags?: readonly string[]
  incremental: IncrementalStrategy<TState, TSelection>
  read: (context: ReadContext<TSelection, TState>) => AsyncIterable<SourceChunk<TRow, TState>>
  loader?: LoaderFactory
  batchSize?: number
  budget?: StreamBudget
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
  return {
    kind: 'ingest_stream',
    id: input.id,
    destination: input.destination,
    tags: input.tags ?? [],
    incremental: input.incremental ?? fullSync(),
    read: input.read,
    loader: input.loader,
    batchSize: input.batchSize,
    budget: input.budget,
  }
}

/**
 * Define a non-durable named group of streams. Pipeline identity never
 * participates in checkpoint or batch identity, so moving a stream between
 * pipelines does not reset its state.
 */
export function definePipeline(input: PipelineInput): PipelineDefinition {
  return {
    kind: 'ingest_pipeline',
    id: input.id,
    tags: input.tags ?? [],
    streams: input.streams,
    maxStreams: input.maxStreams ?? DEFAULT_LIMITS.maxStreams,
    maxFetches: input.maxFetches ?? DEFAULT_LIMITS.maxFetches,
    maxLoads: input.maxLoads ?? DEFAULT_LIMITS.maxLoads,
  }
}

/** Validate identities within this graph, without process-wide registration. */
function validatePipelines(pipelines: readonly PipelineDefinition[]): void {
  const ids = new Set<string>()
  const owners = new Map<string, string>()
  for (const pipeline of pipelines) {
    assertSelectable(pipeline)
    if (ids.has(pipeline.id)) throw new Error(`Duplicate pipeline id "${pipeline.id}".`)
    ids.add(pipeline.id)
    for (const stream of pipeline.streams) {
      const owner = owners.get(stream.id)
      if (owner !== undefined) {
        throw new Error(
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
  const selected = all.filter((entry) => wanted.every((tag) => entry.effectiveTags.includes(tag)))
  if (wanted.length > 0 && selected.length === 0) {
    throw new Error(
      `No stream matches every requested tag: ${wanted.map((tag) => `--tag ${tag}`).join(' ')}. Nothing was executed.`
    )
  }
  const used = wanted.length === 0 ? pipelines : [...new Set(selected.map((entry) => entry.pipeline))]
  for (const pipeline of used) assertRunnable(pipeline)
  return selected
}

export function assertRunnable(pipeline: PipelineDefinition): void {
  assertSelectable(pipeline)
  const scope = `Pipeline "${pipeline.id}"`
  for (const name of ['maxStreams', 'maxFetches', 'maxLoads'] as const) assertPositiveInteger(scope, name, pipeline[name])
  for (const stream of pipeline.streams) assertRunnableStream(stream)
}

function assertSelectable(pipeline: PipelineDefinition): void {
  assertValidId('pipeline', pipeline.id)
  const scope = `Pipeline "${pipeline.id}"`
  assertDeclaredTags(scope, pipeline.tags)
  const streams: unknown = pipeline.streams
  if (!Array.isArray(streams)) throw new Error(`${scope}: streams must be an array of defineStream(...) values.`)
  if (!streams.every(isStreamDefinition)) throw new Error(`${scope}: streams must contain only defineStream(...) values.`)
  const seen = new Set<string>()
  for (const stream of streams) {
    assertValidId('stream', stream.id)
    assertDeclaredTags(`Stream "${stream.id}"`, stream.tags)
    if (seen.has(stream.id)) throw new Error(`${scope} lists stream "${stream.id}" more than once.`)
    seen.add(stream.id)
  }
}

function assertRunnableStream(stream: AnyStreamDefinition): void {
  const scope = `Stream "${stream.id}"`
  const destination: unknown = stream.destination
  if (typeof destination !== 'object' || destination === null || !('kind' in destination) || destination.kind !== 'table') {
    throw new Error(`${scope}: destination must be a table definition.`)
  }
  if (typeof stream.read !== 'function') throw new Error(`${scope}: read must be a function returning an async iterable.`)
  assertPositiveInteger(scope, 'batchSize', stream.batchSize)
  assertPositiveInteger(scope, 'budget.maxChunks', stream.budget?.maxChunks)
  assertPositiveInteger(scope, 'budget.maxChunkRows', stream.budget?.maxChunkRows)
}

function assertValidId(kind: 'stream' | 'pipeline', id: unknown): asserts id is string {
  if (typeof id !== 'string' || !STREAM_ID_PATTERN.test(id)) {
    throw new Error(
      `Invalid ${kind} id ${JSON.stringify(id)}. Use letters, digits, "_", ".", ":" or "-", starting with a letter or digit.`
    )
  }
}

/**
 * Declared tags are exact strings. The `stream:` and `pipeline:` prefixes are
 * derived from ids at selection time, so a declared one could make `--tag
 * stream:<id>` select more than that stream.
 */
function assertDeclaredTags(scope: string, tags: unknown): void {
  if (!Array.isArray(tags) || tags.some((tag) => typeof tag !== 'string' || tag.length === 0)) {
    throw new Error(`${scope}: tags must be an array of non-empty strings.`)
  }
  const reserved = tags.find((tag) => DERIVED_TAG_PREFIXES.some((prefix) => tag.startsWith(prefix)))
  if (reserved !== undefined) {
    throw new Error(
      `${scope}: tag "${reserved}" uses a reserved prefix; "stream:<id>" and "pipeline:<id>" are derived from the ids.`
    )
  }
}

function isStreamDefinition(value: unknown): value is AnyStreamDefinition {
  return typeof value === 'object' && value !== null && 'kind' in value && value.kind === 'ingest_stream'
}

function assertPositiveInteger(scope: string, name: string, value: unknown): void {
  if (value !== undefined && (!Number.isInteger(value) || (value as number) <= 0)) {
    throw new Error(`${scope}: ${name} must be a positive integer.`)
  }
}

function dedupe(values: readonly string[]): string[] {
  return [...new Set(values)]
}
