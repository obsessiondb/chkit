import { describe, expect, test } from 'bun:test'

import {
  ChxValidationError,
  canonicalizeDefinitions,
  collectDefinitionsFromModule,
  materializedView,
  planDiff,
  schema,
  table,
  toCreateSQL,
  validateDefinitions,
  view,
} from './index'

describe('@chx/core smoke', () => {
  test('builds table and view definitions', () => {
    const users = table({
      database: 'app',
      name: 'users',
      columns: [
        { name: 'id', type: 'UInt64' },
        { name: 'email', type: 'String' },
      ],
      engine: 'MergeTree()',
      primaryKey: ['id'],
      orderBy: ['id'],
    })

    const usersView = view({
      database: 'app',
      name: 'users_view',
      as: 'SELECT id, email FROM app.users',
    })

    const defs = schema(users, usersView)
    expect(defs).toHaveLength(2)
    expect(toCreateSQL(defs[0])).toContain('CREATE TABLE IF NOT EXISTS app.users')
  })

  test('renders unique key and projections in create table sql', () => {
    const events = table({
      database: 'app',
      name: 'events',
      columns: [{ name: 'id', type: 'UInt64' }],
      engine: 'MergeTree()',
      primaryKey: ['id'],
      orderBy: ['id'],
      uniqueKey: ['id'],
      projections: [{ name: 'p_recent', query: 'SELECT id ORDER BY id DESC LIMIT 10' }],
    })

    const sql = toCreateSQL(events)
    expect(sql).toContain('UNIQUE KEY (`id`)')
    expect(sql).toContain('PROJECTION `p_recent` (SELECT id ORDER BY id DESC LIMIT 10)')
  })

  test('collects and de-duplicates definitions from module exports', () => {
    const users = table({
      database: 'app',
      name: 'users',
      columns: [{ name: 'id', type: 'UInt64' }],
      engine: 'MergeTree()',
      primaryKey: ['id'],
      orderBy: ['id'],
    })

    const defs = collectDefinitionsFromModule({
      one: users,
      two: [users],
    })

    expect(defs).toHaveLength(1)
  })
})

