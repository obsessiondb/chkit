import { describe, expect, test } from 'bun:test'

import { extractMigrationMetadata } from '../../runtime/migration-metadata.js'

describe('extractMigrationMetadata', () => {
  test('reads a log line from the migration header', () => {
    const sql = [
      '-- chkit-migration-format: v1',
      '-- log: Loading 100M rows. Usually 3-5 min.',
      '-- generated-at: 2026-05-25T00:00:00Z',
      '',
      'INSERT INTO hits SELECT 1;',
    ].join('\n')
    expect(extractMigrationMetadata(sql)).toEqual({
      log: 'Loading 100M rows. Usually 3-5 min.',
    })
  })

  test('first log value wins when duplicated', () => {
    const sql = [
      '-- log: first',
      '-- log: second',
      '',
      'SELECT 1;',
    ].join('\n')
    expect(extractMigrationMetadata(sql).log).toBe('first')
  })

  test('tolerates blank lines and unrelated comment keys in the header', () => {
    const sql = [
      '-- chkit-migration-format: v1',
      '-- generated-at: 2026-05-25T00:00:00Z',
      '',
      '-- log: After a blank line still counts.',
      '-- operation: truncate_table key=table:default.hits risk=caution',
      'TRUNCATE TABLE default.hits;',
    ].join('\n')
    expect(extractMigrationMetadata(sql).log).toBe('After a blank line still counts.')
  })

  test('stops at the first non-comment, non-blank line', () => {
    const sql = [
      '-- chkit-migration-format: v1',
      'SELECT 1;',
      '-- log: too late, after SQL',
    ].join('\n')
    expect(extractMigrationMetadata(sql).log).toBeUndefined()
  })

  test('ignores unknown keys', () => {
    const sql = [
      '-- something-else: not parsed',
      '-- estimated-duration: 5m',
      '',
      'SELECT 1;',
    ].join('\n')
    expect(extractMigrationMetadata(sql)).toEqual({})
  })

  test('handles missing header gracefully', () => {
    expect(extractMigrationMetadata('SELECT 1;\n')).toEqual({})
  })

  test('handles key matching being case-insensitive', () => {
    const sql = '-- Log: capitalized\n\nSELECT 1;'
    expect(extractMigrationMetadata(sql).log).toBe('capitalized')
  })
})
