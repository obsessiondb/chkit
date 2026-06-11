import { describe, expect, test } from 'bun:test'

import { previewStatement, statementError } from '../commands/migrate/apply.js'

describe('previewStatement / statementError (#10)', () => {
  test('previewStatement collapses whitespace to one line', () => {
    expect(previewStatement('  ALTER TABLE x\n   ADD COLUMN   y UInt64  ')).toBe(
      'ALTER TABLE x ADD COLUMN y UInt64',
    )
  })

  test('previewStatement caps length with an ellipsis', () => {
    const long = `SELECT ${'a'.repeat(200)}`
    const preview = previewStatement(long)
    expect(preview.length).toBe(121) // 120 chars + the ellipsis
    expect(preview.endsWith('…')).toBe(true)
  })

  test('statementError reports file, statement position, SQL preview, and the original message', () => {
    const err = statementError({
      file: '20260101000000_x.sql',
      index: 1,
      total: 3,
      statement: 'ALTER TABLE app.events ADD COLUMN bad NotARealType',
      error: new Error('Unknown data type family: NotARealType'),
    })
    expect(err.message).toContain('Migration 20260101000000_x.sql failed at statement 2 of 3')
    expect(err.message).toContain('ALTER TABLE app.events ADD COLUMN bad NotARealType')
    expect(err.message).toContain('Unknown data type family: NotARealType')
  })
})
