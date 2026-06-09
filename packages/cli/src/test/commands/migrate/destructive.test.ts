import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, test } from 'bun:test'

import { scanDestructive } from '../../../commands/migrate/destructive.js'

function withMigrations(files: Record<string, string>): { dir: string; names: string[] } {
  const dir = mkdtempSync(join(tmpdir(), 'chkit-destructive-'))
  for (const [name, sql] of Object.entries(files)) writeFileSync(join(dir, name), sql)
  return { dir, names: Object.keys(files) }
}

describe('scanDestructive (#2)', () => {
  test('flags a fully hand-written migration with destructive SQL and no markers', async () => {
    const { dir, names } = withMigrations({
      '001_handwritten.sql': 'ALTER TABLE default.events DROP COLUMN email;\n',
    })
    const scan = await scanDestructive(dir, names)
    expect(scan.migrations).toEqual(['001_handwritten.sql'])
    expect(scan.operations.map((o) => o.type)).toContain('alter_table_drop_column')
    rmSync(dir, { recursive: true, force: true })
  })

  test('flags a generated migration with a risk=danger marker', async () => {
    const { dir, names } = withMigrations({
      '002_drop.sql':
        '-- operation: drop_table key=table:default.events risk=danger\nDROP TABLE default.events;\n',
    })
    const scan = await scanDestructive(dir, names)
    expect(scan.migrations).toEqual(['002_drop.sql'])
    rmSync(dir, { recursive: true, force: true })
  })

  // Regression guard: a generated migration whose DROP the planner classified as
  // non-danger (e.g. a materialized-view recreate) carries operation markers, so
  // the raw SQL scan must NOT override the planner and block it.
  test('does NOT flag a markered migration whose DROP is planner-classified non-danger', async () => {
    const { dir, names } = withMigrations({
      '003_recreate_mv.sql':
        '-- operation: drop_materialized_view key=materialized_view:default.events_mv risk=caution\n' +
        'DROP VIEW default.events_mv;\n' +
        '-- operation: create_materialized_view key=materialized_view:default.events_mv risk=safe\n' +
        'CREATE MATERIALIZED VIEW default.events_mv TO default.t AS SELECT 1;\n',
    })
    const scan = await scanDestructive(dir, names)
    expect(scan.migrations).toEqual([])
    expect(scan.operations).toEqual([])
    rmSync(dir, { recursive: true, force: true })
  })
})
