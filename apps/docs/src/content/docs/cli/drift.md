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
| `--table <selector>` | string | — | Scope drift detection to matching tables |

Global flags documented on [CLI Overview](/cli/overview/#global-flags).

## Behavior

1. Reads `snapshot.json` from `metaDir`. If no snapshot exists, the command fails with an error: _"Snapshot not found. Run 'chkit generate' before drift checks."_
2. Requires `clickhouse` config. If missing, fails with: _"clickhouse config is required for drift checks."_
3. Connects to ClickHouse and introspects the live schema
4. Compares expected (snapshot) vs actual (live) objects and table shapes
5. Reports drift at both the object level and the table level

### Engine normalization

When comparing engines, `SharedMergeTree` is normalized to `MergeTree`. This prevents false positives on managed environments (e.g. [ObsessionDB](https://obsessiondb.com)) where the server transparently substitutes `SharedMergeTree` for `MergeTree`.

### Expression normalization

ClickHouse rewrites SQL expressions when it stores them — it spaces argument separators and operators, adds precedence parentheses, and rewrites `INTERVAL 5 YEAR` to `toIntervalYear(5)`. So a skip index, `PARTITION BY`, `ORDER BY`, or `TTL` expression written as `cityHash64(a,b)` is stored as `cityHash64(a, b)`. To avoid reporting these as drift, `drift` normalizes expressions through ClickHouse's own formatter before comparing, so equivalent expressions match regardless of spelling. When the connected server can't format an expression, comparison falls back to plain text matching.

### SQL comments

ClickHouse does not store SQL comments. chkit removes them from TTL, partition, skip index, and projection expressions, and from expression column defaults, before comparing them with the live table, so a comment that whitespace separates from the rest of the clause, such as one at the end of a line, does not read as drift. Comment markers inside a literal column default (`default: 'a -- b'`) are part of the value. See [SQL fragments](/schema/dsl-reference/#sql-fragments).

### Expression defaults

Column defaults are compared token by token with `default_expression` in `system.columns`. chkit removes the comments from an expression default (`{ expression }` or `fn:`), then ignores whitespace, outer parentheses, and quotes around plain identifiers, so `now()+1` matches the stored `now() + 1`. A literal default is compared as a value: `default: 'web'` matches the stored `'web'`. ClickHouse stores some expressions in a canonical form, and an expression written another way reports `changed_column` although the default is the same: `NOW()` is stored as `now()`, `x::String` as `CAST(x, 'String')`, and `now() + INTERVAL 1 DAY` as `now() + toIntervalDay(1)`. Write expression defaults in the stored form; see [`default`](/schema/dsl-reference/#default-string--number--boolean--sqlexpression-optional).

### Drift reason codes

**Object-level drift:**

| Code | Meaning |
|------|---------|
| `missing_object` | Expected object not found in ClickHouse |
| `extra_object` | Object in ClickHouse not in snapshot |
| `kind_mismatch` | Object exists but is a different kind (e.g. table vs view) |

**Table-level drift:**

| Code | Meaning |
|------|---------|
| `missing_column` | Column in snapshot not found in live table |
| `extra_column` | Column in live table not in snapshot |
| `changed_column` | Column exists but type, default, or column kind differs |
| `setting_mismatch` | Table setting value differs |
| `index_mismatch` | Index definition differs |
| `ttl_mismatch` | TTL expression differs |
| `engine_mismatch` | Table engine differs (after normalization) |
| `primary_key_mismatch` | Primary key expression differs |
| `order_by_mismatch` | ORDER BY expression differs |
| `partition_by_mismatch` | PARTITION BY expression differs |
| `unique_key_mismatch` | Unique key expression differs |
| `projection_mismatch` | Projection definition differs |

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
    { "code": "missing_object", "object": "analytics.sessions", "expectedKind": "table", "actualKind": null }
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
      "projectionDiffs": []
    }
  ]
}
```

## Related commands

- [`chkit generate`](/cli/generate/) — create a snapshot (required before drift checks)
- [`chkit check`](/cli/check/) — enforce drift-free state as a CI gate
