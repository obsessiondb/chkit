import { describe, expect, test } from 'bun:test'

import {
  applyOnClusterToPlan,
  canonicalizeDefinitions,
  planDiff,
  table,
  toCreateSQL,
  validateDefinitions,
  type SkipIndexDefinition,
  type TableConstraintDefinition,
  type TableInput,
} from './index.js'

function vectors(overrides: Partial<TableInput> = {}) {
  return table({
    database: 'app',
    name: 'vectors',
    columns: [
      { name: 'id', type: 'UInt64' },
      { name: 'embedding', type: 'Array(Float32)' },
    ],
    engine: 'MergeTree()',
    orderBy: ['id'],
    ...overrides,
  })
}

function issueCodes(def: ReturnType<typeof vectors>): string[] {
  return validateDefinitions([def]).map((issue) => issue.code)
}

const hnsw: SkipIndexDefinition = {
  name: 'embedding_hnsw',
  expression: 'embedding',
  type: 'vector_similarity',
  method: 'hnsw',
  distanceFunction: 'cosineDistance',
  dimensions: 512,
}

describe('vector_similarity skip indexes', () => {
  test('renders the three-argument form with the per-part default granularity', () => {
    const sql = toCreateSQL(vectors({ indexes: [hnsw] }))
    expect(sql).toContain(
      "INDEX `embedding_hnsw` (embedding) TYPE vector_similarity('hnsw', 'cosineDistance', 512) GRANULARITY 100000000"
    )
  })

  test('renders HNSW tuning arguments and an explicit granularity', () => {
    const sql = toCreateSQL(vectors({
      indexes: [{
        ...hnsw,
        distanceFunction: 'L2Distance',
        dimensions: 4,
        quantization: 'bf16',
        hnswMaxConnectionsPerLayer: 32,
        hnswCandidateListSizeForConstruction: 128,
        granularity: 1000,
      }],
    }))
    expect(sql).toContain(
      "TYPE vector_similarity('hnsw', 'L2Distance', 4, 'bf16', 32, 128) GRANULARITY 1000"
    )
  })

  test('omits dimensions for servers older than 25.4', () => {
    const { dimensions: _dimensions, ...legacy } = hnsw as Extract<SkipIndexDefinition, { type: 'vector_similarity' }>
    const sql = toCreateSQL(vectors({
      indexes: [{ ...legacy, quantization: 'f32', hnswMaxConnectionsPerLayer: 16, hnswCandidateListSizeForConstruction: 64 }],
    }))
    expect(sql).toContain("TYPE vector_similarity('hnsw', 'cosineDistance', 'f32', 16, 64)")
  })

  test.each([
    [{ distanceFunction: 'innerProduct' }, 'distanceFunction must be one of L2Distance, cosineDistance, dotProduct'],
    [{ method: 'ivf' }, 'method must be one of hnsw'],
    [{ dimensions: 0 }, 'dimensions must be a positive integer'],
    [{ quantization: 'bf16' }, 'set all three or none'],
    [{ quantization: 'f8', hnswMaxConnectionsPerLayer: 16, hnswCandidateListSizeForConstruction: 64 }, 'quantization must be one of'],
    [{ quantization: 'f32', hnswMaxConnectionsPerLayer: 1, hnswCandidateListSizeForConstruction: 64 }, 'at least 2'],
    [{ distanceFunction: 'L2Distance', quantization: 'b1', hnswMaxConnectionsPerLayer: 16, hnswCandidateListSizeForConstruction: 64 }, "requires distanceFunction 'cosineDistance'"],
    [{ dimensions: 12, quantization: 'b1', hnswMaxConnectionsPerLayer: 16, hnswCandidateListSizeForConstruction: 64 }, 'multiple of 8'],
    [{ granularity: 0 }, 'granularity must be a positive integer'],
  ])('rejects %j', (override, message) => {
    const issues = validateDefinitions([vectors({ indexes: [{ ...hnsw, ...override } as SkipIndexDefinition] })])
    expect(issues.map((issue) => issue.code)).toEqual(['vector_index_invalid_parameters'])
    expect(issues[0]?.message).toContain(message)
  })

  test('a changed vector index is dropped and re-added', () => {
    const plan = planDiff(
      [vectors({ indexes: [hnsw] })],
      [vectors({ indexes: [{ ...hnsw, distanceFunction: 'L2Distance' }] })]
    )
    expect(plan.operations.map((op) => [op.type, op.risk])).toEqual([
      ['alter_table_drop_index', 'caution'],
      ['alter_table_add_index', 'caution'],
    ])
    expect(plan.operations[1]?.sql).toBe(
      "ALTER TABLE app.vectors ADD INDEX IF NOT EXISTS `embedding_hnsw` (embedding) TYPE vector_similarity('hnsw', 'L2Distance', 512) GRANULARITY 100000000;"
    )
  })

  test('an omitted granularity equals the explicit default', () => {
    const plan = planDiff(
      [vectors({ indexes: [hnsw] })],
      [vectors({ indexes: [{ ...hnsw, granularity: 100_000_000 }] })]
    )
    expect(plan.operations).toEqual([])
  })
})

describe('raw skip indexes', () => {
  test('render the type verbatim', () => {
    const sql = toCreateSQL(vectors({
      columns: [{ name: 'id', type: 'UInt64' }, { name: 's', type: 'String' }],
      indexes: [{ name: 'sg', expression: 's', type: 'raw', rawType: 'sparse_grams(3, 100, 512, 1, 3, 0)', granularity: 1 }],
    }))
    expect(sql).toContain('INDEX `sg` (s) TYPE sparse_grams(3, 100, 512, 1, 3, 0) GRANULARITY 1')
  })

  test('need a type', () => {
    expect(issueCodes(vectors({
      indexes: [{ name: 'sg', expression: 'id', type: 'raw', rawType: '  ', granularity: 1 }],
    }))).toEqual(['raw_index_invalid_type'])
  })
})

