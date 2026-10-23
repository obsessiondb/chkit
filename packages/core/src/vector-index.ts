import type { VectorSimilaritySkipIndex } from './model-types.js'
import { normalizeSQLFragment } from './sql-normalizer.js'

/** ClickHouse's recommended granularity: one vector index per part. */
export const VECTOR_INDEX_GRANULARITY = 100_000_000

type VectorParams = Omit<VectorSimilaritySkipIndex, 'name' | 'expression' | 'granularity'>

// Accepted values, from MergeTreeIndexVectorSimilarity.cpp (ClickHouse 26.8).
const METHODS = ['hnsw'] as const satisfies readonly VectorParams['method'][]
const DISTANCE_FUNCTIONS = ['L2Distance', 'cosineDistance', 'dotProduct'] as const satisfies readonly VectorParams['distanceFunction'][]
const QUANTIZATIONS = ['f64', 'f32', 'f16', 'bf16', 'i8', 'b1'] as const satisfies readonly NonNullable<VectorParams['quantization']>[]
const TUNING_FIELDS = ['quantization', 'hnswMaxConnectionsPerLayer', 'hnswCandidateListSizeForConstruction'] as const

/**
 * Renders `vector_similarity(...)`, throwing on arguments ClickHouse rejects.
 * Arguments are positional: dimensions (ClickHouse 25.4+) follows the distance
 * function, and the three tuning arguments are all present or all absent.
 */
export function renderVectorIndexType(index: VectorParams & { granularity?: number }): string {
  assertVectorIndexParams(index)
  const args = [`'${index.method}'`, `'${index.distanceFunction}'`]
  if (index.dimensions !== undefined) args.push(String(index.dimensions))
  if (index.quantization !== undefined) {
    args.push(`'${index.quantization}'`, String(index.hnswMaxConnectionsPerLayer), String(index.hnswCandidateListSizeForConstruction))
  }
  return `vector_similarity(${args.join(', ')})`
}

/**
 * Parses the argument list of `vector_similarity(...)` as
 * `system.data_skipping_indices.type_full` reports it. Returns undefined for
 * any shape chkit cannot express (so the caller keeps it as a raw index).
 */
export function parseVectorIndexArgs(args: string): VectorParams | undefined {
  const parts = args.split(',').map((part) => part.trim())
  if (![2, 3, 5, 6].includes(parts.length)) return undefined
  const strings = parts.map((part) => part.match(/^'([^'\\]*)'$/)?.[1])
  const integers = parts.map((part) => (/^\d+$/.test(part) ? Number(part) : undefined))
  const [method, distanceFunction] = strings
  if (!isOneOf(METHODS, method) || !isOneOf(DISTANCE_FUNCTIONS, distanceFunction)) return undefined
  const params: VectorParams = { type: 'vector_similarity', method, distanceFunction }
  const hasDimensions = parts.length === 3 || parts.length === 6
  if (hasDimensions) {
    const dimensions = integers[2]
    if (dimensions === undefined) return undefined
    params.dimensions = dimensions
  }
  const tuningAt = hasDimensions ? 3 : 2
  if (parts.length > tuningAt) {
    const quantization = strings[tuningAt]
    const connections = integers[tuningAt + 1]
    const candidates = integers[tuningAt + 2]
    if (!isOneOf(QUANTIZATIONS, quantization) || connections === undefined || candidates === undefined) return undefined
    params.quantization = quantization
    params.hnswMaxConnectionsPerLayer = connections
    params.hnswCandidateListSizeForConstruction = candidates
  }
  return vectorIndexProblem(params) ? undefined : params
}

export function canonicalizeVectorIndex(index: VectorSimilaritySkipIndex): VectorSimilaritySkipIndex {
  return {
    name: index.name,
    expression: normalizeSQLFragment(index.expression),
    type: 'vector_similarity',
    method: index.method,
    distanceFunction: index.distanceFunction,
    ...(index.dimensions !== undefined ? { dimensions: index.dimensions } : {}),
    ...(index.quantization !== undefined
      ? {
          quantization: index.quantization,
          hnswMaxConnectionsPerLayer: index.hnswMaxConnectionsPerLayer,
          hnswCandidateListSizeForConstruction: index.hnswCandidateListSizeForConstruction,
        }
      : {}),
    granularity: vectorIndexGranularity(index),
  }
}

export function vectorIndexGranularity(index: Pick<VectorSimilaritySkipIndex, 'granularity'>): number {
  return index.granularity ?? VECTOR_INDEX_GRANULARITY
}

function assertVectorIndexParams(index: VectorParams & { granularity?: number }): void {
  const problem = vectorIndexProblem(index)
  if (problem) throw new Error(problem)
}

function vectorIndexProblem(index: VectorParams & { granularity?: number }): string | undefined {
  if (!isOneOf(METHODS, index.method)) return `method must be one of ${METHODS.join(', ')}`
  if (!isOneOf(DISTANCE_FUNCTIONS, index.distanceFunction)) {
    return `distanceFunction must be one of ${DISTANCE_FUNCTIONS.join(', ')}`
  }
  if (index.dimensions !== undefined && !isPositiveInteger(index.dimensions)) {
    return 'dimensions must be a positive integer'
  }
  const set = TUNING_FIELDS.filter((field) => index[field] !== undefined)
  if (set.length > 0 && set.length < TUNING_FIELDS.length) {
    return `${TUNING_FIELDS.join(', ')} are positional arguments: set all three or none`
  }
  if (index.quantization !== undefined) {
    if (!isOneOf(QUANTIZATIONS, index.quantization)) return `quantization must be one of ${QUANTIZATIONS.join(', ')}`
    const connections = index.hnswMaxConnectionsPerLayer
    if (!isNonNegativeInteger(connections) || connections === 1) {
      return 'hnswMaxConnectionsPerLayer must be 0 (library default) or an integer of at least 2'
    }
    if (!isNonNegativeInteger(index.hnswCandidateListSizeForConstruction)) {
      return 'hnswCandidateListSizeForConstruction must be a non-negative integer'
    }
    if (index.quantization === 'b1') {
      if (index.distanceFunction !== 'cosineDistance') return "quantization 'b1' requires distanceFunction 'cosineDistance'"
      if (index.dimensions !== undefined && index.dimensions % 8 !== 0) {
        return "quantization 'b1' requires dimensions to be a multiple of 8"
      }
    }
  }
  if (index.granularity !== undefined && !isPositiveInteger(index.granularity)) {
    return 'granularity must be a positive integer'
  }
  return undefined
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

function isOneOf<T extends string>(values: readonly T[], value: unknown): value is T {
  return typeof value === 'string' && values.some((item) => item === value)
}
