import { describe, expect, test } from 'bun:test'

import { parseDatafile } from './datafile.js'
import { translateDatasource } from './datasource.js'

function datasource(lines: string[]) {
  return translateDatasource(parseDatafile('datasources/t.datasource', lines.join('\n')), 'analytics')
}

const SCHEMA = ['SCHEMA >', '    `id` UInt64,', '    `ts` DateTime,', '    `ver` UInt64,', '    `deleted` UInt8,', '    `sign` Int8', '']

describe('translateDatasource', () => {
  test('builds the engine with the parameters Tinybird passes, in its order', () => {
    const engines: Array<[string[], string]> = [
      [['ENGINE "MergeTree"'], 'MergeTree()'],
      [['ENGINE "replacingmergetree"', 'ENGINE_IS_DELETED "deleted"', 'ENGINE_VER "ver"'], 'ReplacingMergeTree(ver, deleted)'],
      [['ENGINE "SummingMergeTree"', 'ENGINE_COLUMNS "ver"'], 'SummingMergeTree(ver)'],
      [['ENGINE "AggregatingMergeTree"'], 'AggregatingMergeTree()'],
      [['ENGINE "CollapsingMergeTree"', 'ENGINE_SIGN "sign"'], 'CollapsingMergeTree(sign)'],
      [['ENGINE "VersionedCollapsingMergeTree"', 'ENGINE_VERSION "ver"', 'ENGINE_SIGN "sign"'], 'VersionedCollapsingMergeTree(sign, ver)'],
    ]
    for (const [lines, engine] of engines) {
      const translated = datasource([...SCHEMA, ...lines, 'ENGINE_SORTING_KEY "id"'])
      expect(translated.ok && translated.value.engine).toBe(engine)
    }
  })

  test('maps keys, partition, TTL and settings', () => {
    const translated = datasource([
      ...SCHEMA,
      'ENGINE "MergeTree"',
      'ENGINE_PARTITION_KEY "toYear(ts)"',
      'ENGINE_SORTING_KEY "id, intHash32(ver), ts"',
      'ENGINE_PRIMARY_KEY "id"',
      'ENGINE_TTL "ts + toIntervalDay(1)"',
      "ENGINE_SETTINGS \"index_granularity = 1024, storage_policy = 'hot', min_bytes_for_wide_part = 0\"",
    ])
    expect(translated).toEqual({
      ok: true,
      value: {
        kind: 'table',
        database: 'analytics',
        name: 't',
        engine: 'MergeTree()',
        columns: [
          { name: 'id', type: 'UInt64' },
          { name: 'ts', type: 'DateTime' },
          { name: 'ver', type: 'UInt64' },
          { name: 'deleted', type: 'UInt8' },
          { name: 'sign', type: 'Int8' },
        ],
        orderBy: ['id', 'intHash32(ver)', 'ts'],
        primaryKey: ['id'],
        partitionBy: 'toYear(ts)',
        ttl: 'ts + toIntervalDay(1)',
        settings: { index_granularity: 1024, storage_policy: "'hot'", min_bytes_for_wide_part: 0 },
      },
      notes: [],
    })
  })

  test('a missing or tuple() sorting key and an empty partition key are no keys', () => {
    for (const sortingKey of [[], ['ENGINE_SORTING_KEY "tuple()"'], ['ENGINE_SORTING_KEY "(tuple())"']]) {
      const translated = datasource([...SCHEMA, 'ENGINE "MergeTree"', 'ENGINE_PARTITION_KEY ""', ...sortingKey])
      expect(translated.ok && [translated.value.orderBy, translated.value.primaryKey, translated.value.partitionBy]).toEqual([[], [], undefined])
    }
  })

  test('adds ttl_only_drop_parts = 1 where Tinybird does, unless the datafile sets it', () => {
    const base = [...SCHEMA, 'ENGINE "MergeTree"', 'ENGINE_PARTITION_KEY "toYYYYMM(ts)"', 'ENGINE_SORTING_KEY "id"', 'ENGINE_TTL "ts + toIntervalMonth(1)"']
    const added = datasource(base)
    expect(added.ok && added.value.settings).toEqual({ ttl_only_drop_parts: 1 })
    const kept = datasource([...base, 'ENGINE_SETTINGS "ttl_only_drop_parts = 0"'])
    expect(kept.ok && kept.value.settings).toEqual({ ttl_only_drop_parts: 0 })
    const unchecked = datasource([...SCHEMA, 'ENGINE "MergeTree"', 'ENGINE_PARTITION_KEY "toYear(ts)"', 'ENGINE_SORTING_KEY "id"', 'ENGINE_TTL "ts + toIntervalYear(1)"'])
    expect(unchecked.ok && unchecked.value.settings).toBeUndefined()
  })

  test('columns: Nullable, expression defaults, codecs, JSONPaths', () => {
    const translated = datasource([
      'SCHEMA >',
      '    `a` Nullable(String) `json:$.a`,',
      "    `b` String `json:$.b` DEFAULT 'x' CODEC(ZSTD(3)),",
      '    `c` DateTime64(3) DEFAULT now64(3) CODEC(Delta(8), ZSTD(1))',
      '',
      'ENGINE "MergeTree"',
    ])
    expect(translated.ok && translated.value.columns).toEqual([
      { name: 'a', type: 'String', nullable: true },
      { name: 'b', type: 'String', default: { expression: "'x'" }, codec: [{ kind: 'ZSTD', level: 3 }] },
      { name: 'c', type: 'DateTime64(3)', default: { expression: 'now64(3)' }, codec: [{ kind: 'Delta', size: 8 }, { kind: 'ZSTD', level: 1 }] },
    ])
    expect(translated.ok && translated.notes).toEqual(['2 JSONPath mappings (ingestion only, not part of the DDL)'])
  })

  test('reads INDEXES into structured skip indexes', () => {
    const translated = datasource([
      ...SCHEMA,
      'INDEXES >',
      '    INDEX idx_id id TYPE bloom_filter(0.01) GRANULARITY 4,',
      '    idx_ts toStartOfDay(ts) TYPE minmax',
      "    idx_ng lower(toString(ver)) TYPE ngrambf_v1(3, 256, 2, 0) GRANULARITY 1",
      '',
      'ENGINE "MergeTree"',
    ])
    expect(translated.ok && translated.value.indexes).toEqual([
      { name: 'idx_id', expression: 'id', granularity: 4, type: 'bloom_filter', falsePositiveRate: 0.01 },
      { name: 'idx_ts', expression: 'toStartOfDay(ts)', granularity: 1, type: 'minmax' },
      { name: 'idx_ng', expression: 'lower(toString(ver))', granularity: 1, type: 'ngrambf_v1', ngramSize: 3, sizeBytes: 256, hashFunctions: 2, randomSeed: 0 },
    ])
  })

  test('index names lose leading I, N, D, E and X, as Tinybird strips them', () => {
    const translated = datasource([
      ...SCHEMA,
      'INDEXES >',
      '    EXP_idx id TYPE bloom_filter(0.01) GRANULARITY 2',
      '    Idx_ts lower(toString(ts)) TYPE set(10)',
      '    INDEX Idx_kept ver TYPE minmax',
      '',
      'ENGINE "MergeTree"',
    ])
    expect(translated.ok && translated.value.indexes?.map((index) => index.name)).toEqual(['P_idx', 'dx_ts', 'Idx_kept'])
    expect(translated.ok && translated.notes).toEqual([
      'index EXP_idx is created as P_idx, as Tinybird strips leading I, N, D, E and X from index entries',
      'index Idx_ts is created as dx_ts, as Tinybird strips leading I, N, D, E and X from index entries',
    ])
  })

  test('a setting beyond 2^53 keeps its digits', () => {
    const translated = datasource([...SCHEMA, 'ENGINE "MergeTree"', 'ENGINE_SETTINGS "max_bytes_to_merge_at_max_space_in_pool = 18446744073709551615, merge_max_block_size = 8192"'])
    expect(translated.ok && translated.value.settings).toEqual({ max_bytes_to_merge_at_max_space_in_pool: '18446744073709551615', merge_max_block_size: 8192 })
  })

  test('Null takes no keys or settings', () => {
    const translated = datasource([...SCHEMA, 'ENGINE "Null"'])
    expect(translated.ok && translated.value).toMatchObject({ engine: 'Null()', orderBy: [], primaryKey: [] })
  })

  test('reports what does not translate', () => {
    expect(datasource(['ENGINE "MergeTree"'])).toEqual({ ok: false, reasons: ['the datasource has no SCHEMA'] })
    expect(datasource([...SCHEMA, 'ENGINE "Join"'])).toEqual({ ok: false, reasons: ['engine Join is not one Tinybird supports'] })
    expect(datasource([...SCHEMA, 'ENGINE "MergeTree"', 'ENGINE_SORTING_KEY "intHash32(id)"', 'ENGINE_SAMPLING_KEY "intHash32(id)"'])).toEqual({
      ok: false,
      reasons: ['ENGINE_SAMPLING_KEY (SAMPLE BY intHash32(id)): the chkit table DSL has no SAMPLE BY'],
    })
    expect(datasource([...SCHEMA, 'ENGINE "MergeTree"', 'ENGINE_TTL "ts + toIntervalDay($DAYS)"'])).toEqual({
      ok: false,
      reasons: ['ENGINE_TTL uses environment substitution ($DAYS), which the importer does not evaluate'],
    })
    expect(datasource(['SCHEMA >', '    `a` UInt8 MATERIALIZED 1', '', 'ENGINE "MergeTree"'])).toEqual({
      ok: false,
      reasons: ['SCHEMA: MATERIALIZED is not supported in Tinybird schemas'],
    })
    expect(datasource([...SCHEMA, 'INDEXES >', '    broken', '', 'ENGINE "MergeTree"'])).toEqual({
      ok: false,
      reasons: ['INDEXES: cannot read "broken" (expected name expr TYPE type [GRANULARITY n])'],
    })
  })

  test('notes connector settings, which are ingestion', () => {
    const translated = datasource([...SCHEMA, 'ENGINE "MergeTree"', 'KAFKA_CONNECTION_NAME kafka', 'KAFKA_TOPIC events'])
    expect(translated.ok && translated.notes).toEqual(['connector settings not translated (ingestion): KAFKA_CONNECTION_NAME, KAFKA_TOPIC'])
  })
})
