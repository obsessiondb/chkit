import { describe, expect, test } from 'bun:test'
import type { z } from 'zod'

import { p, planDiff, query, t, table } from './index.js'

const types: Array<[string, z.ZodType, string]> = [
  ['id', t.uuid(), 'UUID'],
  ['city', t.lowCardinality(t.string()), 'LowCardinality(String)'],
  ['kind', t.enum8({ view: 1, "it's": 2 }), "Enum8('view' = 1, 'it\\'s' = 2)"],
  ['amount', t.decimal(18, 4), 'Decimal(18, 4)'],
  ['big', t.uint256(), 'UInt256'],
  ['day', t.date32(), 'Date32'],
  ['at', t.dateTime64(3, 'UTC'), "DateTime64(3, 'UTC')"],
  ['ip', t.ipv6(), 'IPv6'],
  ['tags', t.array(t.lowCardinality(t.string())), 'Array(LowCardinality(String))'],
  ['counts', t.map(t.string(), t.nullable(t.uint32())), 'Map(String, Nullable(UInt32))'],
  ['pair', t.tuple([t.string(), t.uint8()]), 'Tuple(String, UInt8)'],
  ['point', t.tuple({ x: t.float64(), y: t.float64() }), 'Tuple(x Float64, y Float64)'],
  ['items', t.nested({ sku: t.string(), qty: t.uint16() }), 'Nested(sku String, qty UInt16)'],
  ['doc', t.json(), 'JSON'],
  ['value', t.variant(t.uint64(), t.string(), t.array(t.uint8())), 'Variant(Array(UInt8), String, UInt64)'],
  ['anything', t.dynamic(), 'Dynamic'],
  ['visitors', t.aggregateFunction('uniq', t.string()), 'AggregateFunction(uniq, String)'],
  ['seen', t.simpleAggregateFunction('max', t.dateTime()), 'SimpleAggregateFunction(max, DateTime)'],
]
const base = { database: 'app', name: 'events', engine: 'MergeTree', orderBy: ['id'] }

describe('t types in tables', () => {
  test('a table renders t types as type strings and plans the same migration as one written with the strings', () => {
    const withT = table({ ...base, columns: [...types.map(([name, type]) => ({ name, type })), { name: 'code', type: t.fixedString(2), nullable: true }] })
    const withStrings = table({ ...base, columns: [...types.map(([name, , type]) => ({ name, type })), { name: 'code', type: 'FixedString(2)', nullable: true }] })

    expect(withT.columns).toEqual(withStrings.columns)
    expect(planDiff([], [withT])).toEqual(planDiff([], [withStrings]))
    expect(planDiff([withStrings], [withT]).operations).toEqual([])
  })

  test('column() returns the t type a column was declared with, for use as a param', () => {
    const city = t.lowCardinality(t.string())
    const events = table({ ...base, columns: [{ name: 'id', type: 'UUID' }, { name: 'city', type: city }] })

    expect(events.column('city')).toBe(city)
    expect(query`SELECT id FROM ${events} WHERE city = ${p('city', events.column('city'))}`.sql).toBe(
      'SELECT id FROM `app`.`events` WHERE city = {city:LowCardinality(String)}',
    )
    expect(() => events.column('id' as never)).toThrow('app.events has no column "id" with a t type')
  })
})
