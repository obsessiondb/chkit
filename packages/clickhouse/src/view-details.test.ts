import { describe, expect, test } from 'bun:test'

import { parseMaterializedViewTarget } from './view-details.js'

describe('parseMaterializedViewTarget', () => {
  test('reads the TO target ClickHouse stores', () => {
    expect(
      parseMaterializedViewTarget(
        "CREATE MATERIALIZED VIEW app.orders_mv TO app.orders_by_day (`day` Date, `amount` UInt64) AS SELECT day, amount FROM app.orders WHERE status != 'Refunded'",
        'app'
      )
    ).toEqual({ database: 'app', name: 'orders_by_day' })
  })

  test('reads a quoted target after a REFRESH clause and DEFINER', () => {
    expect(
      parseMaterializedViewTarget(
        "CREATE MATERIALIZED VIEW `my-db`.mv REFRESH EVERY 1 HOUR SETTINGS refresh_retries = 2 APPEND TO `my-db`.`to` (`n` UInt64) DEFINER = default SQL SECURITY DEFINER AS SELECT 1 AS n",
        'my-db'
      )
    ).toEqual({ database: 'my-db', name: 'to' })
  })

  test('an unqualified target falls back to the view database', () => {
    expect(parseMaterializedViewTarget('CREATE MATERIALIZED VIEW mv TO target AS SELECT 1', 'app')).toEqual({
      database: 'app',
      name: 'target',
    })
  })

  test('a materialized view with an inner table has no target', () => {
    expect(
      parseMaterializedViewTarget(
        'CREATE MATERIALIZED VIEW app.mv (`id` UInt64) ENGINE = MergeTree ORDER BY id SETTINGS index_granularity = 8192 AS SELECT id FROM app.src WHERE x TO y',
        'app'
      )
    ).toBeUndefined()
  })
})
