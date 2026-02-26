# Schema DSL Reference

## table() — Required Fields

| Field | Type | Description |
|-------|------|-------------|
| `database` | `string` | ClickHouse database name |
| `name` | `string` | Table name |
| `columns` | `ColumnDefinition[]` | Column definitions |
| `engine` | `string` | Engine clause: `'MergeTree()'`, `'ReplacingMergeTree(ver)'`, `'SummingMergeTree()'`, `'AggregatingMergeTree()'`, `'CollapsingMergeTree(sign)'` |
| `primaryKey` | `string[]` | Primary key columns |
| `orderBy` | `string[]` | ORDER BY columns |

## table() — Optional Fields

| Field | Type | Description |
|-------|------|-------------|
| `partitionBy` | `string` | Partition expression, e.g. `'toYYYYMM(created_at)'` |
| `uniqueKey` | `string[]` | Unique key columns |
| `ttl` | `string` | TTL expression, e.g. `'created_at + INTERVAL 90 DAY'` |
| `settings` | `Record<string, string \| number \| boolean>` | Table-level settings |
| `indexes` | `SkipIndexDefinition[]` | Skip indexes |
| `projections` | `ProjectionDefinition[]` | Projections |
| `comment` | `string` | Table comment |
| `renamedFrom` | `{ database?: string; name: string }` | Previous identity for rename tracking |

Key clause arrays support comma-separated strings: `['id, org_id']` normalizes to `['id', 'org_id']`.

## Column Definition

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `name` | `string` | yes | Column name |
| `type` | `string` | yes | Any ClickHouse type string |
| `nullable` | `boolean` | no | Wraps type in `Nullable(...)` |
| `default` | `string \| number \| boolean` | no | Default value (see below) |
| `comment` | `string` | no | Column comment |
| `renamedFrom` | `string` | no | Previous column name for rename tracking |

### Default value rules

- String: single-quoted in SQL — `default: 'pending'` → `DEFAULT 'pending'`
- Number/boolean: literal — `default: 0` → `DEFAULT 0`
- Function call: `fn:` prefix — `default: 'fn:now64(3)'` → `DEFAULT now64(3)`

### Primitive column types

`String`, `UInt8`, `UInt16`, `UInt32`, `UInt64`, `UInt128`, `UInt256`, `Int8`, `Int16`, `Int32`, `Int64`, `Int128`, `Int256`, `Float32`, `Float64`, `Bool`, `Boolean`, `Date`, `DateTime`, `DateTime64`

Parameterized types are supported: `DateTime64(3)`, `Decimal(18, 4)`, `Enum8('a' = 1, 'b' = 2)`, `FixedString(32)`, `LowCardinality(String)`, `Nullable(String)`, `Array(UInt64)`, `Map(String, UInt64)`, `Tuple(String, UInt64)`.

## Skip Indexes

| Field | Type | Description |
|-------|------|-------------|
| `name` | `string` | Index name |
| `expression` | `string` | Indexed expression |
| `type` | `'minmax' \| 'set' \| 'bloom_filter' \| 'tokenbf_v1' \| 'ngrambf_v1'` | Index type |
| `granularity` | `number` | Index granularity |

```ts
indexes: [
  { name: 'idx_source', expression: 'source', type: 'set', granularity: 1 },
  { name: 'idx_ts', expression: 'received_at', type: 'minmax', granularity: 3 },
]
```

## Projections

| Field | Type | Description |
|-------|------|-------------|
| `name` | `string` | Projection name |
| `query` | `string` | Projection SELECT query |

```ts
projections: [
  { name: 'p_recent', query: 'SELECT id ORDER BY received_at DESC LIMIT 10' },
]
```

## view()

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `database` | `string` | yes | Database name |
| `name` | `string` | yes | View name |
| `as` | `string` | yes | SELECT query |
| `comment` | `string` | no | View comment |

## materializedView()

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `database` | `string` | yes | Database name |
| `name` | `string` | yes | Materialized view name |
| `to` | `{ database: string; name: string }` | yes | Target table |
| `as` | `string` | yes | SELECT query |
| `comment` | `string` | no | View comment |

## Validation Rules

chkit validates schema definitions and throws `ChxValidationError` if:

- Duplicate object names (same `kind`, `database`, and `name`)
- Duplicate column names within a table
- Duplicate index names within a table
- Duplicate projection names within a table
- Primary key references missing column
- Order by references missing column

## Structural vs Alterable Properties

**Structural** (drop + recreate): `engine`, `primaryKey`, `orderBy`, `partitionBy`, `uniqueKey`
**Alterable** (ALTER in place): columns, indexes, projections, settings, TTL, comment

Views and materialized views always use drop + recreate.

## Type System (Codegen Plugin)

| Category | ClickHouse Types | TypeScript Type |
|----------|-----------------|-----------------|
| String-like | `String`, `FixedString`, `Date*`, `DateTime*`, `UUID`, `IPv4/6`, `Enum*`, `Decimal*` | `string` |
| Number | `Int8-32`, `UInt8-32`, `Float32/64`, `BFloat16` | `number` |
| Large integers | `Int64-256`, `UInt64-256` | `string` (default) or `bigint` |
| Boolean | `Bool`, `Boolean` | `boolean` |
| Wrappers | `Nullable(T)` | `T \| null` |
| Wrappers | `LowCardinality(T)` | same as `T` |
| Composite | `Array(T)` | `T[]` |
| Composite | `Map(K, V)` | `Record<K, V>` |
| Composite | `Tuple(T1, T2)` | `[T1, T2]` |
| JSON | `JSON` | `Record<string, unknown>` |
