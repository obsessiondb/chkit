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

// The registry lives on globalThis so that definePipeline calls made from a
// project entry reach the plugin even when the package is resolved twice
// (for example `source` vs `default` export conditions).
const REGISTRY_KEY = Symbol.for('chkit.ingest.registry')
const STREAM_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.:-]*$/

interface Registry {
  pipelines: Map<string, PipelineDefinition>
}

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
  if (input.batchSize !== undefined && (!Number.isInteger(input.batchSize) || input.batchSize <= 0)) {
    throw new IngestConfigError(`Stream "${input.id}": batchSize must be a positive integer.`)
  }
  return {
    kind: 'ingest_stream',
    id: input.id,
    destination: input.destination,
    tags: dedupe(input.tags ?? []),
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
 * Register a non-durable named group of streams. Pipeline identity never
 * participates in checkpoint or batch identity, so moving a stream between
 * pipelines does not reset its state.
 */
export function definePipeline(input: PipelineInput): PipelineDefinition {
  assertValidId('pipeline', input.id)
  const pipeline: PipelineDefinition = {
    kind: 'ingest_pipeline',
    id: input.id,
    tags: dedupe(input.tags ?? []),
    streams: [...input.streams],
    maxStreams: positiveCeiling(input.id, 'maxStreams', input.maxStreams, 4),
    maxFetches: positiveCeiling(input.id, 'maxFetches', input.maxFetches, 4),
    maxLoads: positiveCeiling(input.id, 'maxLoads', input.maxLoads, 2),
    retry: input.retry,
  }

  const registry = getRegistry()
  const owners = streamOwners(registry)
  for (const stream of pipeline.streams) {
    const owner = owners.get(stream.id)
    if (owner !== undefined && owner !== pipeline.id) {
      throw new IngestConfigError(
        `Stream id "${stream.id}" is registered by both pipeline "${owner}" and pipeline "${pipeline.id}". Stream ids must be globally unique.`
      )
    }
  }
  const seen = new Set<string>()
  for (const stream of pipeline.streams) {
    if (seen.has(stream.id)) {
      throw new IngestConfigError(`Pipeline "${pipeline.id}" lists stream "${stream.id}" more than once.`)
    }
    seen.add(stream.id)
  }

  registry.pipelines.set(pipeline.id, pipeline)
  return pipeline
}

export function listPipelines(): PipelineDefinition[] {
  return [...getRegistry().pipelines.values()]
}

export function resetRegistry(): void {
  getRegistry().pipelines.clear()
}

/**
 * Repeated exact case-sensitive tags with AND semantics over the union of
 * pipeline and stream tags plus derived `pipeline:<id>` and `stream:<id>`.
 * No filter selects the complete graph; an explicit empty selection throws.
 */
export function selectStreams(pipelines: readonly PipelineDefinition[], tags: readonly string[]): SelectedStream[] {
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

function getRegistry(): Registry {
  const holder = globalThis as { [REGISTRY_KEY]?: Registry }
  const existing = holder[REGISTRY_KEY]
  if (existing) return existing
  const created: Registry = { pipelines: new Map() }
  holder[REGISTRY_KEY] = created
  return created
}

function streamOwners(registry: Registry): Map<string, string> {
  const owners = new Map<string, string>()
  for (const pipeline of registry.pipelines.values()) {
    for (const stream of pipeline.streams) owners.set(stream.id, pipeline.id)
  }
  return owners
}

function assertValidId(kind: 'stream' | 'pipeline', id: string): void {
  if (!STREAM_ID_PATTERN.test(id)) {
    throw new IngestConfigError(
      `Invalid ${kind} id "${id}". Use letters, digits, "_", ".", ":" or "-", starting with a letter or digit.`
    )
  }
}

function positiveCeiling(pipelineId: string, name: string, value: number | undefined, fallback: number): number {
  if (value === undefined) return fallback
  if (!Number.isInteger(value) || value <= 0) {
    throw new IngestConfigError(`Pipeline "${pipelineId}": ${name} must be a positive integer.`)
  }
  return value
}

function dedupe(values: readonly string[]): string[] {
  return [...new Set(values)]
}
