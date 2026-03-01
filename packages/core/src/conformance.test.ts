import { describe, expect, test } from 'bun:test'

import {
  canonicalizeDefinitions,
  formatIdentifier,
  planDiff,
  table,
  toCreateSQL,
  view,
  materializedView,
} from './index.js'

describe('core conformance', () => {
  test('canonicalization is idempotent and planner is stable on canonical output', () => {
    const definitions = [
      table({
        database: 'app',
        name: 'events',
        columns: [
          { name: 'id', type: 'UInt64' },
          { name: 'source', type: 'LowCardinality(String)' },
          { name: 'recorded_at', type: 'DateTime64(3)', default: 'fn:now64(3)' },
        ],
        engine: 'MergeTree',
        primaryKey: ['id'],
        orderBy: ['id'],
        settings: {
          index_granularity: 8192,
          min_rows_for_wide_part: 0,
        },
        indexes: [
          { name: 'idx_source', expression: 'source', type: 'set', granularity: 1 },
        ],
      }),
      view({
        database: 'app',
        name: 'events_view',
        as: 'SELECT id, source FROM app.events',
      }),
      materializedView({
        database: 'app',
        name: 'events_mv',
        to: { database: 'app', name: 'events' },
        as: 'SELECT id, source FROM app.events',
      }),
    ]

    const canonicalA = canonicalizeDefinitions(definitions)
    const canonicalB = canonicalizeDefinitions(canonicalA)
    expect(canonicalB).toEqual(canonicalA)

    const plan = planDiff(canonicalA, canonicalB)
    expect(plan.operations).toEqual([])
    expect(plan.riskSummary).toEqual({ safe: 0, caution: 0, danger: 0 })
  })

  test('renders quoted identifiers for non-simple names', () => {
    const sql = toCreateSQL(
      table({
        database: 'analytics-prod',
        name: 'event-log',
        columns: [{ name: 'user id', type: 'String' }],
        engine: 'MergeTree',
        primaryKey: ['user id'],
        orderBy: ['user id'],
      })
    )

    expect(sql).toContain('CREATE TABLE IF NOT EXISTS `analytics-prod`.`event-log`')
    expect(sql).toContain('`user id` String')
    expect(formatIdentifier('simple_name')).toBe('simple_name')
    expect(formatIdentifier('bad-name')).toBe('`bad-name`')
  })
})

