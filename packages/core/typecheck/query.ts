import { z } from 'zod'

import { p, query, table } from '../src/index.js'

// Compile-time checks of the query API's inference; `bun run typecheck` runs them.
// Queries are exported so declaration emit is checked too.

type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false
type Input<Q extends { params: z.ZodType }> = z.input<Q['params']>
type Output<Q extends { params: z.ZodType }> = z.output<Q['params']>
function assertType<T extends true>(): T | undefined {
  return undefined
}

const events = table({
  database: 'app',
  name: 'events',
  engine: 'MergeTree',
  columns: [{ name: 'city', type: 'String' }],
  orderBy: ['city'],
})

export const cityEvents = query`SELECT * FROM ${events} WHERE city = ${p.string('city')}`
export const topCities = query({ name: 'top_cities', version: 2 })`
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
    ${p.int64('e')}, ${p('f', z.array(p.date()))}
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

export const inputs: Input<typeof topCities>[] = [
  { city: 'Berlin' },
  // @ts-expect-error city is required
  { limit: 3 },
  // @ts-expect-error limit is a number
  { city: 'Berlin', limit: '3' },
  // @ts-expect-error unknown param
  { city: 'Berlin', nope: 1 },
]

const rejected = [
  // @ts-expect-error a plain Zod schema has no name
  query`SELECT ${z.string()}`,
  // @ts-expect-error a helper called without a name
  query`SELECT ${p.string()}`,
  // @ts-expect-error an unnamed wrapped schema
  query`SELECT ${z.string().optional()}`,
  // @ts-expect-error a plain value
  query`SELECT ${'Berlin'}`,
]
void rejected
