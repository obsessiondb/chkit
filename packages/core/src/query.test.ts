import { describe, expect, test } from 'bun:test'
import { z } from 'zod'

import { p, type QueryInterpolation, query, t, table } from './index.js'

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

  test('a subquery ending in a line comment is closed on the next line', () => {
    const commented = query`SELECT city FROM ${events} -- every city`

    expect(query`SELECT * FROM ${commented} LIMIT 1`.sql).toBe('SELECT * FROM (SELECT city FROM `app`.`events` -- every city\n) LIMIT 1')
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

  test('maps every p shorthand, t type and plain Zod schema to its ClickHouse type', () => {
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
      [p('v', t.fixedString(16)), 'FixedString(16)'],
      [p('v', t.int128()), 'Int128'],
      [p('v', t.int256()), 'Int256'],
      [p('v', t.uint128()), 'UInt128'],
      [p('v', t.uint256()), 'UInt256'],
      [p('v', t.decimal(10, 2)), 'Decimal(10, 2)'],
      [p('v', t.date32()), 'Date32'],
      [p('v', t.dateTime('Asia/Tokyo')), "DateTime('Asia/Tokyo')"],
      [p('v', t.dateTime64(6, 'UTC')), "DateTime64(6, 'UTC')"],
      [p('v', t.ipv4()), 'IPv4'],
      [p('v', t.ipv6()), 'IPv6'],
      [p('v', t.enum8({ view: 1, "it's": 2 })), "Enum8('view' = 1, 'it\\'s' = 2)"],
      [p('v', t.enum16({ a: -1000 })), "Enum16('a' = -1000)"],
      [p('v', t.json()), 'JSON'],
      [p('v', t.array(t.lowCardinality(t.string()))), 'Array(LowCardinality(String))'],
      [p('v', t.map(t.string(), t.nullable(t.uint8()))), 'Map(String, Nullable(UInt8))'],
      [p('v', t.lowCardinality(t.nullable(t.string()))), 'LowCardinality(Nullable(String))'],
      [p('v', t.lowCardinality(t.string()).optional()), 'LowCardinality(Nullable(String))'],
      [p('v', t.simpleAggregateFunction('max', t.dateTime())), 'SimpleAggregateFunction(max, DateTime)'],
      [p('v', z.string()), 'String'],
      [p('v', z.int()), 'Int64'],
      [p('v', z.number()), 'Float64'],
      [p('v', z.boolean()), 'Bool'],
      [p('v', z.date()), 'DateTime64(3)'],
      [p('v', z.array(z.string())), 'Array(String)'],
      [p('v', z.array(t.date())), 'Array(Date)'],
      [p('v', z.record(z.string(), z.int())), 'Map(String, Int64)'],
      [p('v', z.uuid()), 'UUID'],
      [p('v', z.ipv4()), 'IPv4'],
      [p('v', z.ipv6()), 'IPv6'],
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
    expect(() => query`SELECT ${t.string() as unknown as QueryInterpolation}`).toThrow('a param needs a name')
    expect(() => query`SELECT ${'Berlin' as unknown as QueryInterpolation}`).toThrow('only p params, queries and chkit')
    expect(() => query`SELECT ${p.string('city name')}`).toThrow('param name "city name" must match')
    expect(() => query`SELECT ${p('tags', z.array(z.string())).optional()}`).toThrow(
      'query: param "tags": ClickHouse has no Nullable(Array(String)); use .default() instead of .optional() or .nullable()',
    )
  })

  test('p throws for a type ClickHouse cannot take as a param', () => {
    expect(() => p('tags', z.array(z.string()).optional())).toThrow('p("tags"): ClickHouse has no Nullable(Array(String))')
    expect(() => p('pair', t.tuple([t.string(), t.uint8()]) as never)).toThrow(
      "p(\"pair\"): Tuple(String, UInt8) can't be a query param: Tuple is a column-only type",
    )
    expect(() => p('state', z.array(t.aggregateFunction('uniq', t.string())) as never)).toThrow(
      "Array(AggregateFunction(uniq, String)) can't be a query param: AggregateFunction is a column-only type",
    )
    expect(() => p('doc', z.object({ a: z.string() }))).toThrow('p("doc"): No ClickHouse type for Zod "object"')
  })
})
