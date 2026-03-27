import { hashId } from '../state.js'

import { buildChunkBoundaries } from './build.js'
import { introspectTable, querySortKeyRanges } from './introspect.js'
import type { ChunkBoundary, PartitionInfo, PlannedChunk, SortKeyInfo } from './types.js'

export interface AnalyzeAndChunkInput {
  database: string
  table: string
  from?: string
  to?: string
  maxChunkBytes: number
  requireIdempotencyToken: boolean
  planId: string
  query: <T>(sql: string) => Promise<T[]>
}

export interface AnalyzeAndChunkResult {
  partitions: PartitionInfo[]
  sortKey?: SortKeyInfo
  chunks: PlannedChunk[]
}

export async function analyzeAndChunk(input: AnalyzeAndChunkInput): Promise<AnalyzeAndChunkResult> {
  const { partitions, sortKey, boundaries } = await analyzeTable({
    database: input.database,
    table: input.table,
    from: input.from,
    to: input.to,
    maxChunkBytes: input.maxChunkBytes,
    query: input.query,
  })

  const chunks = buildPlannedChunks({
    planId: input.planId,
    partitions,
    boundaries,
    requireIdempotencyToken: input.requireIdempotencyToken,
  })

  return { partitions, sortKey, chunks }
}

export interface AnalyzeTableInput {
  database: string
  table: string
  from?: string
  to?: string
  maxChunkBytes: number
  query: <T>(sql: string) => Promise<T[]>
}

export interface AnalyzeTableResult {
  partitions: PartitionInfo[]
  sortKey?: SortKeyInfo
  boundaries: ChunkBoundary[]
}

export async function analyzeTable(input: AnalyzeTableInput): Promise<AnalyzeTableResult> {
  const { partitions, sortKey } = await introspectTable({
    database: input.database,
    table: input.table,
    from: input.from,
    to: input.to,
    query: input.query,
  })

  const oversizedPartitionIds = partitions
    .filter(p => p.bytesOnDisk > input.maxChunkBytes)
    .map(p => p.partitionId)

  let sortKeyRanges: Map<string, { min: string; max: string }> | undefined
  if (sortKey && oversizedPartitionIds.length > 0) {
    sortKeyRanges = await querySortKeyRanges({
      database: input.database,
      table: input.table,
      sortKeyColumn: sortKey.column,
      partitionIds: oversizedPartitionIds,
      query: input.query,
    })
  }

  const boundaries = buildChunkBoundaries({
    partitions,
    maxChunkBytes: input.maxChunkBytes,
    sortKey,
    sortKeyRanges,
  })

  return { partitions, sortKey, boundaries }
}

export function buildPlannedChunks(input: {
  planId: string
  partitions: PartitionInfo[]
  boundaries: ChunkBoundary[]
  requireIdempotencyToken: boolean
}): PlannedChunk[] {
  const chunks: PlannedChunk[] = []
  const partitionIndex = new Map<string, number>()

  for (const boundary of input.boundaries) {
    const idx = partitionIndex.get(boundary.partitionId) ?? 0
    partitionIndex.set(boundary.partitionId, idx + 1)

    const idSeed = `${input.planId}:${boundary.partitionId}:${idx}`
    const chunkId = hashId(`chunk:${idSeed}`).slice(0, 16)
    const token = input.requireIdempotencyToken ? hashId(`token:${idSeed}`) : ''

    const partition = input.partitions.find(p => p.partitionId === boundary.partitionId)
    const from = boundary.sortKeyFrom ?? partition?.minTime ?? ''
    const to = boundary.sortKeyTo ?? partition?.maxTime ?? ''

    chunks.push({
      id: chunkId,
      partitionId: boundary.partitionId,
      sortKeyFrom: boundary.sortKeyFrom,
      sortKeyTo: boundary.sortKeyTo,
      estimatedBytes: boundary.estimatedBytes,
      idempotencyToken: token,
      from,
      to,
    })
  }

  return chunks
}
