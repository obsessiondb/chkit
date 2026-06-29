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
      "RENAME TABLE IF EXISTS db.a ON CLUSTER 'c' TO db.b;",
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
    const plan = planOf([op('drop_table', 'TRUNCATE TABLE db.t;')])
    expect(applyOnClusterToPlan(plan, 'c').operations[0]?.sql).toBe('TRUNCATE TABLE db.t;')
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

  test('defaults to undefined when no cluster is set', () => {
    expect(resolveConfig({ schema: 's', clickhouse: { url: 'u' } }).clickhouse?.cluster).toBeUndefined()
  })

  test('rejects an injection-unsafe cluster name', () => {
    expect(() => resolveConfig({ schema: 's', clickhouse: { url: 'u', cluster: "x'; DROP" } })).toThrow(
      /Invalid clickhouse.cluster/,
    )
  })
})
