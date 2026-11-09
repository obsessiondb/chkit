import { describe, expect, test } from 'bun:test'

import { parseRefreshClause } from './view-parser.js'

// TS trims with String.prototype.trim and matches with JS \s, which skip
// \x1c-\x1f and \x85 (NEL) but take \ufeff (BOM). chkit-py's
// test_js_whitespace.py asserts the same (#637).
const BOM = '\ufeff'
const NEL = '\x85'
const FS = '\x1c'

describe('whitespace outside names is JavaScript whitespace', () => {
  test('REFRESH separated by JavaScript whitespace', () => {
    const query = `CREATE MATERIALIZED VIEW db.mv REFRESH${BOM}EVERY${BOM}1${BOM}HOUR${NEL} TO db.t AS SELECT 1`
    expect(parseRefreshClause(query)).toEqual({ every: '1 HOUR' })
  })
})
