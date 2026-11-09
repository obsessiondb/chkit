import { describe, expect, test } from 'bun:test'

import {
  parseDictionaryAttributesFromCreateDictionaryQuery,
  parseDictionaryRangeFromCreateDictionaryQuery,
  parseDictionarySettingsFromCreateDictionaryQuery,
  parseLifetimeFromCreateDictionaryQuery,
} from './create-dictionary-parser.js'
import {
  parseOrderByFromCreateTableQuery,
  parseProjectionsFromCreateTableQuery,
  parseSettingsFromCreateTableQuery,
} from './create-table-parser.js'
import { normalizeColumnFromSystemRow, normalizeIndexFromSystemRow } from './index.js'

// TS trims with String.prototype.trim and matches with JS \s, which skip
// \x1c-\x1f and \x85 (NEL) but take \ufeff (BOM). chkit-py's
// test_js_whitespace.py asserts the same (#637).
const BOM = '\ufeff'
const NEL = '\x85'
const FS = '\x1c'

describe('whitespace outside names is JavaScript whitespace', () => {
  test('SHOW CREATE DICTIONARY', () => {
    const query =
      `CREATE DICTIONARY app.d (\`k\` UInt64,${FS}\`v\` String${NEL}DEFAULT 'x') PRIMARY KEY k ` +
      `SOURCE(NULL()) LAYOUT(FLAT()) LIFETIME(${BOM}MIN 0 MAX 10${FS}) ` +
      `RANGE(MIN${BOM}lo MAX hi) SETTINGS(${BOM}max_threads = 1)`
    expect(parseDictionaryAttributesFromCreateDictionaryQuery(query)).toEqual([{ name: 'k', type: 'UInt64' }])
    expect(parseLifetimeFromCreateDictionaryQuery(query)).toBe(`MIN 0 MAX 10${FS}`)
    expect(parseDictionaryRangeFromCreateDictionaryQuery(query)).toEqual({ min: 'lo', max: 'hi' })
    expect(parseDictionarySettingsFromCreateDictionaryQuery(query)).toEqual({ max_threads: 1 })
  })

  test('SHOW CREATE TABLE', () => {
    const query =
      `CREATE TABLE app.t (\`id\` UInt64, PROJECTION${BOM}p (SELECT id ORDER BY id))` +
      `${BOM}ENGINE = MergeTree ORDER BY${BOM}id SETTINGS${BOM}index_granularity = 8192${BOM}`
    expect(parseProjectionsFromCreateTableQuery(query)).toEqual([{ name: 'p', query: 'SELECT id ORDER BY id' }])
    expect(parseOrderByFromCreateTableQuery(query)).toBe('id')
    expect(parseSettingsFromCreateTableQuery(query)).toEqual({ index_granularity: '8192' })
  })

  test('system tables', () => {
    const column = normalizeColumnFromSystemRow({
      database: 'app',
      table: 't',
      name: 'c',
      type: 'UInt8',
      position: 1,
      default_kind: 'DEFAULT',
      default_expression: `${BOM}1${NEL}`,
      comment: `${BOM}hi${NEL}`,
    })
    expect([column.default, column.comment]).toEqual([`1${NEL}`, `hi${NEL}`])
    const index = normalizeIndexFromSystemRow({
      database: 'app',
      table: 't',
      name: 'i',
      type: `minmax${BOM}`,
      expr: 'c',
      granularity: 1,
    })
    expect(index.type).toBe('minmax')
  })
})
