import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, test } from 'bun:test'

import { findEmptyMigrations } from '../../../commands/migrate/empty.js'

describe('findEmptyMigrations', () => {
  test('returns the pending files that hold only comments or whitespace, in pending order', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'chkit-empty-'))
    const files: Record<string, string> = {
      '1_real.sql': 'CREATE TABLE db.t (id UInt64) ENGINE = MergeTree ORDER BY id;\n',
      '2_stub.sql': '-- chkit-migration-format: v1\n\n-- Empty migration scaffold. Write your SQL statements below.\n',
      '3_note.sql': '/* backfill goes here */\n',
      '4_blank.sql': '\n  \n',
      '5_trailing.sql': 'SELECT 1;\n/* done */\n',
    }
    await Promise.all(Object.entries(files).map(([name, sql]) => writeFile(join(dir, name), sql, 'utf8')))

    const empty = await findEmptyMigrations(dir, Object.keys(files)).finally(() =>
      rm(dir, { recursive: true, force: true }),
    )

    expect(empty).toEqual(['2_stub.sql', '3_note.sql', '4_blank.sql'])
  })
})
