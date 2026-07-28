import { describe, expect, test } from 'bun:test'

import { resolveConfig } from './model.js'
import type { MigrationOperation, MigrationPlan } from './model-types.js'
import { applyOnClusterToPlan, onClusterClause } from './on-cluster.js'

function op(type: MigrationOperation['type'], sql: string): MigrationOperation {
  return { type, key: 'k', risk: 'safe', sql }
}

function planOf(operations: MigrationOperation[]): MigrationPlan {
  return { operations, riskSummary: { safe: 0, caution: 0, danger: 0 }, renameSuggestions: [] }
}

describe('onClusterClause', () => {
  test('is empty when no cluster is configured', () => {
    expect(onClusterClause(undefined)).toBe('')
  })

  test('renders a single-quoted clause', () => {
    expect(onClusterClause('my_cluster')).toBe(" ON CLUSTER 'my_cluster'")
  })

  test('supports the macro form', () => {
    expect(onClusterClause('{cluster}')).toBe(" ON CLUSTER '{cluster}'")
  })
})

describe('applyOnClusterToPlan', () => {
  test('returns the plan unchanged when cluster is undefined', () => {
    const plan = planOf([op('drop_table', 'DROP TABLE IF EXISTS db.t;')])
    expect(applyOnClusterToPlan(plan, undefined)).toBe(plan)
  })

  test('injects ON CLUSTER after the object reference for every statement shape', () => {
    const plan = planOf([
      op('create_table', 'CREATE TABLE IF NOT EXISTS db.t\n(\n  `id` UInt64\n) ENGINE = MergeTree()\nORDER BY (`id`);'),
      op('create_view', 'CREATE VIEW IF NOT EXISTS db.v AS\nSELECT 1;'),
      op('create_materialized_view', 'CREATE MATERIALIZED VIEW IF NOT EXISTS db.mv TO db.t AS\nSELECT 1;'),
      op('create_materialized_view', 'CREATE MATERIALIZED VIEW IF NOT EXISTS db.mv\nREFRESH EVERY 1 HOUR TO db.t AS\nSELECT 1;'),
      op('create_database', 'CREATE DATABASE IF NOT EXISTS db;'),
      op('alter_table_add_column', 'ALTER TABLE db.t ADD COLUMN IF NOT EXISTS `c` String;'),
      op('alter_table_rename_column', 'ALTER TABLE db.t RENAME COLUMN IF EXISTS `a` TO `b`;'),
      op('alter_table_rename_table', 'RENAME TABLE IF EXISTS db.a TO db.b;'),
      op('drop_table', 'DROP TABLE IF EXISTS db.t;'),
      op('drop_materialized_view', 'DROP TABLE IF EXISTS db.mv SYNC;'),
      op('drop_view', 'DROP VIEW IF EXISTS db.v;'),
    ])

    const sql = applyOnClusterToPlan(plan, 'c').operations.map((o) => o.sql)

    expect(sql).toEqual([
      "CREATE TABLE IF NOT EXISTS db.t ON CLUSTER 'c'\n(\n  `id` UInt64\n) ENGINE = MergeTree()\nORDER BY (`id`);",
      "CREATE VIEW IF NOT EXISTS db.v ON CLUSTER 'c' AS\nSELECT 1;",
      "CREATE MATERIALIZED VIEW IF NOT EXISTS db.mv ON CLUSTER 'c' TO db.t AS\nSELECT 1;",
      "CREATE MATERIALIZED VIEW IF NOT EXISTS db.mv ON CLUSTER 'c'\nREFRESH EVERY 1 HOUR TO db.t AS\nSELECT 1;",
      "CREATE DATABASE IF NOT EXISTS db ON CLUSTER 'c';",
      "ALTER TABLE db.t ON CLUSTER 'c' ADD COLUMN IF NOT EXISTS `c` String;",
      "ALTER TABLE db.t ON CLUSTER 'c' RENAME COLUMN IF EXISTS `a` TO `b`;",
      "RENAME TABLE IF EXISTS db.a TO db.b ON CLUSTER 'c';",
      "DROP TABLE IF EXISTS db.t ON CLUSTER 'c';",
      "DROP TABLE IF EXISTS db.mv ON CLUSTER 'c' SYNC;",
      "DROP VIEW IF EXISTS db.v ON CLUSTER 'c';",
    ])
  })

  test('injects into rename-suggestion confirmation SQL', () => {
    const plan: MigrationPlan = {
      operations: [],
      riskSummary: { safe: 0, caution: 0, danger: 0 },
      renameSuggestions: [
        {
          kind: 'column',
          database: 'db',
          table: 't',
          from: 'a',
          to: 'b',
          confidence: 'high',
          reason: 'x',
          dropOperationKey: 'd',
          addOperationKey: 'a',
          confirmationSQL: 'ALTER TABLE db.t RENAME COLUMN IF EXISTS `a` TO `b`;',
        },
      ],
    }

    expect(applyOnClusterToPlan(plan, 'c').renameSuggestions[0]?.confirmationSQL).toBe(
      "ALTER TABLE db.t ON CLUSTER 'c' RENAME COLUMN IF EXISTS `a` TO `b`;",
    )
  })

  test('leaves statements without a known anchor untouched', () => {
    const plan = planOf([op('drop_table', 'INSERT INTO db.t SELECT 1;')])
    expect(applyOnClusterToPlan(plan, 'c').operations[0]?.sql).toBe('INSERT INTO db.t SELECT 1;')
  })

  test('injects ON CLUSTER for dictionary create-or-replace, drop, and rename', () => {
    const plan = planOf([
      op('create_dictionary', 'CREATE DICTIONARY IF NOT EXISTS db.d\n(\n  `id` UInt64\n)\nPRIMARY KEY `id`\nSOURCE(NULL())\nLAYOUT(FLAT())\nLIFETIME(0);'),
      op('create_dictionary', 'CREATE OR REPLACE DICTIONARY db.d\n(\n  `id` UInt64\n)\nPRIMARY KEY `id`\nSOURCE(NULL())\nLAYOUT(FLAT())\nLIFETIME(0);'),
      op('drop_dictionary', 'DROP DICTIONARY IF EXISTS db.d;'),
      op('rename_dictionary', 'RENAME DICTIONARY IF EXISTS db.old TO db.new;'),
    ])

    const sql = applyOnClusterToPlan(plan, 'c').operations.map((o) => o.sql)

    expect(sql).toEqual([
      "CREATE DICTIONARY IF NOT EXISTS db.d ON CLUSTER 'c'\n(\n  `id` UInt64\n)\nPRIMARY KEY `id`\nSOURCE(NULL())\nLAYOUT(FLAT())\nLIFETIME(0);",
      "CREATE OR REPLACE DICTIONARY db.d ON CLUSTER 'c'\n(\n  `id` UInt64\n)\nPRIMARY KEY `id`\nSOURCE(NULL())\nLAYOUT(FLAT())\nLIFETIME(0);",
      "DROP DICTIONARY IF EXISTS db.d ON CLUSTER 'c';",
      "RENAME DICTIONARY IF EXISTS db.old TO db.new ON CLUSTER 'c';",
    ])
  })

  // These statement shapes are not emitted by chkit yet; the anchors exist as a
  // forward-compatible safety net so injection already works if a future command
  // starts producing them. Placements confirmed against the ClickHouse reference.
  test('injects into speculative after-name anchors', () => {
    const plan = planOf([
      op('create_table', 'CREATE DICTIONARY IF NOT EXISTS db.d (id UInt64) PRIMARY KEY id SOURCE(NULL());'),
      op('create_table', 'CREATE FUNCTION add_one AS (x) -> x + 1;'),
      op('drop_table', 'DROP DATABASE IF EXISTS db;'),
      op('drop_table', 'DROP DICTIONARY IF EXISTS db.d;'),
      op('create_table', 'ATTACH TABLE IF NOT EXISTS db.t;'),
      op('drop_table', 'DETACH TABLE IF EXISTS db.t;'),
      op('drop_table', 'TRUNCATE TABLE IF EXISTS db.t;'),
      op('drop_table', 'OPTIMIZE TABLE db.t FINAL;'),
    ])

    const sql = applyOnClusterToPlan(plan, 'c').operations.map((o) => o.sql)

    expect(sql).toEqual([
      "CREATE DICTIONARY IF NOT EXISTS db.d ON CLUSTER 'c' (id UInt64) PRIMARY KEY id SOURCE(NULL());",
      "CREATE FUNCTION add_one ON CLUSTER 'c' AS (x) -> x + 1;",
      "DROP DATABASE IF EXISTS db ON CLUSTER 'c';",
      "DROP DICTIONARY IF EXISTS db.d ON CLUSTER 'c';",
      "ATTACH TABLE IF NOT EXISTS db.t ON CLUSTER 'c';",
      "DETACH TABLE IF EXISTS db.t ON CLUSTER 'c';",
      "TRUNCATE TABLE IF EXISTS db.t ON CLUSTER 'c';",
      "OPTIMIZE TABLE db.t ON CLUSTER 'c' FINAL;",
    ])
  })

  test('handles both guarded and unguarded forms of the same statement', () => {
    const plan = planOf([
      op('drop_table', 'DROP TABLE IF EXISTS db.t;'),
      op('drop_table', 'DROP TABLE db.t;'),
      op('create_table', 'CREATE TABLE db.t (`id` UInt64) ENGINE = Memory;'),
      op('drop_table', 'TRUNCATE TABLE db.t;'),
    ])

    const sql = applyOnClusterToPlan(plan, 'c').operations.map((o) => o.sql)

    expect(sql).toEqual([
      "DROP TABLE IF EXISTS db.t ON CLUSTER 'c';",
      "DROP TABLE db.t ON CLUSTER 'c';",
      "CREATE TABLE db.t ON CLUSTER 'c' (`id` UInt64) ENGINE = Memory;",
      "TRUNCATE TABLE db.t ON CLUSTER 'c';",
    ])
  })

  test('is idempotent — never double-injects when ON CLUSTER is already present', () => {
    const plan = planOf([
      op('create_table', "CREATE TABLE IF NOT EXISTS db.t ON CLUSTER 'x'\n(\n  `id` UInt64\n) ENGINE = MergeTree();"),
      op('alter_table_rename_table', "RENAME TABLE db.a TO db.b ON CLUSTER 'x';"),
    ])

    const sql = applyOnClusterToPlan(plan, 'c').operations.map((o) => o.sql)

    expect(sql).toEqual([
      "CREATE TABLE IF NOT EXISTS db.t ON CLUSTER 'x'\n(\n  `id` UInt64\n) ENGINE = MergeTree();",
      "RENAME TABLE db.a TO db.b ON CLUSTER 'x';",
    ])
  })

  test('still injects when user content contains the words "on cluster"', () => {
    const plan = planOf([
      op(
        'create_table',
        "CREATE TABLE db.t\n(\n  `id` UInt64 COMMENT 'aggregated on cluster level'\n) ENGINE = MergeTree()\nORDER BY (`id`);",
      ),
      op('create_view', "CREATE VIEW IF NOT EXISTS db.v AS\nSELECT 'on cluster' AS label;"),
    ])

    const sql = applyOnClusterToPlan(plan, 'c').operations.map((o) => o.sql)

    expect(sql).toEqual([
      "CREATE TABLE db.t ON CLUSTER 'c'\n(\n  `id` UInt64 COMMENT 'aggregated on cluster level'\n) ENGINE = MergeTree()\nORDER BY (`id`);",
      "CREATE VIEW IF NOT EXISTS db.v ON CLUSTER 'c' AS\nSELECT 'on cluster' AS label;",
    ])
  })

  test('appends ON CLUSTER at the end for speculative trailing anchors', () => {
    const plan = planOf([
      op('alter_table_rename_table', 'RENAME DATABASE db.a TO db.b;'),
      op('alter_table_rename_table', 'RENAME DICTIONARY db.a TO db.b;'),
      op('alter_table_rename_table', 'EXCHANGE TABLES db.a AND db.b;'),
      op('alter_table_rename_table', 'EXCHANGE DICTIONARIES db.a AND db.b;'),
    ])

    const sql = applyOnClusterToPlan(plan, 'c').operations.map((o) => o.sql)

    expect(sql).toEqual([
      "RENAME DATABASE db.a TO db.b ON CLUSTER 'c';",
      "RENAME DICTIONARY db.a TO db.b ON CLUSTER 'c';",
      "EXCHANGE TABLES db.a AND db.b ON CLUSTER 'c';",
      "EXCHANGE DICTIONARIES db.a AND db.b ON CLUSTER 'c';",
    ])
  })
})