describe('table constraints', () => {
  const dimension: TableConstraintDefinition = { name: 'dimension', check: 'length(embedding) = 512' }
  const positive: TableConstraintDefinition = { name: 'positive-id', assume: 'id > 0' }

  test('render CHECK and ASSUME in CREATE TABLE after the indexes', () => {
    const sql = toCreateSQL(vectors({ indexes: [hnsw], constraints: [dimension, positive] }))
    expect(sql).toContain(
      "GRANULARITY 100000000,\n  CONSTRAINT `dimension` CHECK length(embedding) = 512,\n  CONSTRAINT `positive-id` ASSUME id > 0\n)"
    )
  })

  test('adding one is a caution ALTER with a warning', () => {
    const plan = planDiff([vectors()], [vectors({ constraints: [dimension, positive] })])
    expect(plan.operations.map((op) => [op.type, op.risk, op.sql])).toEqual([
      ['alter_table_add_constraint', 'caution', 'ALTER TABLE app.vectors ADD CONSTRAINT IF NOT EXISTS `dimension` CHECK length(embedding) = 512;'],
      ['alter_table_add_constraint', 'caution', 'ALTER TABLE app.vectors ADD CONSTRAINT IF NOT EXISTS `positive-id` ASSUME id > 0;'],
    ])
    expect(plan.operations[0]?.warning).toContain('does not validate existing rows')
    expect(plan.operations[1]?.warning).toContain('never validates it')
  })

  test('a changed expression or kind is dropped and re-added; a removed one is dropped', () => {
    const plan = planDiff(
      [vectors({ constraints: [dimension, positive] })],
      [vectors({ constraints: [{ name: 'dimension', assume: 'length(embedding) = 512' }] })]
    )
    expect(plan.operations.map((op) => op.sql)).toEqual([
      'ALTER TABLE app.vectors DROP CONSTRAINT IF EXISTS `dimension`;',
      'ALTER TABLE app.vectors DROP CONSTRAINT IF EXISTS `positive-id`;',
      'ALTER TABLE app.vectors ADD CONSTRAINT IF NOT EXISTS `dimension` ASSUME length(embedding) = 512;',
    ])
  })

  test('whitespace and comments in the expression are not a change', () => {
    const plan = planDiff(
      [vectors({ constraints: [dimension] })],
      [vectors({ constraints: [{ name: 'dimension', check: 'length(embedding)\n  = 512 -- dims' }] })]
    )
    expect(plan.operations).toEqual([])
  })

  test('a snapshot written before constraints existed plans nothing', () => {
    const [legacy] = canonicalizeDefinitions([vectors()])
    const stored = JSON.parse(JSON.stringify(legacy))
    expect('constraints' in stored).toBe(false)
    expect(planDiff([stored], [vectors({ constraints: [] })]).operations).toEqual([])
  })

  test('constraint and index drops run before the column drop they would block', () => {
    const plan = planDiff(
      [vectors({ indexes: [hnsw], constraints: [dimension] })],
      [vectors({ columns: [{ name: 'id', type: 'UInt64' }] })]
    )
    expect(plan.operations.map((op) => op.type)).toEqual([
      'alter_table_drop_constraint',
      'alter_table_drop_index',
      'alter_table_drop_column',
    ])
  })

  test('constraints are added after the column they read', () => {
    const plan = planDiff(
      [vectors({ columns: [{ name: 'id', type: 'UInt64' }] })],
      [vectors({ constraints: [dimension] })]
    )
    expect(plan.operations.map((op) => op.type)).toEqual([
      'alter_table_add_column',
      'alter_table_add_constraint',
    ])
  })

  test('constraint ALTERs get ON CLUSTER', () => {
    const plan = applyOnClusterToPlan(
      planDiff([vectors({ constraints: [positive] })], [vectors({ constraints: [dimension] })]),
      'test_cluster_2s'
    )
    expect(plan.operations.map((op) => op.sql)).toEqual([
      "ALTER TABLE app.vectors ON CLUSTER 'test_cluster_2s' DROP CONSTRAINT IF EXISTS `positive-id`;",
      "ALTER TABLE app.vectors ON CLUSTER 'test_cluster_2s' ADD CONSTRAINT IF NOT EXISTS `dimension` CHECK length(embedding) = 512;",
    ])
  })

  test.each([
    [[dimension, { name: 'dimension', check: 'id > 0' }], 'duplicate_constraint_name'],
    [[{ name: 'c', check: 'id > 0', assume: 'id > 0' }], 'constraint_invalid'],
    [[{ name: 'c' }], 'constraint_invalid'],
    [[{ name: 'c', check: ' -- nothing' }], 'constraint_invalid'],
  ])('rejects %j', (constraints, code) => {
    expect(issueCodes(vectors({ constraints: constraints as TableConstraintDefinition[] }))).toEqual([code])
  })

  test('Kafka tables reject constraints', () => {
    const def = table({
      database: 'app',
      name: 'queue',
      columns: [{ name: 'id', type: 'UInt64' }],
      engine: 'Kafka',
      orderBy: [],
      settings: { kafka_broker_list: 'b:9092', kafka_topic_list: 't', kafka_group_name: 'g', kafka_format: 'JSONEachRow' },
      constraints: [{ name: 'c', check: 'id > 0' }],
    })
    expect(validateDefinitions([def]).map((issue) => issue.code)).toEqual(['kafka_unsupported_clause'])
  })
})
