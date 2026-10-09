import { describe, expect, test } from 'bun:test'
import {
  canonicalizeDefinitions,
  materializedView,
  normalizeEngine,
  planDiff,
  table,
  toCreateSQL,
  validateDefinitions,
} from './index.js'
import { parseKafkaSetting, renderKafkaSetting } from './kafka.js'

const queue = () =>
  table({
    database: 'app',
    name: 'queue',
    engine: 'Kafka',
    columns: [{ name: 'id', type: 'String' }],
    settings: {
      kafka_broker_list: 'one:9092,two:9092',
      kafka_topic_list: 'events',
      kafka_group_name: 'consumer',
      kafka_format: 'JSONEachRow',
      kafka_num_consumers: 1,
    },
  })

describe('Kafka tables', () => {
  test('decodes ClickHouse hex/control escapes and preserves unknown escapes', () => {
    expect(parseKafkaSetting(String.raw`'\xC3\xA9\a\v\N\q\%'`)).toBe('é\u0007\v\\q\\%')
  })
  test('renders a queue without sorting clauses and with literal settings', () => {
    const sql = toCreateSQL(queue())
    expect(sql).not.toContain('PRIMARY KEY')
    expect(sql).not.toContain('ORDER BY')
    expect(sql).toContain("kafka_broker_list = 'one:9092,two:9092'")
    expect(sql).toContain('kafka_num_consumers = 1')
    expect(
      toCreateSQL({ ...queue(), settings: { ...queue().settings, kafka_commit_on_select: false } }),
    ).toContain('kafka_commit_on_select = 0')
  })

  test.each([
    "a'b",
    'a\\b\\',
    'a; b, SETTINGS COMMENT',
    'a\nb\tc',
    "'quoted'",
  ])('round-trips literal %j', (value) =>
    expect(parseKafkaSetting(renderKafkaSetting(value))).toBe(value))

  test('supports positional arguments and named collections', () => {
    expect(
      toCreateSQL(
        table({
          database: 'app',
          name: 'q',
          engine: "Kafka('b:9092', 'topic', 'group', 'JSONEachRow')",
          columns: [{ name: 'id', type: 'String' }],
        }),
      ),
    ).toContain('ENGINE = Kafka(')
    expect(
      toCreateSQL(
        table({
          database: 'app',
          name: 'q',
          engine: 'Kafka(kafka_config)',
          columns: [{ name: 'id', type: 'String' }],
        }),
      ),
    ).toContain('ENGINE = Kafka(kafka_config)')
    expect(normalizeEngine("Kafka( 'broker', 'a  b', 'c\\\\', 'JSONEachRow' )")).toBe(
      "Kafka('broker', 'a  b', 'c\\\\', 'JSONEachRow')",
    )
  })

  test('rejects invalid Kafka definitions at runtime', () => {
    expect(
      validateDefinitions([
        {
          ...queue(),
          primaryKey: ['id'],
          ttl: 'id',
          projections: [{ name: 'p', query: 'SELECT id' }],
        },
      ]).map((x) => x.code),
    ).toEqual(['kafka_unsupported_clause', 'kafka_unsupported_clause', 'kafka_unsupported_clause'])
    expect(
      validateDefinitions([
        { ...queue(), columns: [{ name: 'id', type: 'String', default: '' }] },
      ])[0]?.code,
    ).toBe('kafka_column_default')
    expect(
      validateDefinitions([
        { ...queue(), columns: [{ name: 'id', type: 'String', defaultKind: 'EPHEMERAL' }] },
      ])[0]?.code,
    ).toBe('kafka_column_default')
    expect(validateDefinitions([{ ...queue(), settings: {} }])).toHaveLength(4)
    expect(
      validateDefinitions([
        { ...queue(), settings: { ...queue().settings, kafka_auto_offset_reset: 'earliest' } },
      ])[0]?.code,
    ).toBe('kafka_invalid_setting')
    expect(
      validateDefinitions([
        { ...queue(), settings: { ...queue().settings, kafka_sasl_password: '[HIDDEN]' } },
      ])[0]?.code,
    ).toBe('kafka_invalid_setting')
  })

  test('preserves existing MergeTree key and raw-settings behavior', () => {
    const stored = table({
      database: 'app',
      name: 'stored',
      engine: 'MergeTree',
      columns: [{ name: 'id', type: 'String' }],
      primaryKey: ['id'],
      orderBy: ['id'],
      settings: { storage_policy: "'default'" },
    })
    expect(toCreateSQL(stored)).toContain("SETTINGS storage_policy = 'default'")
    expect(toCreateSQL(stored)).toContain('ORDER BY (`id`)')
    // @ts-expect-error MergeTree still requires keys at the public API boundary.
    table({ database: 'app', name: 't', engine: 'MergeTree', columns: [] })
  })

  test('creates queues before MVs and drops MVs before synchronously dropping queues', () => {
    const defs = [
      queue(),
      materializedView({
        database: 'app',
        name: 'mv',
        to: { database: 'app', name: 'stored' },
        as: 'SELECT id FROM app.queue',
      }),
    ]
    expect(planDiff([], defs).operations.map((x) => x.type)).toEqual([
      'create_database',
      'create_table',
      'create_materialized_view',
    ])
    const drops = planDiff(defs, []).operations
    expect(drops.map((x) => x.type)).toEqual(['drop_materialized_view', 'drop_table'])
    expect(drops[1]?.sql).toBe('DROP TABLE IF EXISTS app.queue SYNC;')
    expect(drops[1]?.risk).toBe('danger')
  })

  test('refuses unsupported ALTER and implicit engine replacement', () => {
    const original = queue()
    for (const updated of [
      { ...original, settings: { ...original.settings, kafka_num_consumers: 2 } },
      { ...original, settings: { ...original.settings, kafka_group_name: 'new-group' } },
      { ...original, columns: [...original.columns, { name: 'extra', type: 'String' }] },
      { ...original, columns: [{ name: 'renamed', type: 'String' }] },
      { ...original, engine: 'MergeTree', primaryKey: ['id'], orderBy: ['id'] },
    ])
      expect(() => planDiff([original], [updated])).toThrow('Schema validation failed')
  })

  test('no-op round trips tolerate numeric setting metadata and empty key normalization', () => {
    const original = queue()
    const pulled = {
      ...original,
      engine: 'Kafka()',
      settings: { ...original.settings, kafka_num_consumers: '1' },
    }
    expect(planDiff([original], [pulled]).operations).toEqual([])
    expect(planDiff(canonicalizeDefinitions([original]), [original]).operations).toEqual([])
  })
})