describe('@chx/core planner v1', () => {
  test('canonicalizes deterministically by kind/database/name', () => {
    const defs = canonicalizeDefinitions([
      view({ database: 'z', name: 'v2', as: 'SELECT 1' }),
      table({
        database: 'z',
        name: 't2',
        columns: [{ name: 'id', type: 'UInt64' }],
        engine: 'MergeTree()',
        primaryKey: ['id'],
        orderBy: ['id'],
      }),
      view({ database: 'a', name: 'v1', as: 'SELECT 1' }),
      table({
        database: 'a',
        name: 't1',
        columns: [{ name: 'id', type: 'UInt64' }],
        engine: 'MergeTree()',
        primaryKey: ['id'],
        orderBy: ['id'],
      }),
    ])

    expect(defs.map((d) => `${d.kind}:${d.database}.${d.name}`)).toEqual([
      'table:a.t1',
      'table:z.t2',
      'view:a.v1',
      'view:z.v2',
    ])
  })

  test('plans create/drop with danger/safe risks', () => {
    const oldDefs = [
      table({
        database: 'app',
        name: 'old_users',
        columns: [{ name: 'id', type: 'UInt64' }],
        engine: 'MergeTree()',
        primaryKey: ['id'],
        orderBy: ['id'],
      }),
    ]

    const newDefs = [
      table({
        database: 'app',
        name: 'users',
        columns: [{ name: 'id', type: 'UInt64' }],
        engine: 'MergeTree()',
        primaryKey: ['id'],
        orderBy: ['id'],
      }),
    ]

    const plan = planDiff(oldDefs, newDefs)

    expect(plan.operations.map((op) => op.type)).toEqual([
      'drop_table',
      'create_database',
      'create_table',
    ])
    expect(plan.riskSummary).toEqual({
      safe: 2,
      caution: 0,
      danger: 1,
    })
  })

  test('plans additive table changes in stable order', () => {
    const oldDefs = [
      table({
        database: 'app',
        name: 'events',
        columns: [{ name: 'id', type: 'UInt64' }],
        engine: 'MergeTree()',
        primaryKey: ['id'],
        orderBy: ['id'],
        settings: { index_granularity: 8192 },
      }),
    ]

    const newDefs = [
      table({
        database: 'app',
        name: 'events',
        columns: [
          { name: 'id', type: 'UInt64' },
          { name: 'source', type: 'String' },
          { name: 'received_at', type: 'DateTime64(3)', default: 'fn:now64(3)' },
        ],
        engine: 'MergeTree()',
        primaryKey: ['id'],
        orderBy: ['id'],
        settings: { index_granularity: 4096 },
        indexes: [
          {
            name: 'idx_source',
            expression: 'source',
            type: 'set',
            granularity: 1,
          },
        ],
      }),
    ]

    const plan = planDiff(oldDefs, newDefs)
    expect(plan.operations.map((op) => op.type)).toEqual([
      'alter_table_add_column',
      'alter_table_add_column',
      'alter_table_add_index',
      'alter_table_modify_setting',
    ])
    expect(plan.operations[0]?.risk).toBe('safe')
    expect(plan.operations[2]?.risk).toBe('caution')
    expect(plan.operations[3]?.risk).toBe('caution')
    expect(plan.riskSummary).toEqual({
      safe: 2,
      caution: 2,
      danger: 0,
    })
  })

  test('plans non-additive table changes with risk classification', () => {
    const oldDefs = [
      table({
        database: 'app',
        name: 'events',
        columns: [
          { name: 'id', type: 'UInt64' },
          { name: 'source', type: 'String' },
          { name: 'old_col', type: 'String' },
        ],
        engine: 'MergeTree()',
        primaryKey: ['id'],
        orderBy: ['id'],
        ttl: 'toDateTime(id)',
        settings: { index_granularity: 8192, old_setting: 1 },
        indexes: [
          {
            name: 'idx_source',
            expression: 'source',
            type: 'set',
            granularity: 1,
          },
          {
            name: 'idx_old',
            expression: 'old_col',
            type: 'set',
            granularity: 1,
          },
        ],
      }),
    ]

    const newDefs = [
      table({
        database: 'app',
        name: 'events',
        columns: [
          { name: 'id', type: 'UInt64' },
          { name: 'source', type: 'LowCardinality(String)' },
        ],
        engine: 'MergeTree()',
        primaryKey: ['id'],
        orderBy: ['id'],
        settings: { index_granularity: 4096 },
        indexes: [
          {
            name: 'idx_source',
            expression: 'lower(source)',
            type: 'set',
            granularity: 2,
          },
        ],
      }),
    ]

    const plan = planDiff(oldDefs, newDefs)
    expect(plan.operations.map((op) => op.type)).toEqual([
      'alter_table_drop_column',
      'alter_table_modify_column',
      'alter_table_drop_index',
      'alter_table_drop_index',
      'alter_table_add_index',
      'alter_table_modify_setting',
      'alter_table_reset_setting',
      'alter_table_modify_ttl',
    ])
    expect(plan.riskSummary).toEqual({
      safe: 0,
      caution: 7,
      danger: 1,
    })
  })

  test('recreates table when structural keys change', () => {
    const oldDefs = [
      table({
        database: 'app',
        name: 'events',
        columns: [{ name: 'id', type: 'UInt64' }],
        engine: 'MergeTree()',
        primaryKey: ['id'],
        orderBy: ['id'],
        uniqueKey: ['id'],
      }),
    ]

    const newDefs = [
      table({
        database: 'app',
        name: 'events',
        columns: [{ name: 'id', type: 'UInt64' }],
        engine: 'MergeTree()',
        primaryKey: ['id'],
        orderBy: ['id'],
        uniqueKey: ['id', 'id'],
      }),
    ]

    const plan = planDiff(oldDefs, newDefs)
    expect(plan.operations.map((op) => op.type)).toEqual(['drop_table', 'create_table'])
    expect(plan.riskSummary).toEqual({
      safe: 1,
      caution: 0,
      danger: 1,
    })
  })

  test('plans projection add/replace/remove operations', () => {
    const oldDefs = [
      table({
        database: 'app',
        name: 'events',
        columns: [{ name: 'id', type: 'UInt64' }],
        engine: 'MergeTree()',
        primaryKey: ['id'],
        orderBy: ['id'],
        projections: [
          { name: 'p_old', query: 'SELECT id ORDER BY id LIMIT 1' },
          { name: 'p_change', query: 'SELECT id' },
        ],
      }),
    ]

    const newDefs = [
      table({
        database: 'app',
        name: 'events',
        columns: [{ name: 'id', type: 'UInt64' }],
        engine: 'MergeTree()',
        primaryKey: ['id'],
        orderBy: ['id'],
        projections: [
          { name: 'p_new', query: 'SELECT id ORDER BY id DESC LIMIT 5' },
          { name: 'p_change', query: 'SELECT id ORDER BY id LIMIT 10' },
        ],
      }),
    ]

    const plan = planDiff(oldDefs, newDefs)
    expect(plan.operations.map((op) => op.type)).toEqual([
      'alter_table_drop_projection',
      'alter_table_add_projection',
      'alter_table_add_projection',
      'alter_table_drop_projection',
    ])
    expect(plan.riskSummary).toEqual({
      safe: 0,
      caution: 4,
      danger: 0,
    })
  })

  test('recreates changed view definitions with caution risk', () => {
    const oldDefs = [
      view({
        database: 'app',
        name: 'users_view',
        as: 'SELECT id FROM app.users',
      }),
    ]
    const newDefs = [
      view({
        database: 'app',
        name: 'users_view',
        as: 'SELECT id, email FROM app.users',
      }),
    ]

    const plan = planDiff(oldDefs, newDefs)
    expect(plan.operations.map((op) => op.type)).toEqual(['drop_view', 'create_view'])
    expect(plan.operations[0]?.risk).toBe('caution')
    expect(plan.operations[1]?.risk).toBe('caution')
    expect(plan.riskSummary).toEqual({
      safe: 0,
      caution: 2,
      danger: 0,
    })
  })

  test('recreates changed materialized view definitions with caution risk', () => {
    const oldDefs = [
      materializedView({
        database: 'app',
        name: 'mv_users',
        to: { database: 'app', name: 'users_rollup' },
        as: 'SELECT id FROM app.users',
      }),
    ]
    const newDefs = [
      materializedView({
        database: 'app',
        name: 'mv_users',
        to: { database: 'app', name: 'users_rollup_v2' },
        as: 'SELECT id, count() AS c FROM app.users GROUP BY id',
      }),
    ]

    const plan = planDiff(oldDefs, newDefs)
    expect(plan.operations.map((op) => op.type)).toEqual([
      'drop_materialized_view',
      'create_materialized_view',
    ])
    expect(plan.operations[0]?.risk).toBe('caution')
    expect(plan.operations[1]?.risk).toBe('caution')
    expect(plan.riskSummary).toEqual({
      safe: 0,
      caution: 2,
      danger: 0,
    })
  })

  test('validates duplicate columns, indexes, and missing key columns', () => {
    const defs = [
      table({
        database: 'app',
        name: 'events',
        columns: [
          { name: 'id', type: 'UInt64' },
          { name: 'id', type: 'UInt64' },
        ],
        engine: 'MergeTree()',
        primaryKey: ['id', 'missing_pk_col'],
        orderBy: ['id', 'missing_order_col'],
        indexes: [
          { name: 'idx_source', expression: 'id', type: 'set', granularity: 1 },
          { name: 'idx_source', expression: 'id', type: 'set', granularity: 1 },
        ],
      }),
    ]

    const issues = validateDefinitions(defs)
    expect(issues.map((issue) => issue.code)).toEqual([
      'duplicate_column_name',
      'duplicate_index_name',
      'primary_key_missing_column',
      'order_by_missing_column',
    ])
  })

  test('validates duplicate projection names', () => {
    const defs = [
      table({
        database: 'app',
        name: 'events',
        columns: [{ name: 'id', type: 'UInt64' }],
        engine: 'MergeTree()',
        primaryKey: ['id'],
        orderBy: ['id'],
        projections: [
          { name: 'p_events', query: 'SELECT id' },
          { name: 'p_events', query: 'SELECT id ORDER BY id' },
        ],
      }),
    ]

    const issues = validateDefinitions(defs)
    expect(issues.map((issue) => issue.code)).toEqual(['duplicate_projection_name'])
  })

  test('planDiff throws typed validation error for invalid schema', () => {
    const invalidDefs = [
      table({
        database: 'app',
        name: 'events',
        columns: [{ name: 'id', type: 'UInt64' }],
        engine: 'MergeTree()',
        primaryKey: ['missing'],
        orderBy: ['id'],
      }),
    ]

    expect(() => planDiff([], invalidDefs)).toThrow(ChxValidationError)
  })

  test('returns empty plan for equivalent schemas', () => {
    const defs = [
      table({
        database: 'app',
        name: 'users',
        columns: [{ name: 'id', type: 'UInt64' }],
        engine: 'MergeTree()',
        primaryKey: ['id'],
        orderBy: ['id'],
      }),
    ]

    const plan = planDiff(defs, defs)
    expect(plan.operations).toHaveLength(0)
    expect(plan.riskSummary).toEqual({
      safe: 0,
      caution: 0,
      danger: 0,
    })
  })

  test('plan ordering is deterministic regardless of input definition order', () => {
    const oldDefs = [
      table({
        database: 'app',
        name: 'events',
        columns: [{ name: 'id', type: 'UInt64' }],
        engine: 'MergeTree()',
        primaryKey: ['id'],
        orderBy: ['id'],
      }),
    ]

    const newDefsA = [
      view({
        database: 'app',
        name: 'events_view',
        as: 'SELECT id FROM app.events',
      }),
      table({
        database: 'app',
        name: 'events',
        columns: [
          { name: 'id', type: 'UInt64' },
          { name: 'source', type: 'String' },
        ],
        engine: 'MergeTree()',
        primaryKey: ['id'],
        orderBy: ['id'],
      }),
    ]

    const newDefsB = [...newDefsA].reverse()
    const planA = planDiff(oldDefs, newDefsA)
    const planB = planDiff(oldDefs, newDefsB)

    expect(planA.operations.map((op) => `${op.type}:${op.key}`)).toEqual(
      planB.operations.map((op) => `${op.type}:${op.key}`)
    )
    expect(planA.riskSummary).toEqual(planB.riskSummary)
  })
})
