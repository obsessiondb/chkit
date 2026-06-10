import { describe, expect, test } from 'bun:test'

import {
  ChxValidationError,
  canonicalizeDefinitions,
  codec,
  collectDefinitionsFromModule,
  materializedView,
  planDiff,
  schema,
  table,
  toCreateSQL,
  validateDefinitions,
  view,
} from './index'

describe('@chkit/core smoke', () => {
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

  test('normalizes comma-delimited key clauses in create table sql', () => {
    const events = table({
      database: 'app',
      name: 'events',
      columns: [
        { name: 'id', type: 'UInt64' },
        { name: 'org_id', type: 'String' },
        { name: 'created_at', type: 'DateTime64(3)' },
      ],
      engine: 'MergeTree()',
      primaryKey: ['id, org_id'],
      orderBy: ['org_id, created_at, id'],
      uniqueKey: ['id, org_id'],
    })

    const sql = toCreateSQL(events)
    expect(sql).toContain('PRIMARY KEY (`id`, `org_id`)')
    expect(sql).toContain('ORDER BY (`org_id`, `created_at`, `id`)')
    expect(sql).toContain('UNIQUE KEY (`id`, `org_id`)')
  })

  test('table with orderBy but no primaryKey does not crash; PK defaults to orderBy (#19)', () => {
    // A user can omit primaryKey at runtime (JS, or a `.ts` config without
    // strict types). ClickHouse derives the PK from ORDER BY, so this must
    // canonicalize cleanly instead of crashing on `undefined.flatMap`.
    const events = table({
      database: 'app',
      name: 'events',
      columns: [{ name: 'id', type: 'UInt64' }],
      engine: 'MergeTree()',
      orderBy: ['id'],
      // primaryKey intentionally omitted
    } as Parameters<typeof table>[0])

    const [canonical] = canonicalizeDefinitions([events])
    expect((canonical as { primaryKey: string[] }).primaryKey).toEqual(['id'])

    const sql = toCreateSQL(canonical)
    expect(sql).toContain('PRIMARY KEY (`id`)')
    expect(sql).toContain('ORDER BY (`id`)')
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

  test('canonicalizes comma-delimited key clauses to separate columns', () => {
    const defs = canonicalizeDefinitions([
      table({
        database: 'app',
        name: 'events',
        columns: [
          { name: 'id', type: 'UInt64' },
          { name: 'org_id', type: 'String' },
          { name: 'created_at', type: 'DateTime64(3)' },
        ],
        engine: 'MergeTree()',
        primaryKey: ['id, org_id'],
        orderBy: ['org_id, created_at, id'],
      }),
    ])

    const events = defs[0]
    if (!events || events.kind !== 'table') throw new Error('expected table definition')
    expect(events.primaryKey).toEqual(['id', 'org_id'])
    expect(events.orderBy).toEqual(['org_id', 'created_at', 'id'])
  })
})

describe('@chkit/core planner v1', () => {
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
            maxRows: 0,
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
            maxRows: 0,
            granularity: 1,
          },
          {
            name: 'idx_old',
            expression: 'old_col',
            type: 'set',
            maxRows: 0,
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
            maxRows: 0,
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
    expect(plan.renameSuggestions).toEqual([])
  })

  test('suggests a likely column rename when add/drop definitions match', () => {
    const oldDefs = [
      table({
        database: 'app',
        name: 'events',
        columns: [
          { name: 'id', type: 'UInt64' },
          { name: 'source', type: 'String', nullable: true, default: 'unknown' },
        ],
        engine: 'MergeTree()',
        primaryKey: ['id'],
        orderBy: ['id'],
      }),
    ]

    const newDefs = [
      table({
        database: 'app',
        name: 'events',
        columns: [
          { name: 'id', type: 'UInt64' },
          { name: 'origin', type: 'String', nullable: true, default: 'unknown' },
        ],
        engine: 'MergeTree()',
        primaryKey: ['id'],
        orderBy: ['id'],
      }),
    ]

    const plan = planDiff(oldDefs, newDefs)
    expect(plan.operations.map((op) => op.type)).toEqual([
      'alter_table_add_column',
      'alter_table_drop_column',
    ])
    expect(plan.renameSuggestions).toEqual([
      {
        kind: 'column',
        database: 'app',
        table: 'events',
        from: 'source',
        to: 'origin',
        confidence: 'high',
        reason:
          'Dropped and added columns have an identical non-name definition (type, nullability, default, comment).',
        dropOperationKey: 'table:app.events:column:source',
        addOperationKey: 'table:app.events:column:origin',
        confirmationSQL: 'ALTER TABLE app.events RENAME COLUMN IF EXISTS `source` TO `origin`;',
      },
    ])
  })

  test('does not suggest rename when new column definition differs', () => {
    const oldDefs = [
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

    const newDefs = [
      table({
        database: 'app',
        name: 'events',
        columns: [
          { name: 'id', type: 'UInt64' },
          { name: 'origin', type: 'LowCardinality(String)' },
        ],
        engine: 'MergeTree()',
        primaryKey: ['id'],
        orderBy: ['id'],
      }),
    ]

    const plan = planDiff(oldDefs, newDefs)
    expect(plan.renameSuggestions).toEqual([])
  })

  test('ignores renamedFrom metadata for same-name column equality checks', () => {
    const oldDefs = [
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

    const newDefs = [
      table({
        database: 'app',
        name: 'events',
        columns: [
          { name: 'id', type: 'UInt64' },
          { name: 'source', type: 'String', renamedFrom: 'legacy_source' },
        ],
        engine: 'MergeTree()',
        primaryKey: ['id'],
        orderBy: ['id'],
      }),
    ]

    const plan = planDiff(oldDefs, newDefs)
    expect(plan.operations).toEqual([])
    expect(plan.renameSuggestions).toEqual([])
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
          { name: 'idx_source', expression: 'id', type: 'set', maxRows: 0, granularity: 1 },
          { name: 'idx_source', expression: 'id', type: 'set', maxRows: 0, granularity: 1 },
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

  test('set index type requires maxRows at the type level', () => {
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
      indexes: [
        // @ts-expect-error — set requires `maxRows` at compile time
        { name: 'idx_source', expression: 'source', type: 'set', granularity: 1 },
      ],
    })
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
    expect(plan.renameSuggestions).toEqual([])
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

  test('renders structured index args in CREATE TABLE', () => {
    const events = table({
      database: 'app',
      name: 'events',
      columns: [
        { name: 'id', type: 'UInt64' },
        { name: 'source', type: 'String' },
        { name: 'body', type: 'String' },
        { name: 'name', type: 'String' },
      ],
      engine: 'MergeTree()',
      primaryKey: ['id'],
      orderBy: ['id'],
      indexes: [
        { name: 'idx_source', expression: 'source', type: 'set', maxRows: 0, granularity: 1 },
        { name: 'idx_id', expression: 'id', type: 'minmax', granularity: 3 },
        {
          name: 'idx_bloom',
          expression: 'source',
          type: 'bloom_filter',
          falsePositiveRate: 0.01,
          granularity: 1,
        },
        {
          name: 'idx_bloom_default',
          expression: 'source',
          type: 'bloom_filter',
          granularity: 1,
        },
        {
          name: 'idx_body',
          expression: 'body',
          type: 'tokenbf_v1',
          sizeBytes: 256,
          hashFunctions: 2,
          randomSeed: 0,
          granularity: 1,
        },
        {
          name: 'idx_name',
          expression: 'name',
          type: 'ngrambf_v1',
          ngramSize: 3,
          sizeBytes: 256,
          hashFunctions: 2,
          randomSeed: 0,
          granularity: 1,
        },
      ],
    })

    const sql = toCreateSQL(events)
    expect(sql).toContain('TYPE set(0) GRANULARITY 1')
    expect(sql).toContain('TYPE minmax GRANULARITY 3')
    expect(sql).toContain('TYPE bloom_filter(0.01) GRANULARITY 1')
    expect(sql).toContain('`idx_bloom_default` (source) TYPE bloom_filter GRANULARITY 1')
    expect(sql).toContain('TYPE tokenbf_v1(256, 2, 0) GRANULARITY 1')
    expect(sql).toContain('TYPE ngrambf_v1(3, 256, 2, 0) GRANULARITY 1')
  })

  test('renders structured index args in ALTER ADD INDEX', () => {
    const oldDefs = [
      table({
        database: 'app',
        name: 'events',
        columns: [{ name: 'id', type: 'UInt64' }, { name: 'source', type: 'String' }],
        engine: 'MergeTree()',
        primaryKey: ['id'],
        orderBy: ['id'],
      }),
    ]

    const newDefs = [
      table({
        database: 'app',
        name: 'events',
        columns: [{ name: 'id', type: 'UInt64' }, { name: 'source', type: 'String' }],
        engine: 'MergeTree()',
        primaryKey: ['id'],
        orderBy: ['id'],
        indexes: [
          { name: 'idx_source', expression: 'source', type: 'set', maxRows: 0, granularity: 1 },
        ],
      }),
    ]

    const plan = planDiff(oldDefs, newDefs)
    expect(plan.operations).toHaveLength(1)
    expect(plan.operations[0]?.sql).toContain('TYPE set(0) GRANULARITY 1')
  })

  test('detects index change when structured args differ', () => {
    const oldDefs = [
      table({
        database: 'app',
        name: 'events',
        columns: [{ name: 'id', type: 'UInt64' }, { name: 'source', type: 'String' }],
        engine: 'MergeTree()',
        primaryKey: ['id'],
        orderBy: ['id'],
        indexes: [
          { name: 'idx_source', expression: 'source', type: 'set', maxRows: 0, granularity: 1 },
        ],
      }),
    ]

    const newDefs = [
      table({
        database: 'app',
        name: 'events',
        columns: [{ name: 'id', type: 'UInt64' }, { name: 'source', type: 'String' }],
        engine: 'MergeTree()',
        primaryKey: ['id'],
        orderBy: ['id'],
        indexes: [
          { name: 'idx_source', expression: 'source', type: 'set', maxRows: 100, granularity: 1 },
        ],
      }),
    ]

    const plan = planDiff(oldDefs, newDefs)
    expect(plan.operations.map((op) => op.type)).toEqual([
      'alter_table_drop_index',
      'alter_table_add_index',
    ])
    expect(plan.operations[1]?.sql).toContain('TYPE set(100) GRANULARITY 1')
  })

  test('creates tables before views and materialized views', () => {
    const oldDefs: Parameters<typeof planDiff>[0] = []

    const newDefs = [
      materializedView({
        database: 'app',
        name: 'mv_events',
        to: { database: 'app', name: 'events_rollup' },
        as: 'SELECT id FROM app.events',
      }),
      view({
        database: 'app',
        name: 'events_view',
        as: 'SELECT id FROM app.events',
      }),
      table({
        database: 'app',
        name: 'events',
        columns: [{ name: 'id', type: 'UInt64' }],
        engine: 'MergeTree()',
        primaryKey: ['id'],
        orderBy: ['id'],
      }),
      table({
        database: 'app',
        name: 'events_rollup',
        columns: [{ name: 'id', type: 'UInt64' }],
        engine: 'MergeTree()',
        primaryKey: ['id'],
        orderBy: ['id'],
      }),
    ]

    const plan = planDiff(oldDefs, newDefs)
    const types = plan.operations.map((op) => op.type)
    const createTypes = types.filter((t) => t.startsWith('create_') && t !== 'create_database')

    expect(createTypes).toEqual([
      'create_table',
      'create_table',
      'create_view',
      'create_materialized_view',
    ])
  })
})

describe('@chkit/core column codec', () => {
  test('renders CODEC clause after DEFAULT', () => {
    const events = table({
      database: 'app',
      name: 'events',
      columns: [
        { name: 'id', type: 'UInt64' },
        { name: 'ts', type: 'DateTime', codec: { kind: 'ZSTD', level: 3 }, default: 'fn:now()' },
      ],
      engine: 'MergeTree()',
      primaryKey: ['id'],
      orderBy: ['id'],
    })

    const sql = toCreateSQL(events)
    expect(sql).toContain('`ts` DateTime DEFAULT now() CODEC(ZSTD(3))')
  })

  test('renders CODEC chain with preprocessor + general', () => {
    const events = table({
      database: 'app',
      name: 'events',
      columns: [
        { name: 'id', type: 'UInt64' },
        { name: 'delta', type: 'Int64', codec: [{ kind: 'Delta', size: 4 }, { kind: 'ZSTD' }] },
      ],
      engine: 'MergeTree()',
      primaryKey: ['id'],
      orderBy: ['id'],
    })

    const sql = toCreateSQL(events)
    expect(sql).toContain('`delta` Int64 CODEC(Delta(4), ZSTD)')
  })

  test('renders CODEC on nullable column', () => {
    const events = table({
      database: 'app',
      name: 'events',
      columns: [
        { name: 'id', type: 'UInt64' },
        { name: 'note', type: 'String', nullable: true, codec: { kind: 'ZSTD', level: 3 } },
      ],
      engine: 'MergeTree()',
      primaryKey: ['id'],
      orderBy: ['id'],
    })

    const sql = toCreateSQL(events)
    expect(sql).toContain('`note` Nullable(String) CODEC(ZSTD(3))')
  })

  test('plan: add codec to column emits MODIFY COLUMN with CODEC', () => {
    const oldDefs = [
      table({
        database: 'app',
        name: 'events',
        columns: [
          { name: 'id', type: 'UInt64' },
          { name: 'payload', type: 'String' },
        ],
        engine: 'MergeTree()',
        primaryKey: ['id'],
        orderBy: ['id'],
      }),
    ]
    const newDefs = [
      table({
        database: 'app',
        name: 'events',
        columns: [
          { name: 'id', type: 'UInt64' },
          { name: 'payload', type: 'String', codec: { kind: 'ZSTD', level: 3 } },
        ],
        engine: 'MergeTree()',
        primaryKey: ['id'],
        orderBy: ['id'],
      }),
    ]

    const plan = planDiff(oldDefs, newDefs)
    expect(plan.operations.map((op) => op.type)).toEqual(['alter_table_modify_column'])
    expect(plan.operations[0]?.sql).toContain('MODIFY COLUMN `payload` String CODEC(ZSTD(3))')
  })

  test('plan: change codec emits single MODIFY COLUMN', () => {
    const oldDefs = [
      table({
        database: 'app',
        name: 'events',
        columns: [
          { name: 'id', type: 'UInt64' },
          { name: 'payload', type: 'String', codec: { kind: 'ZSTD', level: 1 } },
        ],
        engine: 'MergeTree()',
        primaryKey: ['id'],
        orderBy: ['id'],
      }),
    ]
    const newDefs = [
      table({
        database: 'app',
        name: 'events',
        columns: [
          { name: 'id', type: 'UInt64' },
          { name: 'payload', type: 'String', codec: { kind: 'ZSTD', level: 6 } },
        ],
        engine: 'MergeTree()',
        primaryKey: ['id'],
        orderBy: ['id'],
      }),
    ]

    const plan = planDiff(oldDefs, newDefs)
    expect(plan.operations.map((op) => op.type)).toEqual(['alter_table_modify_column'])
    expect(plan.operations[0]?.sql).toContain('MODIFY COLUMN `payload` String CODEC(ZSTD(6))')
    expect(plan.operations[0]?.sql).not.toContain('REMOVE CODEC')
  })

  test('plan: remove codec emits REMOVE CODEC when other fields unchanged', () => {
    const oldDefs = [
      table({
        database: 'app',
        name: 'events',
        columns: [
          { name: 'id', type: 'UInt64' },
          { name: 'payload', type: 'String', codec: { kind: 'ZSTD', level: 3 } },
        ],
        engine: 'MergeTree()',
        primaryKey: ['id'],
        orderBy: ['id'],
      }),
    ]
    const newDefs = [
      table({
        database: 'app',
        name: 'events',
        columns: [
          { name: 'id', type: 'UInt64' },
          { name: 'payload', type: 'String' },
        ],
        engine: 'MergeTree()',
        primaryKey: ['id'],
        orderBy: ['id'],
      }),
    ]

    const plan = planDiff(oldDefs, newDefs)
    expect(plan.operations).toHaveLength(1)
    expect(plan.operations[0]?.type).toBe('alter_table_modify_column')
    expect(plan.operations[0]?.sql).toBe(
      'ALTER TABLE app.events MODIFY COLUMN `payload` REMOVE CODEC;'
    )
  })

  test('plan: drop codec + other change emits single MODIFY COLUMN (no separate REMOVE)', () => {
    const oldDefs = [
      table({
        database: 'app',
        name: 'events',
        columns: [
          { name: 'id', type: 'UInt64' },
          { name: 'payload', type: 'String', codec: { kind: 'ZSTD', level: 3 } },
        ],
        engine: 'MergeTree()',
        primaryKey: ['id'],
        orderBy: ['id'],
      }),
    ]
    const newDefs = [
      table({
        database: 'app',
        name: 'events',
        columns: [
          { name: 'id', type: 'UInt64' },
          { name: 'payload', type: 'LowCardinality(String)' },
        ],
        engine: 'MergeTree()',
        primaryKey: ['id'],
        orderBy: ['id'],
      }),
    ]

    const plan = planDiff(oldDefs, newDefs)
    expect(plan.operations).toHaveLength(1)
    expect(plan.operations[0]?.type).toBe('alter_table_modify_column')
    expect(plan.operations[0]?.sql).toContain('LowCardinality(String)')
    expect(plan.operations[0]?.sql).not.toContain('REMOVE CODEC')
  })

  test('plan: equal codec across canonicalization yields no diff', () => {
    const oldDefs = [
      table({
        database: 'app',
        name: 'events',
        columns: [
          { name: 'id', type: 'UInt64' },
          { name: 'payload', type: 'String', codec: { kind: 'ZSTD' } },
        ],
        engine: 'MergeTree()',
        primaryKey: ['id'],
        orderBy: ['id'],
      }),
    ]
    const newDefs = [
      table({
        database: 'app',
        name: 'events',
        columns: [
          { name: 'id', type: 'UInt64' },
          { name: 'payload', type: 'String', codec: { kind: 'ZSTD', level: 1 } },
        ],
        engine: 'MergeTree()',
        primaryKey: ['id'],
        orderBy: ['id'],
      }),
    ]

    const plan = planDiff(oldDefs, newDefs)
    expect(plan.operations).toEqual([])
  })

  test('validates chain with multiple general codecs', () => {
    const defs = [
      table({
        database: 'app',
        name: 'events',
        columns: [
          { name: 'id', type: 'UInt64' },
          {
            name: 'payload',
            type: 'String',
            codec: [
              { kind: 'ZSTD', level: 3 },
              { kind: 'LZ4' },
            ],
          },
        ],
        engine: 'MergeTree()',
        primaryKey: ['id'],
        orderBy: ['id'],
      }),
    ]
    const issues = validateDefinitions(defs)
    expect(issues.map((i) => i.code)).toContain('codec_chain_multiple_general')
  })

  test('validates chain ending in preprocessor', () => {
    const defs = [
      table({
        database: 'app',
        name: 'events',
        columns: [
          { name: 'id', type: 'UInt64' },
          {
            name: 'payload',
            type: 'Int64',
            codec: [
              { kind: 'ZSTD' },
              { kind: 'Delta', size: 4 },
            ],
          },
        ],
        engine: 'MergeTree()',
        primaryKey: ['id'],
        orderBy: ['id'],
      }),
    ]
    const issues = validateDefinitions(defs)
    expect(issues.map((i) => i.code)).toContain('codec_chain_must_end_with_general')
  })

  test('allows standalone preprocessor codec (CH auto-appends default general)', () => {
    const defs = [
      table({
        database: 'app',
        name: 'events',
        columns: [
          { name: 'id', type: 'UInt64' },
          { name: 'delta', type: 'Int64', codec: { kind: 'Delta', size: 4 } },
        ],
        engine: 'MergeTree()',
        primaryKey: ['id'],
        orderBy: ['id'],
      }),
    ]
    const issues = validateDefinitions(defs)
    expect(issues.some((i) => i.code === 'codec_chain_must_end_with_general')).toBe(false)
    expect(issues.some((i) => i.code === 'codec_chain_multiple_general')).toBe(false)
  })

  test('flags empty codec chain', () => {
    const defs = [
      table({
        database: 'app',
        name: 'events',
        columns: [
          { name: 'id', type: 'UInt64' },
          { name: 'payload', type: 'Int64', codec: [] },
        ],
        engine: 'MergeTree()',
        primaryKey: ['id'],
        orderBy: ['id'],
      }),
    ]
    const issues = validateDefinitions(defs)
    expect(issues.map((i) => i.code)).toContain('codec_chain_empty')
  })

  test('raw codec atoms satisfy any chain position', () => {
    const defs = [
      table({
        database: 'app',
        name: 'events',
        columns: [
          { name: 'id', type: 'UInt64' },
          {
            name: 'exp',
            type: 'Float32',
            codec: [{ kind: 'Delta', size: 4 }, codec.raw('SomeNewCodec(42)')],
          },
        ],
        engine: 'MergeTree()',
        primaryKey: ['id'],
        orderBy: ['id'],
      }),
    ]
    const issues = validateDefinitions(defs)
    expect(issues.some((i) => i.code.startsWith('codec_chain_'))).toBe(false)
  })
})

describe('@chkit/core refreshable materialized views', () => {
  const baseMv = {
    database: 'analytics',
    name: 'daily_mv',
    to: { database: 'analytics', name: 'daily_rollup' },
    as: 'SELECT toDate(ts) AS day, count() AS total FROM analytics.events GROUP BY day',
  }

  test('renders CREATE with REFRESH EVERY + TO', () => {
    const mv = materializedView({
      ...baseMv,
      refresh: { every: '1 HOUR' },
    })
    const sql = toCreateSQL(mv)
    expect(sql).toContain('CREATE MATERIALIZED VIEW IF NOT EXISTS analytics.daily_mv')
    expect(sql).toContain('REFRESH EVERY 1 HOUR')
    expect(sql).toContain('TO analytics.daily_rollup')
    expect(sql).not.toContain('APPEND')
    expect(sql).not.toContain('EMPTY')
  })

  test('renders CREATE with APPEND + OFFSET + RANDOMIZE + SETTINGS', () => {
    const mv = materializedView({
      ...baseMv,
      refresh: {
        every: '1 DAY',
        offset: '2 HOUR',
        randomize: '5 MINUTE',
        settings: { refresh_retries: 3 },
        append: true,
      },
    })
    const sql = toCreateSQL(mv)
    expect(sql).toContain('REFRESH EVERY 1 DAY OFFSET 2 HOUR RANDOMIZE FOR 5 MINUTE')
    expect(sql).toContain('SETTINGS refresh_retries = 3')
    expect(sql).toContain('APPEND')
    expect(sql).toContain('TO analytics.daily_rollup')
  })

  test('renders CREATE with DEPENDS ON and EMPTY', () => {
    const mv = materializedView({
      ...baseMv,
      refresh: {
        every: '1 HOUR',
        dependsOn: [{ database: 'analytics', name: 'upstream_mv' }],
        empty: true,
      },
    })
    const sql = toCreateSQL(mv)
    expect(sql).toContain('REFRESH EVERY 1 HOUR DEPENDS ON analytics.upstream_mv')
    expect(sql).toContain(' EMPTY AS')
  })

  test('diff: adding refresh to an existing MV triggers drop+recreate (structural)', () => {
    const oldDefs = [materializedView(baseMv)]
    const newDefs = [materializedView({ ...baseMv, refresh: { every: '1 HOUR' } })]
    const plan = planDiff(oldDefs, newDefs)
    expect(plan.operations.map((op) => op.type)).toEqual([
      'drop_materialized_view',
      'create_materialized_view',
    ])
  })

  test('diff: removing refresh triggers drop+recreate', () => {
    const oldDefs = [materializedView({ ...baseMv, refresh: { every: '1 HOUR' } })]
    const newDefs = [materializedView(baseMv)]
    const plan = planDiff(oldDefs, newDefs)
    expect(plan.operations.map((op) => op.type)).toEqual([
      'drop_materialized_view',
      'create_materialized_view',
    ])
  })

  test('diff: toggling APPEND triggers drop+recreate (Rule 1)', () => {
    const oldDefs = [
      materializedView({ ...baseMv, refresh: { every: '1 HOUR', append: true } }),
    ]
    const newDefs = [
      materializedView({ ...baseMv, refresh: { every: '1 HOUR' } }),
    ]
    const plan = planDiff(oldDefs, newDefs)
    expect(plan.operations.map((op) => op.type)).toEqual([
      'drop_materialized_view',
      'create_materialized_view',
    ])
  })

  test('diff: schedule-only change emits MODIFY REFRESH', () => {
    const oldDefs = [materializedView({ ...baseMv, refresh: { every: '1 HOUR' } })]
    const newDefs = [materializedView({ ...baseMv, refresh: { every: '30 MINUTE' } })]
    const plan = planDiff(oldDefs, newDefs)
    expect(plan.operations).toHaveLength(1)
    const op = plan.operations[0]
    expect(op?.type).toBe('alter_materialized_view_modify_refresh')
    expect(op?.sql).toContain('ALTER TABLE analytics.daily_mv MODIFY REFRESH EVERY 30 MINUTE')
    expect(op?.sql).not.toContain('APPEND')
  })

  test('diff: schedule-only change on APPEND MV preserves APPEND in MODIFY REFRESH (Rule 2)', () => {
    const oldDefs = [
      materializedView({ ...baseMv, refresh: { every: '1 HOUR', append: true } }),
    ]
    const newDefs = [
      materializedView({ ...baseMv, refresh: { every: '30 SECOND', append: true } }),
    ]
    const plan = planDiff(oldDefs, newDefs)
    expect(plan.operations).toHaveLength(1)
    const op = plan.operations[0]
    expect(op?.type).toBe('alter_materialized_view_modify_refresh')
    expect(op?.sql).toContain('MODIFY REFRESH EVERY 30 SECOND')
    expect(op?.sql).toContain('APPEND')
  })

  test('diff: randomize/dependsOn/settings changes emit MODIFY REFRESH', () => {
    const oldDefs = [materializedView({ ...baseMv, refresh: { every: '1 HOUR' } })]
    const newDefs = [
      materializedView({
        ...baseMv,
        refresh: {
          every: '1 HOUR',
          randomize: '1 MINUTE',
          dependsOn: [{ database: 'analytics', name: 'upstream' }],
          settings: { refresh_retries: 5 },
        },
      }),
    ]
    const plan = planDiff(oldDefs, newDefs)
    expect(plan.operations).toHaveLength(1)
    const op = plan.operations[0]
    expect(op?.type).toBe('alter_materialized_view_modify_refresh')
    expect(op?.sql).toContain('RANDOMIZE FOR 1 MINUTE')
    expect(op?.sql).toContain('DEPENDS ON analytics.upstream')
    expect(op?.sql).toContain('SETTINGS refresh_retries = 5')
  })

  test('diff: equivalent refresh yields no ops', () => {
    const defs = [
      materializedView({
        ...baseMv,
        refresh: { every: '1 HOUR', append: true },
      }),
    ]
    const plan = planDiff(defs, defs)
    expect(plan.operations).toEqual([])
  })

  test('MODIFY REFRESH ranks with other alters', () => {
    const oldDefs = [
      table({
        database: 'analytics',
        name: 'daily_rollup',
        columns: [{ name: 'day', type: 'Date' }],
        engine: 'MergeTree()',
        primaryKey: ['day'],
        orderBy: ['day'],
      }),
      materializedView({ ...baseMv, refresh: { every: '1 HOUR' } }),
    ]
    const newDefs = [
      table({
        database: 'analytics',
        name: 'daily_rollup',
        columns: [
          { name: 'day', type: 'Date' },
          { name: 'total', type: 'UInt64' },
        ],
        engine: 'MergeTree()',
        primaryKey: ['day'],
        orderBy: ['day'],
      }),
      materializedView({ ...baseMv, refresh: { every: '30 MINUTE' } }),
    ]
    const plan = planDiff(oldDefs, newDefs)
    const types = plan.operations.map((op) => op.type)
    // All alter ops come together (rank 1), neither before drops nor after creates.
    const firstAlter = types.indexOf('alter_table_add_column')
    const firstRefresh = types.indexOf('alter_materialized_view_modify_refresh')
    expect(firstAlter).toBeGreaterThanOrEqual(0)
    expect(firstRefresh).toBeGreaterThanOrEqual(0)
    // No create_* follow the alters
    const lastCreate = Math.max(
      types.lastIndexOf('create_database'),
      types.lastIndexOf('create_table'),
      types.lastIndexOf('create_view'),
      types.lastIndexOf('create_materialized_view')
    )
    expect(Math.max(firstAlter, firstRefresh)).toBeLessThan(
      lastCreate === -1 ? Number.POSITIVE_INFINITY : lastCreate + 1
    )
  })

  test('canonicalization uppercases intervals and sorts dependsOn/settings', () => {
    const defs = canonicalizeDefinitions([
      materializedView({
        ...baseMv,
        refresh: {
          every: '1 hour',
          randomize: '30 seconds',
          dependsOn: [
            { database: 'z', name: 'b' },
            { database: 'a', name: 'a' },
          ],
          settings: { refresh_retries: 3, refresh_retry_initial_backoff_ms: 100 },
        },
      }),
    ])
    const mv = defs[0]
    expect(mv?.kind).toBe('materialized_view')
    if (mv?.kind !== 'materialized_view' || !mv.refresh) throw new Error('expected refresh')
    expect(mv.refresh.every).toBe('1 HOUR')
    expect(mv.refresh.randomize).toBe('30 SECOND')
    expect(mv.refresh.dependsOn).toEqual([
      { database: 'a', name: 'a' },
      { database: 'z', name: 'b' },
    ])
    expect(Object.keys(mv.refresh.settings ?? {})).toEqual([
      'refresh_retries',
      'refresh_retry_initial_backoff_ms',
    ])
  })

  test('validates refresh requires exactly one of every/after', () => {
    const missing = validateDefinitions([
      materializedView({ ...baseMv, refresh: {} }),
    ])
    expect(missing.map((i) => i.code)).toContain('refresh_requires_every_or_after')

    const both = validateDefinitions([
      materializedView({ ...baseMv, refresh: { every: '1 HOUR', after: '10 MINUTE' } }),
    ])
    expect(both.map((i) => i.code)).toContain('refresh_every_after_mutually_exclusive')
  })

  test('validates interval format', () => {
    const issues = validateDefinitions([
      materializedView({ ...baseMv, refresh: { every: 'soonish' } }),
    ])
    expect(issues.map((i) => i.code)).toContain('refresh_interval_format')
  })

  test('validates DEPENDS ON is only allowed with REFRESH EVERY', () => {
    const withAfter = validateDefinitions([
      materializedView({
        ...baseMv,
        refresh: {
          after: '10 MINUTE',
          dependsOn: [{ database: 'analytics', name: 'upstream' }],
        },
      }),
    ])
    expect(withAfter.map((i) => i.code)).toContain('refresh_depends_on_requires_every')

    const withEvery = validateDefinitions([
      materializedView({
        ...baseMv,
        refresh: {
          every: '1 HOUR',
          dependsOn: [{ database: 'analytics', name: 'upstream' }],
        },
      }),
    ])
    expect(withEvery.some((i) => i.code === 'refresh_depends_on_requires_every')).toBe(false)
  })

  test('validates non-APPEND RMV with replicated target (Rule 3)', () => {
    const issues = validateDefinitions([
      table({
        database: 'analytics',
        name: 'daily_rollup',
        columns: [{ name: 'day', type: 'Date' }],
        engine: 'SharedMergeTree',
        primaryKey: ['day'],
        orderBy: ['day'],
      }),
      materializedView({ ...baseMv, refresh: { every: '1 HOUR' } }),
    ])
    expect(issues.map((i) => i.code)).toContain('refresh_append_required_for_replicated_target')
  })

  test('no issue when APPEND RMV targets replicated table', () => {
    const issues = validateDefinitions([
      table({
        database: 'analytics',
        name: 'daily_rollup',
        columns: [{ name: 'day', type: 'Date' }],
        engine: 'SharedMergeTree',
        primaryKey: ['day'],
        orderBy: ['day'],
      }),
      materializedView({ ...baseMv, refresh: { every: '1 HOUR', append: true } }),
    ])
    expect(
      issues.some((i) => i.code === 'refresh_append_required_for_replicated_target')
    ).toBe(false)
  })

  test('no issue when target table is not in the schema (external)', () => {
    const issues = validateDefinitions([
      materializedView({ ...baseMv, refresh: { every: '1 HOUR' } }),
    ])
    expect(
      issues.some((i) => i.code === 'refresh_append_required_for_replicated_target')
    ).toBe(false)
  })
})
