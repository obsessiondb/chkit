import { describe, expect, test } from 'bun:test'

import { materializedView, planDiff } from './index'

/**
 * #41: create operations within the same kind were tie-broken purely by name.
 * A refreshable materialized view declared `DEPENDS ON other_mv` must be
 * created after its dependency, so ordering by name alone can place a dependent
 * view before the view it depends on and fail.
 */
describe('planDiff materialized-view creation order (#41)', () => {
  test('a DEPENDS ON target is created before the view that depends on it, even when names sort the other way', () => {
    // `aaa_dependent` sorts before `zzz_base`, but it DEPENDS ON `zzz_base`,
    // so a name-only order would create it first and fail.
    const base = materializedView({
      database: 'default',
      name: 'zzz_base',
      to: { database: 'default', name: 'zzz_base_target' },
      as: 'SELECT id FROM default.source',
    })
    const dependent = materializedView({
      database: 'default',
      name: 'aaa_dependent',
      to: { database: 'default', name: 'aaa_dependent_target' },
      refresh: {
        every: '1 HOUR',
        dependsOn: [{ database: 'default', name: 'zzz_base' }],
      },
      as: 'SELECT id FROM default.zzz_base_target',
    })

    const plan = planDiff([], [dependent, base])
    const order = plan.operations
      .filter((op) => op.type === 'create_materialized_view')
      .map((op) => op.key)

    expect(order).toEqual([
      'materialized_view:default.zzz_base',
      'materialized_view:default.aaa_dependent',
    ])
  })

  test('independent materialized views keep a stable alphabetical order', () => {
    const first = materializedView({
      database: 'default',
      name: 'mv_a',
      to: { database: 'default', name: 'mv_a_target' },
      as: 'SELECT id FROM default.source',
    })
    const second = materializedView({
      database: 'default',
      name: 'mv_b',
      to: { database: 'default', name: 'mv_b_target' },
      as: 'SELECT id FROM default.source',
    })

    const plan = planDiff([], [second, first])
    const order = plan.operations
      .filter((op) => op.type === 'create_materialized_view')
      .map((op) => op.key)

    expect(order).toEqual([
      'materialized_view:default.mv_a',
      'materialized_view:default.mv_b',
    ])
  })
})
