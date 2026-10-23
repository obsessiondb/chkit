import { describe, expect, test } from 'bun:test'

import { normalizeIndexFromSystemRow, parseConstraintsFromCreateTableQuery } from './index.js'

function indexRow(type: string, granularity = 1) {
  return { database: 'app', table: 'vectors', name: 'idx', expr: 'embedding', type, granularity }
}

describe('skip index introspection', () => {
  test.each([
    [
      "vector_similarity('hnsw', 'cosineDistance', 4)",
      { type: 'vector_similarity', method: 'hnsw', distanceFunction: 'cosineDistance', dimensions: 4 },
    ],
    [
      "vector_similarity('hnsw', 'L2Distance', 4, 'bf16', 32, 128)",
      {
        type: 'vector_similarity', method: 'hnsw', distanceFunction: 'L2Distance', dimensions: 4,
        quantization: 'bf16', hnswMaxConnectionsPerLayer: 32, hnswCandidateListSizeForConstruction: 128,
      },
    ],
    // ClickHouse 25.3 and older take no dimensions argument.
    ["vector_similarity('hnsw', 'L2Distance')", { type: 'vector_similarity', method: 'hnsw', distanceFunction: 'L2Distance' }],
    [
      "vector_similarity('hnsw', 'cosineDistance', 'f32', 16, 64)",
      {
        type: 'vector_similarity', method: 'hnsw', distanceFunction: 'cosineDistance',
        quantization: 'f32', hnswMaxConnectionsPerLayer: 16, hnswCandidateListSizeForConstruction: 64,
      },
    ],
  ])('reads %s as a structured vector index', (type, expected) => {
    expect(normalizeIndexFromSystemRow(indexRow(type, 100_000_000))).toEqual({
      name: 'idx', expression: 'embedding', granularity: 100_000_000, ...expected,
    })
  })

  test.each([
    'sparse_grams(3, 100, 512, 1, 3, 0)',
    "vector_similarity('hnsw', 'someFutureDistance', 4)",
    "vector_similarity('hnsw', 'L2Distance', 4, 'bf16')",
    'set',
    'tokenbf_v1(256, 2)',
    "text(tokenizer = 'splitByNonAlpha', some_future_parameter = 1)",
    'hypothesis',
  ])('keeps %s verbatim as a raw index instead of rewriting it', (type) => {
    expect(normalizeIndexFromSystemRow(indexRow(type))).toEqual({
      name: 'idx', expression: 'embedding', granularity: 1, type: 'raw', rawType: type,
    })
  })

  test('still reads the structured types', () => {
    expect(normalizeIndexFromSystemRow(indexRow('set(0)'))).toMatchObject({ type: 'set', maxRows: 0 })
    expect(normalizeIndexFromSystemRow(indexRow('bloom_filter'))).toMatchObject({ type: 'bloom_filter' })
    expect(normalizeIndexFromSystemRow(indexRow('bloom_filter(0.01)'))).toMatchObject({ falsePositiveRate: 0.01 })
    expect(normalizeIndexFromSystemRow(indexRow('ngrambf_v1(3, 256, 2, 0)'))).toMatchObject({
      type: 'ngrambf_v1', ngramSize: 3, sizeBytes: 256, hashFunctions: 2, randomSeed: 0,
    })
    expect(normalizeIndexFromSystemRow(indexRow('minmax'))).toMatchObject({ type: 'minmax' })
  })
})

describe('constraint introspection', () => {
  test('reads CHECK and ASSUME constraints as ClickHouse stores them', () => {
    const query =
      "CREATE TABLE app.vectors (`id` UInt64, `embedding` Array(Float32), `s` String, INDEX e embedding TYPE vector_similarity('hnsw', 'cosineDistance', 4) GRANULARITY 100000000, CONSTRAINT dimension CHECK length(embedding) = 4, CONSTRAINT `a-b` ASSUME id > 0, CONSTRAINT c3 CHECK (s IN ('a', 'b')) AND (((id + 1) * 2) > 0)) ENGINE = MergeTree ORDER BY id SETTINGS index_granularity = 8192"
    expect(parseConstraintsFromCreateTableQuery(query)).toEqual([
      { name: 'dimension', check: 'length(embedding) = 4' },
      { name: 'a-b', assume: 'id > 0' },
      { name: 'c3', check: "(s IN ('a', 'b')) AND (((id + 1) * 2) > 0)" },
    ])
  })

  test('reads the multi-line SHOW CREATE form', () => {
    const query = 'CREATE TABLE app.t\n(\n    `id` UInt64,\n    `s` String,\n    CONSTRAINT c CHECK length(s) > 0\n)\nENGINE = MergeTree\nORDER BY id'
    expect(parseConstraintsFromCreateTableQuery(query)).toEqual([{ name: 'c', check: 'length(s) > 0' }])
  })

  test('a table without constraints has none', () => {
    expect(parseConstraintsFromCreateTableQuery('CREATE TABLE app.t (`id` UInt64) ENGINE = MergeTree ORDER BY id')).toEqual([])
    expect(parseConstraintsFromCreateTableQuery(undefined)).toEqual([])
  })
})
