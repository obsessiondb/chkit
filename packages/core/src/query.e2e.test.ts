/**
 * Runs queries against a live ClickHouse: composition, query_log attribution,
 * every p shorthand's and t type's round trip, the column types a t-typed table
 * gets, the date serialization the API does itself and
 * the lazily resolved client.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { setTimeout as sleep } from 'node:timers/promises'
import { createClient } from '@clickhouse/client'
import { z } from 'zod'

import { createQuery, p, type QueryInterpolation, query, renderColumnType, t, table, toCreateSQL } from './index.js'

// Same target rules as getLiveEnv in @chkit/clickhouse/e2e-testkit, which core
// cannot depend on: without CLICKHOUSE_URL or CLICKHOUSE_HOST, use the local
// test stack (test/infra).
function getLiveEnv() {
  const host = process.env.CLICKHOUSE_HOST?.trim()
  const url = process.env.CLICKHOUSE_URL?.trim() || (host ? `https://${host}` : '')
  if (!url) {
    return { url: `http://localhost:${process.env.CHKIT_TEST_PORT?.trim() || '8123'}`, username: 'default', password: 'chkit-ci', database: 'default' }
  }
  const username = process.env.CLICKHOUSE_USER?.trim() || 'default'
  const password = process.env.CLICKHOUSE_PASSWORD?.trim() || ''
  const database = process.env.CLICKHOUSE_DB?.trim() || 'default'

  if (!password) throw new Error('Missing CLICKHOUSE_PASSWORD')

  return { url, username, password, database }
}

const env = getLiveEnv()
const client = createClient({ url: env.url, username: env.username, password: env.password, database: env.database })
const run = createQuery(client)
const suffix = `${Date.now()}_${Math.floor(Math.random() * 100000)}`
const events = table({
  database: env.database,
  name: `chkit_e2e_query_${suffix}`,
  engine: 'MergeTree',
  columns: [
    { name: 'city', type: 'String' },
    { name: 'ts', type: "DateTime64(3, 'UTC')" },
    { name: 'clicks', type: 'UInt32' },
  ],
  orderBy: ['city'],
})
const eventsName = `${env.database}.${events.name}`
const catalog = table({
  database: env.database,
  name: `chkit_e2e_types_${suffix}`,
  engine: 'MergeTree',
  columns: [
    { name: 'id', type: t.uuid() },
    { name: 'city', type: t.lowCardinality(t.string()) },
    { name: 'kind', type: t.enum8({ view: 1, "it's": 2 }) },
    { name: 'amount', type: t.decimal(18, 4) },
    { name: 'big', type: t.uint256() },
    { name: 'day', type: t.date32() },
    { name: 'at', type: t.dateTime64(3, 'UTC') },
    { name: 'code', type: t.fixedString(2), nullable: true },
    { name: 'ip', type: t.ipv6() },
    { name: 'tags', type: t.array(t.lowCardinality(t.string())) },
    { name: 'counts', type: t.map(t.string(), t.nullable(t.uint32())) },
    { name: 'pair', type: t.tuple([t.string(), t.uint8()]) },
    { name: 'point', type: t.tuple({ x: t.float64(), y: t.float64() }) },
    { name: 'doc', type: t.json() },
    { name: 'value', type: t.variant(t.uint64(), t.string(), t.array(t.uint8())) },
    { name: 'anything', type: t.dynamic() },
    { name: 'visitors', type: t.aggregateFunction('uniq', t.string()) },
    { name: 'seen', type: t.simpleAggregateFunction('max', t.dateTime()) },
  ],
  orderBy: ['id'],
})
const catalogName = `${env.database}.${catalog.name}`
const utc = { clickhouse_settings: { session_timezone: 'UTC' } }
const moment = new Date('2026-11-07T12:34:56.789Z')

// ObsessionDB DDL and inserts reach every replica eventually: re-read until the
// expected state appears, then let the caller's expect report the real diff.
async function pollUntil<T>(read: () => Promise<T>, done: (value: T) => boolean): Promise<T> {
  const deadline = Date.now() + 60_000
  for (;;) {
    try {
      const value = await read()
      if (done(value) || Date.now() >= deadline) return value
    } catch (error) {
      if (Date.now() >= deadline) throw error
    }
    await sleep(100)
  }
}

// A replica that has not applied the CREATE yet rejects an INSERT with
// UNKNOWN_TABLE, which writes nothing: re-run it until the replica serving it
// sees the table (runOnceVisible in @chkit/clickhouse/e2e-testkit) (#712).
async function runOnceVisible<T>(run: () => Promise<T>): Promise<T> {
  const deadline = Date.now() + 30_000
  for (;;) {
    try {
      return await run()
    } catch (error) {
      const text = `${(error as { type?: unknown }).type ?? ''} ${error instanceof Error ? error.message : String(error)}`
      if (Date.now() >= deadline || !text.includes('UNKNOWN_TABLE')) throw error
    }
    await sleep(500)
  }
}

beforeAll(async () => {
  await client.command({ query: toCreateSQL(events) })
  await runOnceVisible(() => client.insert({
    table: eventsName,
    format: 'JSONEachRow',
    values: [
      { city: 'Berlin', ts: '2026-11-01 10:00:00', clicks: 3 },
      { city: 'Berlin', ts: '2026-11-05 10:00:00', clicks: 5 },
      { city: 'Paris', ts: '2026-11-06 10:00:00', clicks: 7 },
    ],
  }))
  const countEvents = run`SELECT toUInt32(count()) AS n FROM ${events}`
  await pollUntil(() => countEvents(), (rows) => rows[0]?.n === 3)
}, 90_000)

// ObsessionDB users have no CREATE USER (or any access-management) grant
// (#430), so the tests that create users run in verify, against the local
// stack, only.
const onObsessionDB = process.env.CHKIT_E2E_TARGET === 'obsessiondb'
const users: string[] = []
const userClients: Array<ReturnType<typeof createClient>> = []

async function createUser(label: string, settings: string) {
  const name = `chkit_e2e_${label}_${suffix}`
  const password = crypto.randomUUID()
  users.push(name)
  await client.command({ query: `CREATE USER ${name} IDENTIFIED BY '${password}' ${settings}` })
  await client.command({ query: `GRANT SELECT ON *.* TO ${name}` })
  const userClient = createClient({ url: env.url, username: name, password, database: env.database })
  userClients.push(userClient)
  return userClient
}

afterAll(async () => {
  await client.command({ query: `DROP TABLE IF EXISTS ${eventsName}` })
  await client.command({ query: `DROP TABLE IF EXISTS ${catalogName}` })
  await Promise.all(userClients.map((userClient) => userClient.close()))
  for (const name of users) await client.command({ query: `DROP USER IF EXISTS ${name}` })
  await client.close()
})

describe('query execution', () => {
  test('a composed, named query runs with merged params, parses its rows and is attributed in query_log', async () => {
    const cityEvents = run`SELECT city, clicks FROM ${events} WHERE city = ${p.string('city')}`
    const topCities = run({
      name: `top_cities_${suffix}`,
      version: 2,
      returns: z.object({ city: z.string(), clicks: z.number() }),
    })`
      SELECT city, toUInt32(sum(clicks)) AS clicks FROM ${cityEvents}
      GROUP BY city ORDER BY clicks DESC LIMIT ${p.uint32('limit').default(10)}
    `
    const queryId = `chkit_e2e_query_${suffix}`

    expect(await topCities({ city: 'Berlin' }, { query_id: queryId, clickhouse_settings: { max_result_rows: 12345 } })).toEqual([
      { city: 'Berlin', clicks: 8 },
    ])

    const queryLog = run`
      SELECT log_comment, Settings['max_result_rows'] AS max_result_rows
      FROM clusterAllReplicas('default', system.query_log)
      WHERE query_id = ${p.string('queryId')} AND type = 'QueryFinish'
    `
    expect(await pollUntil(() => queryLog({ queryId }), (rows) => rows.length > 0)).toEqual([
      { log_comment: JSON.stringify({ query: `top_cities_${suffix}`, version: 2 }), max_result_rows: '12345' },
    ])
  }, 90_000)

  test('a param used twice, an omitted optional param and an array param', async () => {
    const since = p.dateTime64('since')
    const busy = run`
      SELECT city, toUInt32(count()) AS n FROM ${events}
      WHERE ts >= ${since} AND toDate(ts) >= toDate(${since})
        AND (${p.string('label').optional()} IS NULL OR has(${p('tags', z.array(z.string()))}, city))
      GROUP BY city ORDER BY city
    `

    expect(await busy({ since: '2026-11-04T00:00:00Z', tags: [] })).toEqual([
      { city: 'Berlin', n: 1 },
      { city: 'Paris', n: 1 },
    ])
    expect(await busy({ since: new Date('2026-11-04T00:00:00Z'), tags: ['Paris'], label: 'any' })).toEqual([
      { city: 'Paris', n: 1 },
    ])
  })

  test('every p shorthand, t type and mapped Zod type round-trips its value as its ClickHouse type', async () => {
    const cases: Array<[QueryInterpolation, unknown, string, string]> = [
      [p.string('v'), 'Berlin', 'String', 'Berlin'],
      [p.bool('v'), false, 'Bool', 'false'],
      [p.int8('v'), -128, 'Int8', '-128'],
      [p.int16('v'), 32767, 'Int16', '32767'],
      [p.int32('v'), -5, 'Int32', '-5'],
      [p.int64('v'), -9007199254740993n, 'Int64', '-9007199254740993'],
      [p.int64('v'), 42, 'Int64', '42'],
      [p.uint8('v'), 255, 'UInt8', '255'],
      [p.uint16('v'), 65535, 'UInt16', '65535'],
      [p.uint32('v'), 4294967295, 'UInt32', '4294967295'],
      [p.uint64('v'), 18446744073709551615n, 'UInt64', '18446744073709551615'],
      [p.float32('v'), 1.25, 'Float32', '1.25'],
      [p.float64('v'), 1.5, 'Float64', '1.5'],
      [p.date('v'), moment, 'Date', '2026-11-07'],
      [p.date('v'), '2026-11-07', 'Date', '2026-11-07'],
      [p.dateTime('v'), moment, 'DateTime', '2026-11-07 12:34:56'],
      [p.dateTime('v'), '2026-11-07T12:34:56Z', 'DateTime', '2026-11-07 12:34:56'],
      [p.dateTime64('v'), moment, 'DateTime64(3)', '2026-11-07 12:34:56.789'],
      [p.dateTime64('v'), '2026-11-07T12:34:56.789Z', 'DateTime64(3)', '2026-11-07 12:34:56.789'],
      [p.dateTime64('v', 6), '2026-11-07T12:34:56.789Z', 'DateTime64(6)', '2026-11-07 12:34:56.789000'],
      [p.dateTime64('v', 9), '2026-11-07T12:34:56.123456789Z', 'DateTime64(9)', '2026-11-07 12:34:56.123456789'],
      [p.dateTime64('v'), new Date('1969-12-31T23:59:58.500Z'), 'DateTime64(3)', '1969-12-31 23:59:58.500'],
      [p('v', z.date()), moment, 'DateTime64(3)', '2026-11-07 12:34:56.789'],
      [p('v', z.uuid()), '0b6ab9b4-7c4e-4f4b-9a39-2f1c3e1c5a10', 'UUID', '0b6ab9b4-7c4e-4f4b-9a39-2f1c3e1c5a10'],
      [p('v', z.ipv4()), '192.168.0.1', 'IPv4', '192.168.0.1'],
      [p('v', z.ipv6()), '2001:db8::1', 'IPv6', '2001:db8::1'],
      [p('v', z.record(z.string(), z.int())), { a: 1, "it's": -2 }, 'Map(String, Int64)', "{'a':1,'it\\'s':-2}"],
      [
        p('v', z.record(z.string(), z.array(t.dateTime64()))),
        { at: [moment, '2026-11-08T00:00:01.5Z'] },
        'Map(String, Array(DateTime64(3)))',
        "{'at':['2026-11-07 12:34:56.789','2026-11-08 00:00:01.500']}",
      ],
      [p('v', z.record(z.string(), t.date())), { day: moment }, 'Map(String, Date)', "{'day':'2026-11-07'}"],
      [p('v', z.record(z.int(), z.string())), { '-1': 'a' }, 'Map(Int64, String)', "{-1:'a'}"],
      [p.uuid('v'), '0b6ab9b4-7c4e-4f4b-9a39-2f1c3e1c5a10', 'UUID', '0b6ab9b4-7c4e-4f4b-9a39-2f1c3e1c5a10'],
      [p('v', t.fixedString(3)), 'ab', 'FixedString(3)', 'ab'],
      [p('v', t.int128()), -(2n ** 127n), 'Int128', String(-(2n ** 127n))],
      [p('v', t.uint256()), 2n ** 256n - 1n, 'UInt256', String(2n ** 256n - 1n)],
      [p('v', t.decimal(38, 10)), '1234567890123456789012345678.0123456789', 'Decimal(38, 10)', '1234567890123456789012345678.0123456789'],
      [p('v', t.decimal(10, 2)), 12.5, 'Decimal(10, 2)', '12.5'],
      [p('v', t.date32()), '1900-01-01', 'Date32', '1900-01-01'],
      [p('v', t.dateTime('Asia/Tokyo')), moment, "DateTime('Asia/Tokyo')", '2026-11-07 21:34:56'],
      [p('v', t.dateTime64(3, 'Asia/Tokyo')), moment, "DateTime64(3, 'Asia/Tokyo')", '2026-11-07 21:34:56.789'],
      [p('v', t.enum8({ view: 1, "it's": 2 })), "it's", "Enum8('view' = 1, 'it\\'s' = 2)", "it's"],
      [p('v', t.json()), { a: 'x', b: [true] }, 'JSON', '{"a":"x","b":[true]}'],
      [p('v', t.lowCardinality(t.nullable(t.string()))), null, 'LowCardinality(Nullable(String))', null],
      [p('v', t.lowCardinality(t.string()).nullable()), 'Berlin', 'LowCardinality(Nullable(String))', 'Berlin'],
      [p('v', t.array(t.int128())), [1n, -2], 'Array(Int128)', '[1,-2]'],
      [p('v', t.map(t.uint32(), t.nullable(t.string()))), { 7: 'a', 8: null }, 'Map(UInt32, Nullable(String))', "{7:'a',8:NULL}"],
      [p('v', t.map(t.decimal(8, 2), t.string())), { '1.25': 'a', '-3.50': 'b' }, 'Map(Decimal(8, 2), String)', "{1.25:'a',-3.5:'b'}"],
      [p('v', t.simpleAggregateFunction('max', t.dateTime())), moment, 'SimpleAggregateFunction(max, DateTime)', '2026-11-07 12:34:56'],
    ]

    const results = await Promise.all(
      cases.map(([schema, value]) => run`SELECT toTypeName(${schema}) AS type, toString(${schema}) AS value`({ v: value }, utc)),
    )
    expect(results).toEqual(cases.map(([, , type, value]) => [{ type, value }]))

    const sorted = run`SELECT number AS n FROM numbers(3) ORDER BY ${p.identifier('column')} DESC LIMIT 1`
    expect(await sorted({ column: 'n' })).toEqual([{ n: 2 }])
  })

  test('a t-typed table gets the column types it renders, and its columns type params', async () => {
    await client.command({ query: toCreateSQL(catalog) })
    const columns = run`
      SELECT name, type FROM system.columns
      WHERE database = ${p.string('database')} AND table = ${p.string('table')} ORDER BY position
    `
    expect(await pollUntil(() => columns({ database: env.database, table: catalog.name }), (rows) => rows.length > 0)).toEqual(
      catalog.columns.map((column) => ({ name: column.name, type: renderColumnType(column) })),
    )

    const row = { city: 'Berlin', kind: "it's", amount: '12.3456', big: 2n ** 256n - 1n, day: '1900-01-01', at: moment, tags: ['a'], counts: { a: 1, b: null } }
    await runOnceVisible(() => client.insert({
      table: catalogName,
      format: 'JSONEachRow',
      values: [{ ...row, id: '0b6ab9b4-7c4e-4f4b-9a39-2f1c3e1c5a10', big: String(row.big), at: '2026-11-07 12:34:56.789', seen: Math.floor(moment.getTime() / 1000) }],
    }))
    const matches = run`
      SELECT toUInt32(count()) AS n FROM ${catalog}
      WHERE city = ${p('city', catalog.column('city'))} AND kind = ${p('kind', catalog.column('kind'))}
        AND amount = ${p('amount', catalog.column('amount'))} AND big = ${p('big', catalog.column('big'))}
        AND day = ${p('day', catalog.column('day'))} AND at = ${p('at', catalog.column('at'))}
        AND tags = ${p('tags', catalog.column('tags'))} AND counts = ${p('counts', catalog.column('counts'))}
        AND seen = ${p('seen', catalog.column('seen'))}
    `
    expect(await pollUntil(() => matches({ ...row, seen: moment }), (rows) => rows[0]?.n === 1)).toEqual([{ n: 1 }])
  }, 90_000)

  test('rows keep integers a JS number would round as their digits, and returns can make them bigints or strings', async () => {
    const wide = run`
      SELECT toUInt64(18446744073709551615) AS u64, toInt128('-170141183460469231731687303715884105728') AS i128,
        toUInt32(4294967295) AS u32, toFloat64(0.1) AS f64
    `
    const asBigInt = run({ returns: z.object({ u64: z.coerce.bigint(), i128: z.coerce.bigint() }) })`SELECT * FROM ${wide}`
    const asString = run({ returns: z.object({ u64: z.coerce.string() }) })`SELECT * FROM ${wide}`

    expect(await wide()).toEqual([
      { u64: '18446744073709551615', i128: '-170141183460469231731687303715884105728', u32: 4294967295, f64: 0.1 },
    ])
    expect(await asBigInt()).toEqual([{ u64: 2n ** 64n - 1n, i128: -(2n ** 127n) }])
    expect(await asString()).toEqual([{ u64: '18446744073709551615' }])
  })

  test('raw returns the client result unparsed, streams, and still validates params', async () => {
    const wide = run`SELECT toUInt64(18446744073709551615) AS u64, toUInt32(number) AS n FROM numbers(${p.uint32('count')})`

    expect(await (await wide.raw({ count: 1 })).text()).toContain('18446744073709551615')
    const streamed: unknown[] = []
    for await (const rows of (await wide.raw({ count: 3 })).stream()) {
      for (const row of rows) streamed.push((row.json() as { n: number }).n)
    }
    expect(streamed).toEqual([0, 1, 2])
    await expect(wide.raw({ count: -1 })).rejects.toThrow('Too small')
  })

  test('dates inside arrays keep their day, seconds and milliseconds', async () => {
    const lists = run`
      SELECT toString(${p('days', t.array(t.date()))}) AS days, toString(${p('times', t.array(t.dateTime()))}) AS times,
        toString(${p('stamps', t.array(t.dateTime64()))}) AS stamps
    `

    expect(
      await lists({ days: [moment, '2026-11-08'], times: [moment, '2026-11-08T00:00:01Z'], stamps: [moment, '2026-11-08T00:00:01.5Z'] }, utc),
    ).toEqual([
      {
        days: "['2026-11-07','2026-11-08']",
        times: "['2026-11-07 12:34:56','2026-11-08 00:00:01']",
        stamps: "['2026-11-07 12:34:56.789','2026-11-08 00:00:01.500']",
      },
    ])
  })

  test('createQuery resolves a client function on the first call, caches it and retries it after a failure', async () => {
    let calls = 0
    const lazy = createQuery(async () => {
      calls += 1
      if (calls === 1) throw new Error('config not loaded yet')
      return client
    })
    const one = lazy`SELECT toUInt8(1) AS one`
    expect(calls).toBe(0)

    await expect(one()).rejects.toThrow('config not loaded yet')
    expect(await one()).toEqual([{ one: 1 }])
    expect(await one()).toEqual([{ one: 1 }])
    expect(calls).toBe(2)

    const sync = createQuery(() => client)
    expect(await sync`SELECT toUInt8(2) AS two`()).toEqual([{ two: 2 }])
  })

  test('call options pick the client and cancel; params and rows are validated', async () => {
    const echo = query`SELECT ${p.uint8('n')} AS n`

    await expect(echo({ n: 1 })).rejects.toThrow('no client')
    expect(await echo({ n: 1 }, { client })).toEqual([{ n: 1 }])
    await expect(
      query`SELECT sleep(3)`(undefined, { client, abort_signal: AbortSignal.timeout(100) }),
    ).rejects.toThrow('aborted')
    await expect(echo({ n: 256 }, { client })).rejects.toThrow('Too big')
    await expect(run`SELECT ${p.dateTime64('at')}`({ at: new Date(-500) })).rejects.toThrow('less than a second before 1970-01-01')
    await expect(run`SELECT ${p('keys', t.map(t.decimal(30, 20), t.string()))}`({ keys: { '0.00000000000000000001': 'a' } })).rejects.toThrow(
      "Decimal Map key 0.00000000000000000001 can't be sent without losing digits",
    )
    await expect(run({ returns: z.object({ n: z.string() }) })`SELECT toUInt8(1) AS n`()).rejects.toThrow('expected string')
  })
})

describe('named queries and log_comment', () => {
  test.skipIf(onObsessionDB)('a readonly = 1 user gets a clear error for a named query, and runs it with logComment: false', async () => {
    const readonly = await createUser('readonly', 'SETTINGS readonly = 1')
    const name = `readonly_${suffix}`
    const one = createQuery(readonly)({ name })`SELECT toUInt8(1) AS one`

    const refused = one()
    await expect(refused).rejects.toThrow(
      `query "${name}": ClickHouse refused log_comment because the user has readonly = 1. Give the user readonly = 2 or plain GRANT SELECT, or set logComment: false`,
    )
    await expect(refused).rejects.toMatchObject({
      cause: { message: expect.stringContaining("Cannot modify 'log_comment' setting in readonly mode") },
    })
    expect(await one(undefined, { logComment: false })).toEqual([{ one: 1 }])
    expect(await createQuery(readonly, { logComment: false })({ name })`SELECT toUInt8(1) AS one`()).toEqual([{ one: 1 }])
  })

  test.skipIf(onObsessionDB)('a user with only GRANT SELECT runs named queries with attribution', async () => {
    const reader = await createUser('reader', '')
    const name = `reader_${suffix}`
    const queryId = `chkit_e2e_reader_${suffix}`

    expect(await createQuery(reader)({ name })`SELECT toUInt8(1) AS one`(undefined, { query_id: queryId })).toEqual([{ one: 1 }])
    const queryLog = run`
      SELECT log_comment FROM clusterAllReplicas('default', system.query_log)
      WHERE query_id = ${p.string('queryId')} AND type = 'QueryFinish'
    `
    expect(await pollUntil(() => queryLog({ queryId }), (rows) => rows.length > 0)).toEqual([
      { log_comment: JSON.stringify({ query: name, version: 1 }) },
    ])
  }, 90_000)
})
