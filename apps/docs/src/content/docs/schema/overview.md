---
title: Schema Overview
description: How chkit thinks about ClickHouse schema and where to learn each piece of the DSL.
sidebar:
  order: 1
---

In chkit, your ClickHouse schema lives in TypeScript files. You declare tables, views, materialized views, and dictionaries as plain values using functions from `@chkit/core`, group them with `schema()`, and let chkit handle the rest — diffing them against the database, generating migration SQL, and applying it safely.

A typical schema file looks like this:

```ts
import { schema, table } from '@chkit/core'

const events = table({
  database: 'default',
  name: 'events',
  engine: 'MergeTree',
  columns: [
    { name: 'id', type: 'UInt64' },
    { name: 'source', type: 'String' },
    { name: 'ingested_at', type: 'DateTime64(3)', default: 'fn:now64(3)' },
  ],
  primaryKey: ['id'],
  orderBy: ['id'],
  partitionBy: 'toYYYYMM(ingested_at)',
})

export default schema(events)
```

chkit discovers schema files using the `schema` glob in your [configuration](/configuration/overview/), so you can split definitions across as many files as you like.

## Concepts

- **Definitions** — tables, views, materialized views, and dictionaries are values created with `table()`, `view()`, `materializedView()`, and `dictionary()`. They describe the *desired* state of your database.
- **Schema groups** — `schema(...)` collects definitions into a single export, but any exported definition is also discovered automatically.
- **Diff + plan** — when you run `chkit generate`, chkit compares your schema to the live database (or the last applied state) and emits migration SQL.
- **Engines** — `MergeTree`, `ReplacingMergeTree`, `AggregatingMergeTree`, and their `Shared` variants for [ObsessionDB](https://obsessiondb.com) are all first-class.

## Reference

- [DSL Reference](/schema/dsl-reference/) — every function, option, and column type.
- [Refreshable Views](/schema/refreshable-views/) — using ClickHouse refreshable materialized views from chkit.

## Related

- [Configuration Overview](/configuration/overview/) — where the `schema` glob is set.
- [CLI: `chkit generate`](/cli/generate/) — how schema changes become migration SQL.
- [CLI: `chkit pull`](/cli/pull/) — bootstrap schema files from an existing ClickHouse database.
- [ObsessionDB: Engine Rewriting](/obsessiondb/engine-rewriting/) — how `Shared*` engines are stripped when the target isn't ObsessionDB.
