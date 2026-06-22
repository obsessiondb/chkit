import { describe, expect, test } from 'bun:test'

import {
  collectDestructiveOperationMarkers,
  collectUnmarkedDestructiveStatements,
  extractExecutableStatements,
  extractMigrationOperationSummaries,
  migrationContainsDestructiveSql,
  scanDestructiveSqlStatements,
} from '../../runtime/safety-markers.js'

describe('extractExecutableStatements', () => {
  test('splits simple statement batches', () => {
    const sql = `
      CREATE TABLE app.events (id UInt64);
      ALTER TABLE app.events ADD COLUMN name String;
    `

    expect(extractExecutableStatements(sql)).toEqual([
      'CREATE TABLE app.events (id UInt64);',
      'ALTER TABLE app.events ADD COLUMN name String;',
    ])
  })

  test('does not split on semicolons inside quoted strings', () => {
    const sql = `
      INSERT INTO app.logs (message) VALUES ('first;second');
      INSERT INTO app.logs (message) VALUES ("third;fourth");
      INSERT INTO app.logs (message) VALUES ('it''s;fine');
    `

    expect(extractExecutableStatements(sql)).toEqual([
      "INSERT INTO app.logs (message) VALUES ('first;second');",
      'INSERT INTO app.logs (message) VALUES ("third;fourth");',
      "INSERT INTO app.logs (message) VALUES ('it''s;fine');",
    ])
  })

  test('does not split on semicolons in backtick identifiers or block comments', () => {
    const sql = `
      /* migration metadata ; keep as comment */
      ALTER TABLE app.events ADD COLUMN \`semi;name\` String;
      /* another ; comment */ ALTER TABLE app.events DROP COLUMN IF EXISTS old_col;
    `

    expect(extractExecutableStatements(sql)).toEqual([
      '/* migration metadata ; keep as comment */\n      ALTER TABLE app.events ADD COLUMN `semi;name` String;',
      '/* another ; comment */ ALTER TABLE app.events DROP COLUMN IF EXISTS old_col;',
    ])
  })

  test('extractMigrationOperationSummaries defaults mode to sync and beforeRetry to null', () => {
    const sql = `
      -- operation: create_table key=table:app.events risk=safe
      CREATE TABLE app.events (id UInt64) ENGINE = MergeTree() ORDER BY id;
    `

    expect(extractMigrationOperationSummaries(sql)).toEqual([
      {
        type: 'create_table',
        key: 'table:app.events',
        risk: 'safe',
        mode: 'sync',
        beforeRetry: null,
        summary: 'create_table key=table:app.events risk=safe',
      },
    ])
  })

  test('extractMigrationOperationSummaries parses mode=async', () => {
    const sql = `
      -- operation: load_table_data key=table:app.events risk=caution mode=async
      INSERT INTO app.events SELECT * FROM s3('https://example.com/file.parquet','Parquet');
    `

    expect(extractMigrationOperationSummaries(sql)).toEqual([
      {
        type: 'load_table_data',
        key: 'table:app.events',
        risk: 'caution',
        mode: 'async',
        beforeRetry: null,
        summary:
          'load_table_data key=table:app.events risk=caution mode=async',
      },
    ])
  })

  test('extractMigrationOperationSummaries parses before-retry SQL attached to an operation', () => {
    const sql = `
      -- operation: load_table_data key=table:app.events risk=caution mode=async
      -- before-retry: TRUNCATE TABLE app.events SETTINGS max_table_size_to_drop = 0;
      INSERT INTO app.events SELECT * FROM s3('…','Parquet');
    `

    const ops = extractMigrationOperationSummaries(sql)
    expect(ops).toHaveLength(1)
    expect(ops[0]?.beforeRetry).toBe(
      'TRUNCATE TABLE app.events SETTINGS max_table_size_to_drop = 0',
    )
  })

  test('extractMigrationOperationSummaries does not pick up before-retry separated by SQL', () => {
    const sql = `
      -- operation: load_table_data key=table:app.events risk=caution mode=async
      INSERT INTO app.events SELECT 1;
      -- before-retry: TRUNCATE TABLE app.events;
    `

    // The before-retry line comes AFTER an executable statement — that's
    // for a different (later) operation, not this one. This operation's
    // beforeRetry should be null.
    const ops = extractMigrationOperationSummaries(sql)
    expect(ops).toHaveLength(1)
    expect(ops[0]?.beforeRetry).toBeNull()
  })

  test('extractMigrationOperationSummaries handles mixed sync + async ops', () => {
    const sql = `
      -- operation: truncate_table key=table:app.events risk=caution
      TRUNCATE TABLE app.events;
      -- operation: load_table_data key=table:app.events risk=caution mode=async
      INSERT INTO app.events SELECT 1;
    `

    const ops = extractMigrationOperationSummaries(sql)
    expect(ops.map((op) => ({ type: op.type, mode: op.mode }))).toEqual([
      { type: 'truncate_table', mode: 'sync' },
      { type: 'load_table_data', mode: 'async' },
    ])
  })

  test('extractMigrationOperationSummaries treats unrecognized mode as sync (forward-compat)', () => {
    const sql = `
      -- operation: load_table_data key=table:app.events risk=caution mode=batched
      INSERT INTO app.events SELECT 1;
    `

    // Forward compat: a future mode value an older chkit doesn't know about
    // should fall back to sync execution rather than silently dropping the op.
    const ops = extractMigrationOperationSummaries(sql)
    expect(ops).toHaveLength(1)
    expect(ops[0]?.mode).toBe('sync')
  })

  test('ignores full-line comments while preserving executable statements', () => {
    const sql = `
      -- operation: alter_table_drop_column key=table:app.events:column:old_col risk=danger
      -- sql: ALTER TABLE app.events DROP COLUMN old_col;
      ALTER TABLE app.events DROP COLUMN IF EXISTS old_col;
    `

    expect(extractExecutableStatements(sql)).toEqual([
      'ALTER TABLE app.events DROP COLUMN IF EXISTS old_col;',
    ])
  })
})

