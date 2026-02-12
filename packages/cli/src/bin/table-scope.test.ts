import { describe, expect, test } from 'bun:test'

import { filterPlanByTableScope, parseTableSelector, resolveTableScope } from './table-scope.js'

describe('table scope selector', () => {
  test('parses exact selector and prefix selector', () => {
    expect(parseTableSelector('events_raw')).toEqual({
      database: undefined,
      mode: 'exact',
      value: 'events_raw',
    })
    expect(parseTableSelector('analytics.events_*')).toEqual({
      database: 'analytics',
      mode: 'prefix',
      value: 'events_',
    })
  })

  test('rejects invalid wildcard selectors', () => {
    expect(() => parseTableSelector('*events')).toThrow('Invalid --table selector')
    expect(() => parseTableSelector('events*raw')).toThrow('Invalid --table selector')
    expect(() => parseTableSelector('*')).toThrow('Invalid --table selector')
  })

  test('resolves selector across databases when database is omitted', () => {
    const scope = resolveTableScope('events_*', ['analytics.events_raw', 'default.events_rollup', 'default.users'])
    expect(scope.enabled).toBe(true)
    expect(scope.matchCount).toBe(2)
    expect(scope.matchedTables).toEqual(['analytics.events_raw', 'default.events_rollup'])
  })
})

describe('table scope plan filter', () => {
  test('keeps only in-scope table operations and recomputes risk summary', () => {
    const result = filterPlanByTableScope(
      {
        operations: [
          {
            type: 'create_database',
            key: 'database:app',
            risk: 'safe',
            sql: 'CREATE DATABASE IF NOT EXISTS app;',
          },
          {
            type: 'alter_table_add_column',
            key: 'table:app.users:column:country',
            risk: 'safe',
            sql: 'ALTER TABLE app.users ADD COLUMN country String;',
          },
          {
            type: 'alter_table_drop_column',
            key: 'table:app.events:column:legacy',
            risk: 'danger',
            sql: 'ALTER TABLE app.events DROP COLUMN legacy;',
          },
        ],
        renameSuggestions: [
          {
            kind: 'column',
            database: 'app',
            table: 'users',
            from: 'email',
            to: 'user_email',
            confidence: 'high',
            reason: 'same signature',
            dropOperationKey: 'table:app.users:column:email',
            addOperationKey: 'table:app.users:column:user_email',
            confirmationSQL: 'ALTER TABLE app.users RENAME COLUMN `email` TO `user_email`;',
          },
          {
            kind: 'column',
            database: 'app',
            table: 'events',
            from: 'source',
            to: 'origin',
            confidence: 'high',
            reason: 'same signature',
            dropOperationKey: 'table:app.events:column:source',
            addOperationKey: 'table:app.events:column:origin',
            confirmationSQL: 'ALTER TABLE app.events RENAME COLUMN `source` TO `origin`;',
          },
        ],
        riskSummary: { safe: 2, caution: 0, danger: 1 },
      },
      new Set(['app.users'])
    )

    expect(result.plan.operations.map((operation) => operation.key)).toEqual([
      'database:app',
      'table:app.users:column:country',
    ])
    expect(result.plan.renameSuggestions.map((suggestion) => suggestion.table)).toEqual(['users'])
    expect(result.plan.riskSummary).toEqual({ safe: 2, caution: 0, danger: 0 })
    expect(result.omittedOperationCount).toBe(1)
  })
})
