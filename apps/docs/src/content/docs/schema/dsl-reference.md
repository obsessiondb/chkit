---
title: Schema DSL Reference
description: Complete reference for chkit schema definition functions, column types, and table options.
sidebar:
  order: 3
---

Schema files are TypeScript files that export definitions using functions from `@chkit/core`. All exported definitions are collected when chkit loads schema files matched by the `schema` glob in your [configuration](/configuration/overview/).

```ts
import { schema, table, view, materializedView } from '@chkit/core'
```

## `schema()`

Groups definitions into a single array for export.

```ts
schema(...definitions: SchemaDefinition[]): SchemaDefinition[]
```

```ts
export default schema(users, events)
```

You can also export definitions individually -- any exported value with a valid `kind` is discovered automatically.

## `table()`

Creates a table definition.

```ts
table(input: Omit<TableDefinition, 'kind'>): TableDefinition
```

**Minimal example:**

```ts
import { schema, table } from '@chkit/core'

const users = table({
  database: 'app',
  name: 'users',
  columns: [
    { name: 'id', type: 'UInt64' },
    { name: 'email', type: 'String' },
  ],
  engine: 'MergeTree()',
  primaryKey: ['id'],
  orderBy: ['id'],
})

export default schema(users)
```

**Comprehensive example (all features):**

```ts
const events = table({
  database: 'analytics',
  name: 'events',
  columns: [
    { name: 'id', type: 'UInt64' },
    { name: 'org_id', type: 'String' },
    { name: 'source', type: 'LowCardinality(String)' },
    { name: 'payload', type: 'String', nullable: true },
    { name: 'received_at', type: 'DateTime64(3)', default: 'fn:now64(3)' },
    { name: 'status', type: 'String', default: 'pending', comment: 'Event processing status' },
  ],
  engine: 'MergeTree()',
  primaryKey: ['id'],
  orderBy: ['org_id', 'received_at', 'id'],
  partitionBy: 'toYYYYMM(received_at)',
  ttl: 'received_at + INTERVAL 90 DAY',
  settings: { index_granularity: 8192 },
  indexes: [
    { name: 'idx_source', expression: 'source', type: 'set', maxRows: 0, granularity: 1 },
  ],
  projections: [
    { name: 'p_recent', query: 'SELECT id ORDER BY received_at DESC LIMIT 10' },
  ],
  comment: 'Raw ingested events',
})
```

### Required fields

