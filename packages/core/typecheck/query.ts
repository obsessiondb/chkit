import { createClient } from '@clickhouse/client'
import { z } from 'zod'

import { createQuery, p, type QueryResult, query as unboundQuery, t, table } from '../src/index.js'

// Compile-time checks of the query API's inference; `bun run typecheck` runs them.
// Queries are exported so declaration emit is checked too.

type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false
type Input<Q extends { params: z.ZodType }> = z.input<Q['params']>
type Output<Q extends { params: z.ZodType }> = z.output<Q['params']>
function assertType<T extends true>(): T | undefined {
  return undefined
}

const client = createClient({ url: 'http://localhost:8123' })
export const query = createQuery(client)
export const lazyQuery = createQuery(async () => createClient({ url: 'http://localhost:8123' }))
export const syncQuery = createQuery(() => client)
export const quietQuery = createQuery(client, { logComment: false })

export const events = table({
  database: 'app',
  name: 'events',
  engine: 'MergeTree',
  columns: [
    { name: 'city', type: t.lowCardinality(t.string()) },
    { name: 'kind', type: t.enum8({ view: 1, click: 2 }) },
    { name: 'pair', type: t.tuple([t.string(), t.uint8()]) },
    { name: 'ts', type: 'DateTime64(3)' },
  ],
  orderBy: ['city'],
})

export const cityEvents = query`SELECT * FROM ${events} WHERE city = ${p.string('city')}`
export const topCities = query({ name: 'top_cities', version: 2, returns: z.object({ city: z.string(), n: z.number() }) })`
  SELECT city, count() AS n FROM ${cityEvents} GROUP BY city LIMIT ${p.uint32('limit').default(10)}
`
assertType<Equal<Input<typeof topCities>, { city: string; limit?: number | undefined }>>()
assertType<Equal<Output<typeof topCities>, { city: string; limit: number }>>()

const since = p.dateTime64('since')
export const busy = query`
  SELECT city FROM ${events}
  WHERE ts >= ${since} AND toDate(ts) >= toDate(${since})
    AND (${p.string('label').optional()} IS NULL OR has(${p('tags', z.array(z.string()))}, city))
`
export const busyTop = query({ name: 'busy_top' })`SELECT * FROM ${busy} LIMIT ${p.uint8('limit').default(1)}`
assertType<Equal<Input<typeof busy>, { since: Date | string; label?: string | undefined; tags: string[] }>>()
assertType<
  Equal<Input<typeof busyTop>, { limit?: number | undefined; since: Date | string; label?: string | undefined; tags: string[] }>
>()

const noParams = query`SELECT 1`
export const noInputs: Input<typeof noParams>[] = [
  {},
  // @ts-expect-error unknown param
  { city: 'Berlin' },
]

// Names and types survive refinements and up to two wrappers.
export const wrapped = query`
  SELECT ${p.string('a').min(1).optional()}, ${p('b', z.int().nullable())},
    ${p.uint8('c').refine((c) => c > 0).default(1)}, ${p.date('d').optional().default('2026-01-01')},
    ${p.int64('e')}, ${p('f', t.array(t.date()))}
`
assertType<
  Equal<
    Input<typeof wrapped>,
    {
      a?: string | undefined
      b: number | null
      c?: number | undefined
      d?: Date | string | undefined
      e: bigint | number
      f: (Date | string)[]
    }
  >
>()

// t types and table columns infer their values.
export const typed = query`
  SELECT * FROM ${events} WHERE city = ${p('city', events.column('city'))} AND kind = ${p('kind', events.column('kind'))}
    AND ${p('amount', t.decimal(10, 2))} > 0 AND ${p('big', t.int128())} > 0 AND ${p('day', t.date32())} > 0
    AND ${p('at', t.dateTime64(3, 'Asia/Tokyo'))} > 0 AND ${p('tags', t.array(t.lowCardinality(t.string())))} = []
    AND ${p('counts', t.map(t.string(), t.nullable(t.uint8())))} = map() AND ${p('id', t.fixedString(16))} = ''
`
assertType<
  Equal<
    Input<typeof typed>,
    {
      city: string
      kind: 'view' | 'click'
      amount: number | string
      big: bigint | number
      day: Date | string
      at: Date | string
      tags: string[]
      counts: Record<string, number | null>
      id: string
    }
  >
>()

export const columns = [
  // @ts-expect-error a column with a type string
  events.column('ts'),
  // @ts-expect-error no such column
  events.column('nope'),
]

const rejected = [
  // @ts-expect-error a plain Zod schema has no name
  query`SELECT ${z.string()}`,
  // @ts-expect-error a shorthand called without a name
  query`SELECT ${p.string()}`,
  // @ts-expect-error a column-only type
  p('pair', t.tuple([t.string(), t.uint8()])),
  // @ts-expect-error a column-only type inside an array
  p('pairs', t.array(t.tuple({ name: t.string() }))),
  // @ts-expect-error a column-only column
  p('pair', events.column('pair')),
  // @ts-expect-error an unnamed wrapped schema
  query`SELECT ${z.string().optional()}`,
  // @ts-expect-error a plain value
  query`SELECT ${'Berlin'}`,
]

export async function calls() {
  const rows = await topCities({ city: 'Berlin' })
  assertType<Equal<typeof rows, { city: string; n: number }[]>>()
  const untyped = await cityEvents({ city: 'Berlin' })
  assertType<Equal<typeof untyped, Record<string, unknown>[]>>()
  const typed = await noParams.returns<{ one: number }>()()
  assertType<Equal<typeof typed, { one: number }[]>>()
  const result = await topCities.raw({ city: 'Berlin' })
  assertType<Equal<typeof result, Awaited<ReturnType<typeof client.query>>>>()
  const unboundResult = await unboundQuery`SELECT 1`.raw(undefined, { client })
  assertType<Equal<typeof unboundResult, QueryResult>>()
  // @ts-expect-error raw takes the same params as a call
  await topCities.raw({ limit: 3 })

  await topCities(
    { city: 'Berlin', limit: 3 },
    { query_id: 'q1', clickhouse_settings: { max_threads: 2 }, abort_signal: new AbortController().signal, client },
  )
  await unboundQuery`SELECT ${p.string('city')}`({ city: 'Berlin' }, { client })
  await noParams()
  await noParams({}, { logComment: false })
  // @ts-expect-error logComment is a boolean
  createQuery(client, { logComment: 'no' })
  // @ts-expect-error city is required
  await topCities({ limit: 3 })
  // @ts-expect-error limit is a number
  await topCities({ city: 'Berlin', limit: '3' })
  // @ts-expect-error unknown param
  await topCities({ city: 'Berlin', nope: 1 })
  // @ts-expect-error params are required
  await busy()
  // @ts-expect-error unknown call option
  await noParams({}, { nope: true })
}

void rejected
