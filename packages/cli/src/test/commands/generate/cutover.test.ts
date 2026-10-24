import { describe, expect, test } from 'bun:test'

import { planDiff, table, type TableDefinition } from '@chkit/core'

import {
  applyCutovers,
  carryRetainedDefinitions,
  resolveCutoverFlags,
  summarizeCutover,
} from '../../../commands/generate/cutover.js'

const columns = [
  { name: 'id', type: 'UInt64' },
  { name: 'user_id', type: 'UInt64' },
]

function events(orderBy: string[], name = 'events'): TableDefinition {
  return table({ database: 'app', name, engine: 'MergeTree', columns, primaryKey: orderBy, orderBy })
}

const FLAGS = { cutover: [], copy: undefined, oldTable: undefined, dropRetained: [] }

describe('resolveCutoverFlags', () => {
  test('defaults to an in-migration copy that keeps the old table', () => {
    expect(resolveCutoverFlags({ ...FLAGS, cutover: ['app.events=id'] })).toEqual({
      requests: [{ database: 'app', table: 'events', key: ['id'] }],
      copy: 'migration',
      oldTable: 'keep',
    })
  })

  test('rejects invalid modes, repeated tables and modes without a cutover', () => {
    expect(() => resolveCutoverFlags({ ...FLAGS, cutover: ['app.events=id'], copy: 'inline' })).toThrow(
      'Invalid --cutover-copy "inline". Expected migration or backfill.'
    )
    expect(() => resolveCutoverFlags({ ...FLAGS, cutover: ['app.events=id'], oldTable: 'archive' })).toThrow(
      'Invalid --cutover-old "archive". Expected keep or drop.'
    )
    expect(() => resolveCutoverFlags({ ...FLAGS, cutover: ['app.events=id', 'app.events=user_id'] })).toThrow(
      '--cutover app.events is given more than once.'
    )
    expect(() => resolveCutoverFlags({ ...FLAGS, oldTable: 'drop' })).toThrow('add --cutover')
  })
})

describe('carryRetainedDefinitions', () => {
  const retained = { ...events(['id'], 'events_previous'), retainedBy: { cutover: 'app.events' } }
  const current = events(['user_id', 'id'])

  test('keeps a retained table planned as it is, so it never reads as a pending drop', () => {
    const definitions = carryRetainedDefinitions({ previousDefinitions: [current, retained], definitions: [current], dropRetained: [] })
    expect(definitions).toEqual([current, retained])
    expect(planDiff([current, retained], definitions).operations).toEqual([])
  })

  test('--drop-retained plans its DROP like any removed table', () => {
    const definitions = carryRetainedDefinitions({
      previousDefinitions: [current, retained],
      definitions: [current],
      dropRetained: ['app.events_previous'],
    })
    expect(definitions).toEqual([current])
    expect(planDiff([current, retained], definitions).operations.map((op) => [op.type, op.risk])).toEqual([
      ['drop_table', 'danger'],
    ])
  })

  test('--drop-retained only accepts a retained table', () => {
    expect(() =>
      carryRetainedDefinitions({ previousDefinitions: [current, retained], definitions: [current], dropRetained: ['app.events'] })
    ).toThrow('--drop-retained app.events: no table retained by a cutover has that name (retained: app.events_previous).')
  })
})

describe('applyCutovers', () => {
  const OLD = events(['id'])
  const NEW = events(['user_id', 'id'])

  test('replaces the DROP and CREATE of the structural change with the cutover', () => {
    const plan = planDiff([OLD], [NEW])
    expect(plan.operations.map((op) => op.type)).toEqual(['drop_table', 'create_table'])
    const result = applyCutovers({
      plan,
      previousDefinitions: [OLD],
      definitions: [NEW],
      cutovers: resolveCutoverFlags({ ...FLAGS, cutover: ['app.events=id'] }),
      cluster: undefined,
      stamp: '20261024120000',
    })
    expect(result.plan.operations.some((op) => op.type === 'drop_table' && op.key === 'table:app.events')).toBe(false)
    expect(result.plan.operations.filter((op) => op.type === 'exchange_tables')).toHaveLength(1)
    expect(result.plan.riskSummary).toEqual({ safe: 6, caution: 14, danger: 0 })
    expect(summarizeCutover(result.cutovers[0] as never)).toMatchObject({
      table: 'app.events',
      key: ['id'],
      retainedAs: 'app.events_previous',
      nextSteps: ['chkit migrate --apply'],
    })
  })

  test('refuses a table whose change is not a recreate', () => {
    expect(() =>
      applyCutovers({
        plan: planDiff([OLD], [OLD]),
        previousDefinitions: [OLD],
        definitions: [OLD],
        cutovers: resolveCutoverFlags({ ...FLAGS, cutover: ['app.events=id'] }),
        cluster: undefined,
        stamp: '20261024120000',
      })
    ).toThrow('--cutover app.events: the plan does not recreate app.events')
  })
})