describe('resolveConfig cluster validation', () => {
  test('passes through an identifier and a macro', () => {
    expect(resolveConfig({ schema: 's', clickhouse: { url: 'u', cluster: 'my_cluster' } }).clickhouse?.cluster).toBe(
      'my_cluster',
    )
    expect(resolveConfig({ schema: 's', clickhouse: { url: 'u', cluster: '{cluster}' } }).clickhouse?.cluster).toBe(
      '{cluster}',
    )
  })

  test('passes through names with dashes and dots', () => {
    expect(resolveConfig({ schema: 's', clickhouse: { url: 'u', cluster: 'prod-eu-1' } }).clickhouse?.cluster).toBe(
      'prod-eu-1',
    )
    expect(resolveConfig({ schema: 's', clickhouse: { url: 'u', cluster: 'eu.west.main' } }).clickhouse?.cluster).toBe(
      'eu.west.main',
    )
  })

  test('defaults to undefined when no cluster is set', () => {
    expect(resolveConfig({ schema: 's', clickhouse: { url: 'u' } }).clickhouse?.cluster).toBeUndefined()
  })

  test('rejects an injection-unsafe cluster name', () => {
    expect(() => resolveConfig({ schema: 's', clickhouse: { url: 'u', cluster: "x'; DROP" } })).toThrow(
      /Invalid clickhouse.cluster/,
    )
  })
})
