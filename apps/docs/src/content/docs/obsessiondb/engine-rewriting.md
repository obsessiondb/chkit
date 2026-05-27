---
title: Engine Rewriting
description: How chkit strips Shared engine prefixes when the target isn't ObsessionDB so one set of schema files works against both.
sidebar:
  order: 3
---

ObsessionDB uses `Shared` engine variants — `SharedMergeTree`, `SharedReplacingMergeTree`, `SharedAggregatingMergeTree` — to deliver managed replication without operator intervention. These engines do not exist in regular ClickHouse. Writing your schema with `Shared*` engines and then running it against a local Docker ClickHouse or self-hosted staging would fail at apply time.

The plugin intercepts schema definitions before diff and planning, strips the `Shared` prefix when the target is not ObsessionDB, and leaves it intact when the target is ObsessionDB. One set of schema files works against both.

## Auto-detection

By default the plugin inspects `clickhouse.url`. If the host ends with `.obsessiondb.com`, `Shared` engines are preserved. Otherwise, the `Shared` prefix is stripped.

This means a config pointing at `https://my-service.obsessiondb.com` keeps the managed engines, while `http://localhost:8123` automatically downgrades to the standard equivalents — no flags needed.

## CLI flag overrides

Two flags override auto-detection for a single command:

- `--force-shared-engines` — keep `Shared` engine prefixes even against regular ClickHouse.
- `--no-shared-engines` — strip the prefix even against ObsessionDB.

```sh
# Force stripping even when targeting ObsessionDB
chkit generate --no-shared-engines

# Force keeping Shared engines even on regular ClickHouse
chkit migrate --force-shared-engines
```

## Rewrite table

| Schema engine | Regular ClickHouse | ObsessionDB |
|---|---|---|
| `SharedMergeTree` | `MergeTree` | `SharedMergeTree` |
| `SharedReplacingMergeTree(ts)` | `ReplacingMergeTree(ts)` | `SharedReplacingMergeTree(ts)` |
| `SharedAggregatingMergeTree` | `AggregatingMergeTree` | `SharedAggregatingMergeTree` |
| `MergeTree` | `MergeTree` | `MergeTree` |

Only table engine definitions are rewritten. Views and materialized views pass through unchanged.

The plugin also strips ObsessionDB-only table settings (such as `storage_policy`) when the target is regular ClickHouse, so settings that only make sense in the managed environment don't leak into local migrations.

## Related

- [Services](/obsessiondb/services/) — the runtime counterpart: route a single command at a specific service with `--service`.
- [`chkit drift`](/cli/drift/) — normalizes `SharedMergeTree` to `MergeTree` when comparing engines, so managed-side engine substitutions don't show up as drift.
- [Schema Overview](/schema/overview/) — where engines are declared in the DSL.
