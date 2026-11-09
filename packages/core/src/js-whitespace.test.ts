import { describe, expect, test } from 'bun:test'

import { canonicalizeDefinitions } from './canonical.js'
import { parseCodec } from './codec.js'
import { engineName } from './engine.js'
import { parseFlags } from './flags.js'
import { isKafkaEngine } from './kafka.js'
import { dictionary, materializedView, table } from './model.js'
import { stripWrappingParens } from './sql-scan.js'
import { isSyntheticEphemeralDefault, normalizeEngine, sqlExpressionFingerprint } from './sql-normalizer.js'
import { validateDefinitions } from './validate.js'

// TS trims with String.prototype.trim and matches with JS \s, which skip
// \x1c-\x1f and \x85 (NEL) but take \ufeff (BOM). chkit-py's
// test_js_whitespace.py asserts the same (#637).
const BOM = '\ufeff'
const NEL = '\x85'
const FS = '\x1c'

describe('whitespace outside names is JavaScript whitespace', () => {
  test('canonical refresh intervals', () => {
    const [mv] = canonicalizeDefinitions([
      materializedView({
        database: 'app',
        name: 'mv',
        to: { database: 'app', name: 't' },
        as: 'SELECT 1',
        refresh: { every: `${BOM}1${BOM}${BOM}hours${NEL}`, offset: `${FS}5${FS}minute` },
      }),
    ])
    expect(mv?.kind === 'materialized_view' ? mv.refresh : undefined).toEqual({
      every: `1 HOUR${NEL}`,
      offset: `${FS}5${FS}MINUTE`,
    })
  })

  test('engines', () => {
    expect([isKafkaEngine(`${BOM}Kafka()`), isKafkaEngine(`${NEL}Kafka()`)]).toEqual([true, false])
    expect([engineName(`${BOM}MergeTree()`), engineName(`${FS}MergeTree()`)]).toEqual(['MergeTree', ''])
    expect([
      normalizeEngine(`${BOM}SharedMergeTree${BOM}`),
      normalizeEngine(`${NEL}MergeTree`),
      normalizeEngine(`${BOM}Kafka('b:9092', ${BOM}'t'${BOM})`),
      normalizeEngine(`${BOM}Distributed(c, db, t)`),
    ]).toEqual(['MergeTree()', `${NEL}MergeTree()`, "Kafka('b:9092', 't')", "Distributed('c', 'db', 't')"])
  })

  test('expressions', () => {
    expect(stripWrappingParens(`(${BOM}a${NEL})`)).toBe(`a${NEL}`)
    expect(isSyntheticEphemeralDefault(`${BOM}defaultValueOfTypeName('UInt8')`)).toBe(true)
    expect(isSyntheticEphemeralDefault(`defaultValueOfTypeName${FS}('UInt8')`)).toBe(false)
    expect(sqlExpressionFingerprint(`a${BOM}+${BOM}b`)).toBe(sqlExpressionFingerprint('a + b'))
    expect(sqlExpressionFingerprint(`a${FS}+b`)).not.toBe(sqlExpressionFingerprint('a + b'))
    expect(parseCodec(`CODEC${BOM}(ZSTD(1))`)).toEqual(parseCodec('CODEC(ZSTD(1))'))
    expect(parseCodec(`CODEC${NEL}(ZSTD(1))`)).not.toEqual(parseCodec('CODEC(ZSTD(1))'))
  })

  test('validation', () => {
    const issues = validateDefinitions([
      dictionary({
        database: 'app',
        name: 'd',
        attributes: [{ name: 'k', type: 'UInt64' }],
        primaryKey: ['k'],
        source: BOM,
        layout: NEL,
        lifetime: '300',
      }),
      table({
        database: 'app',
        name: 'k',
        engine: 'Kafka()',
        columns: [{ name: 'v', type: 'String' }],
        settings: {
          kafka_broker_list: BOM,
          kafka_topic_list: NEL,
          kafka_group_name: 'g',
          kafka_format: 'JSONEachRow',
        },
      }),
      materializedView({
        database: 'app',
        name: 'mv1',
        to: { database: 'app', name: 't' },
        as: 'SELECT 1',
        refresh: { every: `1${FS}HOUR` },
      }),
      materializedView({
        database: 'app',
        name: 'mv2',
        to: { database: 'app', name: 't' },
        as: 'SELECT 1',
        refresh: { every: `1${BOM}HOUR` },
      }),
    ])
    expect(issues.map((issue) => issue.code)).toEqual([
      'dictionary_missing_source',
      'kafka_missing_setting',
      'refresh_interval_format',
    ])
    expect(issues[1]?.message).toContain('kafka_broker_list')
    expect(issues[2]?.message).toContain('app.mv1')
  })

  test('string[] flag values', () => {
    const flags = parseFlags(['--table', `${BOM}a,${NEL}b`], [{ name: '--table', type: 'string[]' }] as const)
    expect(flags['--table']).toEqual(['a', `${NEL}b`])
  })
})
