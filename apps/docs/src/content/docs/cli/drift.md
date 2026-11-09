---
title: "chkit drift"
description: "Compare the snapshot against live ClickHouse and report schema differences."
sidebar:
  order: 6
---

Compares your local snapshot against the live ClickHouse schema and reports any differences. Requires both a snapshot file and a `clickhouse` configuration block.

## Synopsis

```
chkit drift [flags]
```

## Flags

| Flag | Type | Default | Description |
|------|------|---------|-------------|
| `-t`, `--table <selector>` | string | — | Scope drift detection to matching tables |

Global flags documented on [CLI Overview](/cli/overview/#global-flags).

## Behavior

1. Reads `snapshot.json` from `metaDir`. If no snapshot exists, the command fails with an error: _"Snapshot not found. Run 'chkit generate' before drift checks."_
2. Requires `clickhouse` config. If missing, fails with: _"clickhouse config is required for drift checks."_
3. Connects to ClickHouse. If the server's MergeTree `index_granularity` default is not [`clickhouse.indexGranularity`](/configuration/overview/#mergetree-index-granularity-clickhouseindexgranularity) (8192 by default), fails with a message that names the value to set.
4. Introspects the live schema
5. Compares expected (snapshot) vs actual (live) objects, table shapes, view and materialized view queries, and dictionary definitions
6. Reports drift at both the object level and the table level

### What drift compares

- **Objects:** every table, view, materialized view and dictionary in the snapshot exists in ClickHouse with the same kind. An object in the schema's databases that the snapshot does not list reports `extra_object`.
- **Tables:** columns matched by name, with their type, default, default kind, comment and codec; the engine, `ORDER BY`, `PRIMARY KEY`, `PARTITION BY`, unique key and `TTL`; skip indexes, projections and constraints; and the settings the schema declares.
- **Views and materialized views:** the query, and a materialized view's `TO` target; see [View and materialized view queries](#view-and-materialized-view-queries).
- **Dictionaries:** the attributes, primary key, `RANGE`, `SOURCE`, `LAYOUT`, `LIFETIME` and settings; see [Dictionary definitions](#dictionary-definitions).
- **Comments:** the comment of every table, view, materialized view and dictionary, compared with `system.tables.comment`. A changed comment reports `comment_mismatch` with the schema's comment in `expected` and the live one in `actual`. A changed column comment reports `changed_column`.

### What drift does not compare

A server-side change to any of these reports no drift, so neither `chkit drift` nor `chkit check --strict` fails on it:

- A view or materialized view query in which ClickHouse hid a secret as `'[HIDDEN]'`, or that the server can't format.
- The `REFRESH` clause of a refreshable materialized view.
- Column order: columns are matched by name.
- The secrets in a dictionary's `SOURCE` (see [Dictionary definitions](#dictionary-definitions)): `drift` hides them on both sides, so a change to them alone reports no drift.
- The `SOURCE` of a dictionary in which ClickHouse hid another value or that holds a function call, and a dictionary's other clauses when the server can't format the dictionary.
- Table settings the schema does not declare.

Check these properties against `SHOW CREATE` output.

### Engine normalization

When comparing engines, `SharedMergeTree` is normalized to `MergeTree`. This prevents false positives on managed environments (e.g. [ObsessionDB](https://obsessiondb.com)) where the server transparently substitutes `SharedMergeTree` for `MergeTree`.

### Nullable columns

Column types are compared as rendered SQL types, in the spacing ClickHouse stores: `Decimal(10,2)` matches the stored `Decimal(10, 2)`, while text in quotes (an `Enum` label, a time zone) is compared as written. `type: 'Nullable(String)'` and `type: 'String', nullable: true` both render `Nullable(String)` and do not report drift. Changes to nullability or the underlying type still report `changed_column`.

### Expression normalization

ClickHouse rewrites SQL expressions when it stores them — it spaces argument separators and operators, adds precedence parentheses, and rewrites `INTERVAL 5 YEAR` to `toIntervalYear(5)`. So a skip index, `PARTITION BY`, `ORDER BY`, or `TTL` expression written as `cityHash64(a,b)` is stored as `cityHash64(a, b)`. To avoid reporting these as drift, `drift` normalizes expressions through ClickHouse's own formatter before comparing, so equivalent expressions match regardless of spelling. When the connected server can't format an expression, comparison falls back to plain text matching.

### View and materialized view queries

The query of each view and materialized view in the snapshot is compared with the query ClickHouse stores for it (`as_select` in `system.tables`), and a materialized view's `TO` target with the live one. ClickHouse stores a view's query reformatted, so both queries go through ClickHouse's own formatter first and a reformatted but equivalent query matches. ClickHouse also qualifies every unqualified table name with the database of the connection that created the view, so `FROM events` is stored as `FROM analytics.events`, and likewise the dictionary name in `dictGet('users', …)`, `dictHas` and the other `dict*` functions, stored as `dictGet('analytics.users', …)`; `drift` drops that qualifier for the database of its own connection, as the two spellings name the same object. When the server can't format a query, `drift` does not compare it rather than report drift on a query that may be the same. Nor does it compare a query in which ClickHouse replaced a secret, such as a table function's password, with `'[HIDDEN]'`: that query never matches the schema, and formatting the schema's query would print the secret in the drift output and log it in `system.query_log`.

A changed query reports `query_mismatch` and a changed target `target_mismatch`, with the compared values in `expected` and `actual`. A materialized view recreated on the server with an inner table instead of its `TO` target reports `target_mismatch` with an empty `actual`.

### Keys and partition

`ORDER BY`, `PRIMARY KEY`, the unique key and `PARTITION BY` are compared token by token with the clauses ClickHouse stores, ignoring whitespace, comments, one pair of parentheses around the whole clause, and how a name is quoted (`` `a\x41` `` and `aA` are the same column; a bare `NULL` is the literal, not a column named `null`). A quoted name keeps its commas and spaces: a key on a column named `a, b` is not the key on columns `a` and `b`, and a column named `a b` is not `ab`.

### Dictionary definitions

Each dictionary in the snapshot is compared with the statement ClickHouse stores for it (`create_table_query` in `system.tables`). The attributes, primary key, `RANGE`, `LAYOUT`, `LIFETIME` and settings go through ClickHouse's own formatter first, so `Decimal(10,2)` matches the stored `Decimal(10, 2)`, `LIFETIME(300)` matches `LIFETIME(MIN 0 MAX 300)`, and `hashed(shards 4)` matches `HASHED(SHARDS 4)`. Settings are compared without regard to their order. When the server can't format the dictionary, these clauses are not compared.

The `SOURCE` is compared without the formatter, which would log the schema's credentials in `system.query_log`. Keys and the source name are compared without regard to case, keys without regard to order, and strings by value. `drift` hides the secrets on both sides, so `expected` never shows a schema secret, and a change to a secret alone reports no drift: the values of `password`, `headers`, `connection_string` (ODBC), `datasource` (JDBC), `oauth_token`, and the MySQL and PostgreSQL SSL keys and passphrase; the user info in any URL; and the values of the URL query parameters that ClickHouse treats as secret (a name that contains `secret`, `password`, `passwd`, `token`, `credential`, `signature` or `key`, or is `sig`). ClickHouse 26.3 itself stores some of these in clear, such as an ODBC `connection_string` or an HTTP `URL 'http://host/?password=…'`. A source in which ClickHouse hid any other value is not compared, nor is a source with a function call such as `db currentDatabase()`, which ClickHouse stores evaluated.

A changed clause reports `structure_mismatch` (attributes, primary key and `RANGE`), `source_mismatch`, `layout_mismatch`, `lifetime_mismatch` or `dictionary_setting_mismatch`. `expected` holds the schema's clause and `actual` the live one: the source as ClickHouse stores it with credentials hidden, and the other clauses as the formatter prints them.

### SQL comments

ClickHouse does not store SQL comments. chkit removes them from TTL, partition, skip index, and projection expressions, and from expression column defaults, before comparing them with the live table, so a comment that whitespace separates from the rest of the clause, such as one at the end of a line, does not read as drift. Comment markers inside a literal column default (`default: 'a -- b'`) are part of the value. See [SQL fragments](/schema/dsl-reference/#sql-fragments).

### Expression defaults

Column defaults are compared token by token with `default_expression` in `system.columns`. chkit removes the comments from an expression default (`{ expression }` or `fn:`), then ignores whitespace, outer parentheses, and quotes around plain identifiers, so `now()+1` matches the stored `now() + 1`. A literal default is compared as a value, as `generate` compares it: `default: 'web'` matches the stored `'web'`, `default: 1e21` the stored `1e21`, and a large integer compares exactly. ClickHouse stores some expressions in a canonical form, and an expression written another way reports `changed_column` although the default is the same: `NOW()` is stored as `now()`, `x::String` as `CAST(x, 'String')`, and `now() + INTERVAL 1 DAY` as `now() + toIntervalDay(1)`. Write expression defaults in the stored form; see [`default`](/schema/dsl-reference/#default-string--number--boolean--sqlexpression-optional).

### Column codecs

Column codecs are compared with `compression_codec` in `system.columns`. ClickHouse fills in some codec arguments and drops others when it stores a codec: `ZSTD` is stored as `ZSTD(1)`, `LZ4HC` as `LZ4HC(0)` (the default level, 9), `DoubleDelta(4)` as `DoubleDelta` outside verbatim chains, `FPC(12, 8)` as `FPC(12)` and `T64('byte')` as `T64`, and a bare `Delta` or `Gorilla` gets the byte width of the column's values (`Delta(8)` on `UInt64`; still bare on a `Tuple` of mixed widths). chkit compares both sides in this stored form, the same way `generate` compares codecs, so these spellings do not report drift. A codec added, removed, or changed on the server reports `changed_column`, including a changed `ZSTD` window (`ZSTD(3, 24)` to `ZSTD(3)`) or `Delta` width. The atoms of a [`raw` codec](/schema/dsl-reference/#codec-columncodecspec-optional) that name a typed codec are compared like it (`codec.raw('Delta, Default')` matches `Delta(8), Default` on a `UInt64` column); other atoms are compared as written, without whitespace.

### Drift reason codes

**Object-level drift:**

| Code | Meaning |
|------|---------|
| `missing_object` | Expected object not found in ClickHouse |
| `extra_object` | Object in ClickHouse not in snapshot |
| `kind_mismatch` | Object exists but is a different kind (e.g. table vs view) |
| `query_mismatch` | A view or materialized view query differs from the snapshot |
| `target_mismatch` | A materialized view writes to a different `TO` table than the snapshot |
| `comment_mismatch` | A table, view, materialized view or dictionary comment differs from the snapshot |
| `structure_mismatch` | A dictionary's attributes, primary key or `RANGE` differ from the snapshot |
| `source_mismatch` | A dictionary's `SOURCE` differs from the snapshot |
| `layout_mismatch` | A dictionary's `LAYOUT` differs from the snapshot |
| `lifetime_mismatch` | A dictionary's `LIFETIME` differs from the snapshot |
| `dictionary_setting_mismatch` | A dictionary's `SETTINGS` differ from the snapshot |

**Table-level drift:**

| Code | Meaning |
|------|---------|
| `missing_column` | Column in snapshot not found in live table |
| `extra_column` | Column in live table not in snapshot |
| `changed_column` | Column exists but type, default, column kind, comment, or codec differs |
| `setting_mismatch` | Table setting value differs |
| `index_mismatch` | Index definition differs |
| `ttl_mismatch` | TTL expression differs |
| `engine_mismatch` | Table engine differs (after normalization) |
| `primary_key_mismatch` | Primary key expression differs |
| `order_by_mismatch` | ORDER BY expression differs |
| `partition_by_mismatch` | PARTITION BY expression differs |
| `unique_key_mismatch` | Unique key expression differs |
| `projection_mismatch` | Projection definition differs |
| `constraint_mismatch` | A `CHECK` or `ASSUME` constraint is missing, extra, or differs in kind or expression |

## Examples

**Check for drift:**

```sh
chkit drift
```

**Check drift for a specific table:**

```sh
chkit drift --table analytics.events
```

**JSON output for CI:**

```sh
chkit drift --json
```

## Exit codes

| Code | Meaning |
|------|---------|
| 0 | Always succeeds (drift is reported, not enforced) |

Use [`chkit check`](/cli/check/) with `failOnDrift` to enforce drift-free state in CI.

## JSON output

```json
{
  "command": "drift",
  "schemaVersion": 1,
  "scope": { "enabled": false },
  "snapshotFile": "./chkit/meta/snapshot.json",
  "expectedCount": 5,
  "actualCount": 6,
  "drifted": true,
  "missing": ["table:analytics.sessions"],
  "extra": ["table:analytics.temp_import"],
  "kindMismatches": [],
  "objectDrift": [
    { "code": "missing_object", "object": "analytics.sessions", "expectedKind": "table", "actualKind": null },
    {
      "code": "query_mismatch",
      "object": "analytics.orders_mv",
      "expected": "SELECT day, amount FROM orders WHERE status != 'Refunded'",
      "actual": "SELECT day, amount FROM orders WHERE (status != 'Refunded') AND (amount > 0)"
    }
  ],
  "tableDrift": [
    {
      "table": "analytics.events",
      "reasonCodes": ["extra_column", "setting_mismatch"],
      "missingColumns": [],
      "extraColumns": ["debug_flag"],
      "changedColumns": [],
      "settingDiffs": [{ "name": "index_granularity", "expected": "8192", "actual": "4096" }],
      "indexDiffs": [],
      "ttlMismatch": false,
      "engineMismatch": false,
      "primaryKeyMismatch": false,
      "orderByMismatch": false,
      "uniqueKeyMismatch": false,
      "partitionByMismatch": false,
      "projectionDiffs": [],
      "constraintDiffs": []
    }
  ]
}
```

## Related commands

- [`chkit generate`](/cli/generate/) — create a snapshot (required before drift checks)
- [`chkit check`](/cli/check/) — enforce drift-free state as a CI gate
