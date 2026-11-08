---
title: Queries
description: Define typed ClickHouse queries as tagged templates, compose them and call them with their params.
sidebar:
  order: 5
---

`query` defines a ClickHouse query as a tagged template: params are named with `p` and typed with `t`, queries compose as subqueries, and a query is called with its params. `@chkit/core` needs `zod@^4.3` installed.

## Bind a client

```ts
// db.ts
import { createClient } from '@clickhouse/client'
import { createQuery } from '@chkit/core'

export const query = createQuery(createClient({ url: process.env.CLICKHOUSE_URL }))
```

`createQuery` also takes a function that returns a client, sync or async. It runs on the first call, is cached, and runs again if it throws:

```ts
export const query = createQuery(async () => createClient(await loadConfig()))
```

## Define and call a query

```ts
import { p } from '@chkit/core'
import { query } from './db'
import { events } from './schema'

export const cityEvents = query`
  SELECT * FROM ${events} WHERE city = ${p.string('city')}
`

const rows = await cityEvents({ city: 'Berlin' })
```

A template accepts named params, other queries, and chkit tables, views and dictionaries. Anything else is a type error.

## Types

`t` types are shared by table columns and params. Each is a Zod schema of the values a param accepts, tagged with its ClickHouse type:

```ts
import { p, t, table } from '@chkit/core'
import { query } from './db'

export const events = table({
  database: 'app',
  name: 'events',
  engine: 'MergeTree',
  columns: [
    { name: 'city', type: t.lowCardinality(t.string()) },
    { name: 'tags', type: t.array(t.string()) },
  ],
  orderBy: ['city'],
})

export const cityEvents = query`
  SELECT * FROM ${events} WHERE city = ${p('city', events.column('city'))}
`
```

- A column takes a `t` type or a type string. A `t` type renders to its type string, so migrations and drift checks are the same.
- `events.column(name)` returns the `t` type of a column, to type a param like the column.

| `t` type | ClickHouse | Param accepts |
|---|---|---|
| `t.string()`, `t.fixedString(n)` | String, FixedString(n) | string |
| `t.bool()` | Bool | boolean |
| `t.int8()` to `t.int32()`, `t.uint8()` to `t.uint32()` | Int8 to Int32, UInt8 to UInt32 | number, range-checked |
| `t.int64()` to `t.int256()`, `t.uint64()` to `t.uint256()` | Int64 to Int256, UInt64 to UInt256 | number or bigint |
| `t.float32()`, `t.float64()` | Float32, Float64 | number |
| `t.decimal(precision, scale)` | Decimal(P, S) | number or decimal string |
| `t.date()`, `t.date32()` | Date, Date32 | `Date` or `YYYY-MM-DD` |
| `t.dateTime(timezone?)`, `t.dateTime64(precision = 3, timezone?)` | DateTime, DateTime64(n) | `Date` or ISO string |
| `t.uuid()`, `t.ipv4()`, `t.ipv6()` | UUID, IPv4, IPv6 | string |
| `t.enum8({ view: 1 })`, `t.enum16(...)` | Enum8, Enum16 | a name |
| `t.json()` | JSON | JSON value |
| `t.array(T)`, `t.map(K, V)` | Array(T), Map(K, V) | array, object |
| `t.nullable(T)`, `t.lowCardinality(T)`, `t.simpleAggregateFunction(fn, T)` | wraps T | T's value, or null for Nullable |
| `t.tuple(...)`, `t.nested(...)`, `t.variant(...)`, `t.dynamic()`, `t.aggregateFunction(...)` | Tuple, Nested, Variant, Dynamic, AggregateFunction | column only |

## Params

`p(name, type)` names a `t` type, a column's type or any Zod schema. The shorthands `p.string`, `p.bool`, `p.int8` to `p.int64`, `p.uint8` to `p.uint64`, `p.float32`, `p.float64`, `p.date`, `p.dateTime`, `p.dateTime64` and `p.uuid` name the matching `t` type: `p.string('city')` is `p('city', t.string())`. `p.identifier` names an Identifier.

- A column-only type is a type error, and `p` throws for it.
- Plain Zod maps by default: `z.string()` → String, `z.int()` → Int64, `z.number()` → Float64, `z.date()` → DateTime64(3), `z.uuid()`/`z.ipv4()`/`z.ipv6()` → UUID/IPv4/IPv6, `z.array(T)` → Array(T), `z.record(z.string(), T)` → Map(String, T). Set another type with `schema.meta({ clickhouse: 'LowCardinality(String)' })`.
- `.default()` makes a param optional. `.optional()` makes it `Nullable(T)`, sent as NULL when omitted.
- Values are validated strictly: `"10"` fails `p.uint32`.
- A param used twice is hoisted to a const:

```ts
const since = p.dateTime64('since')

export const recent = query`
  SELECT * FROM ${events} WHERE ts >= ${since} AND toDate(ts) >= toDate(${since})
`
```

## Compose queries

```ts
export const topCities = query`
  SELECT city, count() AS n FROM ${cityEvents}
  GROUP BY city ORDER BY n DESC LIMIT ${p.uint32('limit').default(10)}
`

await topCities({ city: 'Berlin' })
```

- An interpolated query is inlined as a subquery, and params merge by name.
- One value feeds every use of a name. Use different names when the values should differ.
- Defining a query throws when one name has two ClickHouse types or two defaults.

## Name, version and rows

```ts
export const topCities = query({ name: 'top_cities', version: 2, returns: z.object({ city: z.string(), n: z.number() }) })`
  SELECT city, count() AS n FROM ${cityEvents} GROUP BY city
`
```

- A named query sends `log_comment` `{"query":"top_cities","version":2}`, so it can be found in `system.query_log`. `version` defaults to 1.
- `returns` parses every row. `.returns<Row>()` sets the row type without parsing.

## Call options

```ts
await topCities({ city: 'Berlin' }, {
  query_id: 'req-42',
  clickhouse_settings: { max_threads: 2 },
  abort_signal: AbortSignal.timeout(5_000),
  client: testClient, // instead of the bound client
})
```

## Inspect a query

- `topCities.sql` is the SQL sent to ClickHouse, with `{name:Type}` placeholders.
- `topCities.params` is a `z.object` of every param, e.g. `topCities.params.parse(body)` to validate request input.
- `topCities.name` and `topCities.version` come from the options.

## Related pages

- [Schema DSL reference](/schema/dsl-reference/): the tables, views and dictionaries a query reads.
- [chkit query](/cli/query/): run ad-hoc SQL from the CLI.