describe('scanDestructiveSqlStatements (defense-in-depth for unmarked SQL)', () => {
  const cases: Array<[string, string, string]> = [
    ['drop table', 'DROP TABLE default.events;', 'drop_table'],
    ['drop table if exists', 'DROP TABLE IF EXISTS default.events;', 'drop_table'],
    ['alter drop column', 'ALTER TABLE default.events DROP COLUMN email;', 'alter_table_drop_column'],
    ['truncate', 'TRUNCATE TABLE default.events;', 'truncate_table'],
    ['drop view', 'DROP VIEW default.events_v;', 'drop_view'],
    ['drop materialized view', 'DROP MATERIALIZED VIEW default.events_mv;', 'drop_materialized_view'],
    ['detach', 'DETACH TABLE default.events;', 'detach'],
    ['drop database', 'DROP DATABASE analytics;', 'drop_database'],
  ]
  for (const [label, sql, type] of cases) {
    test(`flags ${label}`, () => {
      const found = scanDestructiveSqlStatements(sql)
      expect(found.map((f) => f.type)).toContain(type)
      expect(migrationContainsDestructiveSql(sql)).toBe(true)
    })
  }

  test('does NOT flag a commented-out destructive statement', () => {
    const sql = `-- DROP TABLE default.events;\n-- operation: create_table key=default.events risk=safe\nCREATE TABLE default.events (id UInt64) ENGINE = MergeTree ORDER BY id;`
    expect(scanDestructiveSqlStatements(sql)).toEqual([])
    expect(migrationContainsDestructiveSql(sql)).toBe(false)
  })

  test('does NOT flag a non-destructive migration', () => {
    const sql = `CREATE TABLE default.events (id UInt64) ENGINE = MergeTree ORDER BY id;\nINSERT INTO default.events SELECT * FROM s3('...');`
    expect(migrationContainsDestructiveSql(sql)).toBe(false)
  })

  test('does NOT flag the truncate() math function (only TRUNCATE TABLE/DATABASE statements)', () => {
    expect(migrationContainsDestructiveSql('INSERT INTO default.t SELECT truncate(value) AS v FROM default.s;')).toBe(false)
    expect(migrationContainsDestructiveSql('TRUNCATE TABLE default.events;')).toBe(true)
    expect(migrationContainsDestructiveSql('TRUNCATE DATABASE analytics;')).toBe(true)
  })

  test('synthesizes a danger marker (key + preview) for unmarked DROP COLUMN', () => {
    const sql = 'ALTER TABLE default.events DROP COLUMN email;'
    const markers = collectUnmarkedDestructiveStatements('20260101_handwritten.sql', sql)
    expect(markers).toHaveLength(1)
    const marker = markers[0]
    expect(marker?.type).toBe('alter_table_drop_column')
    expect(marker?.risk).toBe('danger')
    expect(marker?.key).toBe('default.events')
    expect(marker?.warningCode).toBe('drop_column_irreversible')
    expect(marker?.summary).toContain('DROP COLUMN')
  })
})

describe('collectDestructiveOperationMarkers table-recreate warning (#23)', () => {
  test('a drop+create of the same table gets the distinct recreate warning', () => {
    // What the planner emits for an engine/ORDER BY/PRIMARY KEY/PARTITION BY/
    // UNIQUE KEY change: drop_table then create_table for the SAME key.
    const sql = [
      '-- operation: drop_table key=table:default.events risk=danger',
      'DROP TABLE IF EXISTS default.events;',
      '-- operation: create_table key=table:default.events risk=safe',
      'CREATE TABLE default.events (id UInt64) ENGINE = MergeTree ORDER BY id;',
    ].join('\n')

    const markers = collectDestructiveOperationMarkers('20260101_recreate.sql', sql)
    expect(markers).toHaveLength(1)
    const marker = markers[0]
    expect(marker?.type).toBe('drop_table')
    expect(marker?.warningCode).toBe('table_recreate_data_loss')
    expect(marker?.impact).toContain('ALL ROWS')
  })

  test('a plain drop (no matching create) keeps the generic drop warning', () => {
    const sql = [
      '-- operation: drop_table key=table:default.old_events risk=danger',
      'DROP TABLE IF EXISTS default.old_events;',
    ].join('\n')

    const markers = collectDestructiveOperationMarkers('20260101_drop.sql', sql)
    expect(markers).toHaveLength(1)
    expect(markers[0]?.warningCode).toBe('drop_table_data_loss')
  })

  test('dropping one table while creating a different one is not a recreate', () => {
    const sql = [
      '-- operation: drop_table key=table:default.old_events risk=danger',
      'DROP TABLE IF EXISTS default.old_events;',
      '-- operation: create_table key=table:default.new_events risk=safe',
      'CREATE TABLE default.new_events (id UInt64) ENGINE = MergeTree ORDER BY id;',
    ].join('\n')

    const markers = collectDestructiveOperationMarkers('20260101_swap.sql', sql)
    expect(markers).toHaveLength(1)
    expect(markers[0]?.warningCode).toBe('drop_table_data_loss')
  })
})
