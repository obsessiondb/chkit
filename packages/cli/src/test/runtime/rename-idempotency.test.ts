import { describe, expect, test } from 'bun:test'

import type { MigrationPlan } from '@chkit/core'

import {
  applyExplicitTableRenames,
  buildExplicitColumnRenameSuggestions,
} from '../../commands/generate/plan-pipeline.js'

const EMPTY_RISK = { safe: 0, caution: 0, danger: 0 }

// Renames are made idempotent (IF EXISTS) so that, after a partial migration
// failure, a replay is a safe no-op instead of an "unknown identifier" brick.
describe('rename SQL idempotency', () => {
  test('explicit table rename emits RENAME TABLE IF EXISTS', () => {
    const plan: MigrationPlan = { operations: [], riskSummary: EMPTY_RISK, renameSuggestions: [] }
    const result = applyExplicitTableRenames(plan, [
      { oldDatabase: 'app', oldName: 'users', newDatabase: 'app', newName: 'customers', source: 'cli' },
    ])
    const op = result.operations.find((o) => o.type === 'alter_table_rename_table')
    expect(op?.sql).toBe('RENAME TABLE IF EXISTS app.users TO app.customers;')
  })

  test('explicit column rename suggestion emits RENAME COLUMN IF EXISTS', () => {
    const plan: MigrationPlan = {
      operations: [
        { type: 'alter_table_drop_column', key: 'table:app.t:column:a', risk: 'danger', sql: '' },
        { type: 'alter_table_add_column', key: 'table:app.t:column:b', risk: 'safe', sql: '' },
      ],
      riskSummary: EMPTY_RISK,
      renameSuggestions: [],
    }
    const suggestions = buildExplicitColumnRenameSuggestions(plan, [
      { database: 'app', table: 't', from: 'a', to: 'b', source: 'cli' },
    ])
    expect(suggestions[0]?.confirmationSQL).toBe('ALTER TABLE app.t RENAME COLUMN IF EXISTS `a` TO `b`;')
  })
})
