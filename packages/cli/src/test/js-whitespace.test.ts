import { describe, expect, test } from 'bun:test'

import { previewStatement } from '../commands/migrate/apply.js'
import { normalizeMigrationName } from '../commands/migrate/recovery.js'
import { parseSettingFlags } from '../commands/migrate/settings.js'
import { extractMigrationMetadata } from '../runtime/migration-metadata.js'

// TS trims with String.prototype.trim and matches with JS \s, which skip
// \x1c-\x1f and \x85 (NEL) but take \ufeff (BOM). chkit-py's
// test_js_whitespace.py asserts the same (#637).
const BOM = '\ufeff'
const NEL = '\x85'
const FS = '\x1c'

describe('whitespace outside names is JavaScript whitespace', () => {
  test('migrate inputs', () => {
    expect(previewStatement(`${BOM}SELECT${FS}1${BOM}`)).toBe(`SELECT${FS}1`)
    expect(parseSettingFlags([`${BOM}max_threads=${BOM}2${NEL}`])).toEqual({ max_threads: `2${NEL}` })
    expect(extractMigrationMetadata(`${BOM}-- log:${BOM}hello${NEL}\nSELECT 1`)).toEqual({ log: `hello${NEL}` })
    expect(normalizeMigrationName(`${BOM}20260101_x${NEL}`, '--retry')).toBe(`20260101_x${NEL}.sql`)
  })
})
