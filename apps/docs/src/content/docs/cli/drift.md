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

When comparing engines, `SharedMergeTree` is normalized to `MergeTree`. This prevents false positives on ClickHouse Cloud, where the server transparently substitutes `SharedMergeTree` for `MergeTree`.

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
| `changed_column` | Column exists but type or default differs |
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