| Field | Type | Description |
|-------|------|-------------|
| `database` | `string` | ClickHouse database name |
| `name` | `string` | Table name |
| `columns` | `ColumnDefinition[]` | Column definitions (see [Columns](#columns)) |
| `engine` | `string` | Engine clause, e.g. `'MergeTree()'`, `'ReplacingMergeTree(ver)'` |
| `primaryKey` | `string[]` | Primary key columns |
| `orderBy` | `string[]` | ORDER BY columns |

### Optional fields

| Field | Type | Description |
|-------|------|-------------|
| `partitionBy` | `string` | Partition expression, e.g. `'toYYYYMM(created_at)'` |
| `uniqueKey` | `string[]` | Unique key columns |
| `ttl` | `string` | TTL expression, e.g. `'created_at + INTERVAL 90 DAY'` |
| `settings` | `Record<string, string \| number \| boolean>` | Table-level settings |
| `indexes` | `SkipIndexDefinition[]` | Skip indexes (see [Skip indexes](#skip-indexes)) |
| `projections` | `ProjectionDefinition[]` | Projections (see [Projections](#projections)) |
| `comment` | `string` | Table comment |
| `renamedFrom` | `{ database?: string; name: string }` | Previous identity for rename tracking (see [Rename support](#rename-support)) |
| `plugins` | `TablePlugins` | Per-table plugin configuration (see [Plugin configuration](#plugin-configuration)) |

:::note
The `engine` field accepts any string. Common engines include `MergeTree()`, `ReplacingMergeTree()`, `SummingMergeTree()`, `AggregatingMergeTree()`, and `CollapsingMergeTree(sign)`.
:::

:::note
Key clause arrays support comma-separated strings: `['id, org_id']` is normalized to `['id', 'org_id']`. Prefer one column per array element for clarity.
:::

## Columns

Each entry in the `columns` array is a `ColumnDefinition`.

### `name` (string, required)

Column name.

### `type` (string, required)

Any ClickHouse type string. Parameterized types like `DateTime64(3)`, `Decimal(18, 4)`, `Enum8('a' = 1, 'b' = 2)`, and `FixedString(32)` are supported.

Primitive types recognized by the DSL type system: `String`, `UInt8`, `UInt16`, `UInt32`, `UInt64`, `UInt128`, `UInt256`, `Int8`, `Int16`, `Int32`, `Int64`, `Int128`, `Int256`, `Float32`, `Float64`, `Bool`, `Boolean`, `Date`, `DateTime`, `DateTime64`.

### `nullable` (boolean, optional)

When `true`, the column type is wrapped in `Nullable(...)` in the generated SQL.

```ts
{ name: 'payload', type: 'String', nullable: true }
// SQL: `payload` Nullable(String)
```

### `default` (string | number | boolean, optional)

Default value for the column.

- **String** values are single-quoted in SQL: `default: 'pending'` produces `DEFAULT 'pending'`
- **Number/boolean** values are rendered literally: `default: 0` produces `DEFAULT 0`
- **`fn:` prefix** -- for function-call defaults, prefix the string with `fn:` to emit a raw SQL expression:

```ts
{ name: 'received_at', type: 'DateTime64(3)', default: 'fn:now64(3)' }
// SQL: `received_at` DateTime64(3) DEFAULT now64(3)
```

### `comment` (string, optional)

Column-level comment rendered in SQL.

### `renamedFrom` (string, optional)

Previous column name for rename tracking. See [Rename support](#rename-support).

### `codec` (ColumnCodecSpec, optional)

Sets the column compression codec, rendered as a `CODEC(...)` clause. A codec is an object with a `kind`, or an **array** forming a chain (zero or more preprocessors followed by exactly one general codec).

```ts
columns: [
  { name: 'ts', type: 'DateTime64(3)', codec: { kind: 'Delta', size: 4 } },
  { name: 'amount', type: 'Float64', codec: { kind: 'ZSTD', level: 3 } },
  // chain: preprocessor then general codec
  { name: 'seq', type: 'UInt64', codec: [{ kind: 'DoubleDelta' }, { kind: 'LZ4HC', level: 9 }] },
]
```

**General codecs** (the compressor; at most one, and it must come last in a chain):

| `kind` | Args | Renders |
|--------|------|---------|
| `NONE`, `LZ4`, `T64`, `GCD`, `ALP` | — | `CODEC(LZ4)` |
| `LZ4HC` | `level?: number` | `CODEC(LZ4HC(9))` |
| `ZSTD` | `level?: number` | `CODEC(ZSTD(3))` |

**Preprocessing codecs** (placed before the general codec):

| `kind` | Args | Renders |
|--------|------|---------|
| `Delta`, `DoubleDelta`, `Gorilla` | `size?: 1 \| 2 \| 4 \| 8` (bytes, defaults to 1) | `CODEC(Delta(4))` |
| `FPC` | `level: number`, `floatSize: 4 \| 8` | `CODEC(FPC(...))` |

**Raw escape hatch** — for codecs not yet typed (new ClickHouse versions, unusual arg shapes), pass the inner expression through verbatim:

```ts
{ name: 'blob', type: 'String', codec: { kind: 'raw', expression: 'T64, LZ4' } }
// → CODEC(T64, LZ4)
```

:::caution
Use the typed `{ kind: 'ZSTD', level: 3 }` shape — an unrecognized shape such as `codec: { general: 'ZSTD' }` is **not** a valid `ColumnCodecSpec` and renders an empty `CODEC()`, silently shipping a column with no codec.
:::

Codec chains are validated (see [Validation rules](#validation-rules)): a chain must be non-empty, contain at most one general codec, and end with the general codec.

## Skip indexes

Each entry in the `indexes` array is a `SkipIndexDefinition`. The shared base fields are:

| Field | Type | Description |
|-------|------|-------------|
| `name` | `string` | Index name |
| `expression` | `string` | Indexed expression |
| `type` | `'minmax' \| 'set' \| 'bloom_filter' \| 'tokenbf_v1' \| 'ngrambf_v1'` | Index type |
| `granularity` | `number` | Index granularity |

Type-specific fields:

| Type | Required fields | Optional fields | Notes |
|------|-----------------|-----------------|-------|
| `minmax` | — | — | No arguments |
| `set` | `maxRows: number` | — | `maxRows: 0` stores all unique values (ClickHouse 26+ requires `set(0)` rather than bare `set`) |
| `bloom_filter` | — | `falsePositiveRate: number` | Defaults to `0.025` when omitted |
| `tokenbf_v1` | `sizeBytes`, `hashFunctions`, `randomSeed` (all `number`) | — | Maps to `tokenbf_v1(size_bytes, n_hash, seed)` |
| `ngrambf_v1` | `ngramSize`, `sizeBytes`, `hashFunctions`, `randomSeed` (all `number`) | — | Maps to `ngrambf_v1(n, size_bytes, n_hash, seed)` |

```ts
indexes: [
  { name: 'idx_source', expression: 'source', type: 'set', maxRows: 0, granularity: 1 },
  { name: 'idx_ts', expression: 'received_at', type: 'minmax', granularity: 3 },
  {
    name: 'idx_body',
    expression: 'body',
    type: 'tokenbf_v1',
    sizeBytes: 256,
    hashFunctions: 2,
    randomSeed: 0,
    granularity: 1,
  },
]
```

## Projections

Each entry in the `projections` array is a `ProjectionDefinition`.

| Field | Type | Description |
|-------|------|-------------|
| `name` | `string` | Projection name |
| `query` | `string` | Projection SELECT query |

```ts
projections: [
  { name: 'p_recent', query: 'SELECT id ORDER BY received_at DESC LIMIT 10' },
]
```

## `view()`

Creates a view definition.

```ts
view(input: Omit<ViewDefinition, 'kind'>): ViewDefinition
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `database` | `string` | yes | Database name |
| `name` | `string` | yes | View name |
| `as` | `string` | yes | SELECT query |
| `comment` | `string` | no | View comment |

```ts
import { view } from '@chkit/core'

const activeUsers = view({
  database: 'app',
  name: 'active_users',
  as: 'SELECT id, email FROM app.users WHERE active = 1',
})
```

## `materializedView()`

Creates a materialized view definition.

```ts
materializedView(input: Omit<MaterializedViewDefinition, 'kind'>): MaterializedViewDefinition
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `database` | `string` | yes | Database name |
| `name` | `string` | yes | Materialized view name |
| `to` | `{ database: string; name: string }` | yes | Target table for the view |
| `refresh` | `MaterializedViewRefresh` | no | Refresh schedule — see [Refreshable materialized views](/schema/refreshable-views/) |
| `as` | `string` | yes | SELECT query |
| `comment` | `string` | no | View comment |

```ts
import { materializedView } from '@chkit/core'

const eventCounts = materializedView({
  database: 'analytics',
  name: 'event_counts_mv',
  to: { database: 'analytics', name: 'event_counts' },
  as: 'SELECT org_id, count() AS total FROM analytics.events GROUP BY org_id',
})
```

For a refreshable (scheduled) materialized view, add the `refresh` field:

```ts
const dailyReport = materializedView({
  database: 'analytics',
  name: 'daily_report_mv',
  to: { database: 'analytics', name: 'daily_report' },
  refresh: { every: '1 DAY', offset: '2 HOUR' },
  as: 'SELECT toDate(ts) AS day, count() AS total FROM analytics.events GROUP BY day',
})
```

See [Refreshable materialized views](/schema/refreshable-views/) for the full `refresh` field reference, including APPEND mode, `DEPENDS ON`, and the ClickHouse rules that chkit validates.

## Type system reference

The [codegen plugin](/plugins/codegen/) maps ClickHouse types to TypeScript types using these rules:

| Category | ClickHouse Types | TypeScript Type |
|----------|-----------------|-----------------|
| String-like | `String`, `FixedString`, `Date`, `Date32`, `DateTime`, `DateTime64`, `UUID`, `IPv4`, `IPv6`, `Enum8`, `Enum16`, `Decimal*` | `string` |
| Number | `Int8`, `Int16`, `Int32`, `UInt8`, `UInt16`, `UInt32`, `Float32`, `Float64`, `BFloat16` | `number` |
| Large integers | `Int64`, `Int128`, `Int256`, `UInt64`, `UInt128`, `UInt256` | `string` (default) or `bigint` |
| Boolean | `Bool`, `Boolean` | `boolean` |
| Wrappers | `Nullable(T)` | `T \| null` |
| Wrappers | `LowCardinality(T)` | same as `T` |
| Composite | `Array(T)` | `T[]` |
| Composite | `Map(K, V)` | `Record<K, V>` |
| Composite | `Tuple(T1, T2, ...)` | `[T1, T2, ...]` |
| Aggregate | `SimpleAggregateFunction(fn, T)` | same as `T` |
| JSON | `JSON` | `Record<string, unknown>` |

Parameterized types like `DateTime('UTC')`, `Decimal(18, 4)`, and `Enum8('a' = 1)` are supported. The `bigintMode` option in the codegen plugin controls whether large integers map to `string` or `bigint`.

## Rename support

chkit tracks renames to avoid destructive drop-and-recreate operations.

### Table rename

Set `renamedFrom` on a table definition to rename a table:

```ts
const users = table({
  database: 'app',
  name: 'accounts', // new name
  renamedFrom: { name: 'users' }, // old name
  // ...
})
```

The `database` field in `renamedFrom` is optional and defaults to the table's current database.

### Column rename

Set `renamedFrom` on a column definition to rename a column:

```ts
columns: [
  { name: 'user_email', type: 'String', renamedFrom: 'email' },
]
```

Both table and column renames can be overridden by CLI flags `--rename-table` and `--rename-column`.

## Plugin configuration

The `plugins` field on a table definition provides per-table configuration for plugins. Each plugin that supports table-level config augments the `TablePlugins` interface via TypeScript declaration merging, so the available keys and their types depend on which plugin packages are imported.

```ts
import { table } from '@chkit/core'

const events = table({
  database: 'app',
  name: 'events',
  columns: [
    { name: 'event_time', type: 'DateTime' },
    { name: 'id', type: 'UInt64' },
  ],
  engine: 'MergeTree',
  orderBy: ['event_time', 'id'],
  primaryKey: ['event_time', 'id'],
  plugins: {
    backfill: { timeColumn: 'event_time' },
  },
})
```

Currently supported plugin keys:

| Key | Plugin | Fields | Description |
|-----|--------|--------|-------------|
| `backfill` | [`@chkit/plugin-backfill`](/plugins/backfill/) | `timeColumn?: string` | Time column for backfill WHERE clauses |

The `plugins` field is ignored by the diff engine — it does not affect migration planning or SQL generation.

## Validation rules

chkit validates schema definitions and throws a `ChxValidationError` if any issues are found:

- **Duplicate object names** -- two definitions with the same `kind`, `database`, and `name`
- **Duplicate column names** -- repeated column name within a table
- **Duplicate index names** -- repeated index name within a table
- **Duplicate projection names** -- repeated projection name within a table
- **Primary key references missing column** -- `primaryKey` includes a column not in `columns`
- **Order by references missing column** -- `orderBy` includes a column not in `columns`
- **Empty codec chain** (`codec_chain_empty`) -- a `codec` array with no steps; provide at least one codec or omit the field
- **Multiple general codecs** (`codec_chain_multiple_general`) -- more than one general codec in a chain; only one is allowed
- **Codec chain must end with a general codec** (`codec_chain_must_end_with_general`) -- preprocessors must precede the single general codec (`NONE`, `LZ4`, `LZ4HC`, `ZSTD`, `T64`, `GCD`, `ALP`)

## Structural vs. alterable properties

When a property changes, chkit determines whether the table can be altered in place or must be dropped and recreated.

**Structural** (drop + recreate): `engine`, `primaryKey`, `orderBy`, `partitionBy`, `uniqueKey`

**Alterable** (ALTER in place): columns, indexes, projections, settings, TTL, comment

Views and materialized views always use drop + recreate.

:::danger
Changing a structural property on an existing table generates a `DROP TABLE` followed by `CREATE TABLE` — **all rows are permanently deleted and the table is recreated empty**. The data is not copied over. The drop is classified `risk=danger` (blocked without `--allow-destructive`) and `chkit migrate` flags it with the distinct `table_recreate_data_loss` warning. To preserve data, migrate by hand instead: create a new table with the desired structure, `INSERT INTO new SELECT ... FROM old`, then swap names and drop the old table.
:::
