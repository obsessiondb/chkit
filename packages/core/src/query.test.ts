import { describe, expect, test } from 'bun:test'
import { z } from 'zod'

import { p, type QueryInterpolation, query, table } from './index.js'

const events = table({
  database: 'app',
  name: 'events',
  engine: 'MergeTree',
  columns: [
    { name: 'city', type: 'String' },
    { name: 'ts', type: 'DateTime64(3)' },
  ],
  orderBy: ['city'],
})

describe('query definitions', () => {
  test('a composed query inlines its parts as subqueries and merges their params by name', () => {
    const cityEvents = query`
      SELECT * FROM ${events} WHERE city = ${p.string('city')} LIMIT ${p.uint32('limit').default(10)}
    `
    const topCities = query({ name: 'top_cities', version: 2 })`
      SELECT city, count() AS n FROM ${cityEvents} GROUP BY city ORDER BY n DESC LIMIT ${p.uint32('limit').default(10)}
    `

    expect(topCities.sql).toBe(
      'SELECT city, count() AS n FROM (SELECT * FROM `app`.`events` WHERE city = {city:String} LIMIT {limit:UInt32}) GROUP BY city ORDER BY n DESC LIMIT {limit:UInt32}',
    )
    expect([topCities.name, topCities.version, cityEvents.name, cityEvents.version]).toEqual(['top_cities', 2, undefined, 1])
    expect(topCities.params.parse({ city: 'Berlin' })).toEqual({ city: 'Berlin', limit: 10 })
  })

  test('a param used twice renders the same placeholder', () => {
    const since = p.dateTime64('since')
    const busy = query`
      SELECT city FROM ${events}
      WHERE ts >= ${since} AND toDate(ts) >= toDate(${since})
        AND (${p.string('label').optional()} IS NULL OR has(${p('tags', z.array(z.string()))}, city))
    `

    expect(busy.sql).toBe(
      [
        'SELECT city FROM `app`.`events`',
        '      WHERE ts >= {since:DateTime64(3)} AND toDate(ts) >= toDate({since:DateTime64(3)})',
        '        AND ({label:Nullable(String)} IS NULL OR has({tags:Array(String)}, city))',
      ].join('\n'),
    )
    expect(Object.keys(busy.params.shape)).toEqual(['since', 'label', 'tags'])
  })

  test('maps every p helper and plain Zod schema to its ClickHouse type', () => {
    const cases: Array<[QueryInterpolation, string]> = [
      [p.string('v'), 'String'],
      [p.bool('v'), 'Bool'],
      [p.int8('v'), 'Int8'],
      [p.int16('v'), 'Int16'],
      [p.int32('v'), 'Int32'],
      [p.int64('v'), 'Int64'],
      [p.uint8('v'), 'UInt8'],
      [p.uint16('v'), 'UInt16'],
      [p.uint32('v'), 'UInt32'],
      [p.uint64('v'), 'UInt64'],
      [p.float32('v'), 'Float32'],
      [p.float64('v'), 'Float64'],
      [p.date('v'), 'Date'],
      [p.dateTime('v'), 'DateTime'],
      [p.dateTime64('v'), 'DateTime64(3)'],
      [p.dateTime64('v', 6), 'DateTime64(6)'],
      [p.uuid('v'), 'UUID'],
      [p.identifier('v'), 'Identifier'],
      [p('v', z.string()), 'String'],
      [p('v', z.int()), 'Int64'],
      [p('v', z.number()), 'Float64'],
      [p('v', z.boolean()), 'Bool'],
      [p('v', z.date()), 'DateTime64(3)'],
      [p('v', z.array(z.string())), 'Array(String)'],
      [p('v', z.array(p.date())), 'Array(Date)'],
      [p('v', z.string().optional()), 'Nullable(String)'],
      [p('v', z.string().meta({ clickhouse: 'LowCardinality(String)' })), 'LowCardinality(String)'],
    ]

    expect(cases.map(([schema]) => query`SELECT ${schema}`.sql)).toEqual(cases.map(([, type]) => `SELECT {v:${type}}`))
  })

  test('names and types survive refinements and wrappers', () => {
    const wrapped = query`
      SELECT ${p.string('a').min(1).optional()}, ${p.uint8('b').refine((b) => b > 0).default(1)},
        ${p('c', z.int().nullable())}, ${p.date('d').optional().default('2026-01-01')}
    `

    expect(wrapped.sql).toBe('SELECT {a:Nullable(String)}, {b:UInt8},\n        {c:Nullable(Int64)}, {d:Nullable(Date)}')
    expect(wrapped.params.parse({ c: null })).toEqual({ b: 1, c: null, d: '2026-01-01' })
  })

  test('params validate strictly, and every schema given one name must pass', () => {
    const twice = query`SELECT ${p.string('city').min(2)}, ${p.string('city').max(4)} LIMIT ${p.uint8('limit')}`

    expect(twice.params.safeParse({ city: 'Rome', limit: 1 }).success).toBe(true)
    expect(twice.params.safeParse({ city: 'R', limit: 1 }).success).toBe(false)
    expect(twice.params.safeParse({ city: 'Berlin', limit: 1 }).success).toBe(false)
    expect(twice.params.safeParse({ city: 'Rome', limit: '1' }).success).toBe(false)
    expect(twice.params.safeParse({ city: 'Rome', limit: 256 }).success).toBe(false)
  })

  test('defining a query throws on conflicting params and on values that are not params', () => {
    const inner = query`SELECT * FROM ${events} LIMIT ${p.uint32('limit').default(10)}`

    expect(() => query`SELECT * FROM ${inner} WHERE city = ${p.string('limit')}`).toThrow(
      'query: param "limit" is UInt32 in one part and String in another',
    )
    expect(() => query({ name: 'outer' })`SELECT * FROM ${inner} LIMIT ${p.uint32('limit').default(5)}`).toThrow(
      'query "outer": param "limit" has different defaults (10 and 5)',
    )
    expect(() => query`SELECT ${p.string() as unknown as QueryInterpolation}`).toThrow('a param needs a name')
    expect(() => query`SELECT ${'Berlin' as unknown as QueryInterpolation}`).toThrow('only p params, queries and chkit')
    expect(() => query`SELECT ${p.string('city name')}`).toThrow('param name "city name" must match')
  })
})
