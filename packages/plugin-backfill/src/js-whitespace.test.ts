import { describe, expect, test } from 'bun:test'

import { summarizeSql } from './logging.js'
import { parseByteSize } from './options.js'

// TS trims with String.prototype.trim and matches with JS \s, which skip
// \x1c-\x1f and \x85 (NEL) but take \ufeff (BOM). chkit-py's
// test_js_whitespace.py asserts the same (#637).
const BOM = '\ufeff'
const NEL = '\x85'
const FS = '\x1c'

describe('whitespace outside names is JavaScript whitespace', () => {
  test('options and SQL summaries', () => {
    expect(parseByteSize(`${BOM}10${BOM}M`)).toBe(10 * 1024 ** 2)
    expect(summarizeSql(`${BOM}SELECT${FS}1${BOM}`)).toBe(`SELECT${FS}1`)
  })
})
