---
title: Engine Rewriting
description: How one set of schema files with Shared engines works against both ObsessionDB and regular ClickHouse.
sidebar:
  order: 3
---

ObsessionDB uses `Shared` engine variants — `SharedMergeTree`, `SharedReplacingMergeTree`, `SharedAggregatingMergeTree` — to deliver managed replication without operator intervention. These engines do not exist in regular ClickHouse, so DDL that names them fails on a local Docker ClickHouse or self-hosted staging.

chkit therefore writes the standard engine name for every target: a table declared with `SharedReplacingMergeTree(ts)` is generated as `ENGINE = ReplacingMergeTree(ts)`, and the snapshot stores the same standard name. ObsessionDB transparently substitutes the `Shared` variant on the server, and [`chkit drift`](/cli/drift/) treats both spellings as the same engine. One set of schema files works against both.

The ObsessionDB plugin handles what the engine name cannot: the `storage_policy` table setting. It is a standard ClickHouse setting, but the storage policies ObsessionDB provides, such as `'s3'`, are not defined on a regular ClickHouse server, where `CREATE TABLE` fails with `Unknown storage policy`. When the target is not ObsessionDB, the plugin removes `storage_policy` from every table, whatever its value, before diff and planning, so it doesn't leak into local migrations.

The plugin applies this rewrite when [`chkit generate`](/cli/generate/) or [`chkit snapshot rebuild`](/cli/snapshot/) loads the schema, so a rebuilt `snapshot.json` matches the one `chkit generate` writes for the same target. The migration files record the result, and [`chkit migrate`](/cli/migrate/) applies them as written.

## Auto-detection

By default the plugin inspects `clickhouse.url`. If the host is `obsessiondb.com` or one of its subdomains, `storage_policy` is kept. Otherwise, it is stripped.

A config pointing at `https://my-service.obsessiondb.com` keeps it, while `http://localhost:8123` drops it — no flags needed.

## CLI flag overrides

In the TypeScript CLI, two flags override auto-detection for a single run of `generate` or `snapshot rebuild`:

- `--force-shared-engines` — keep `storage_policy` even when the URL is not recognized as ObsessionDB, for example an ObsessionDB service behind a custom domain, or a self-hosted server that defines the policy the schema names.
- `--no-shared-engines` — strip `storage_policy` even when targeting ObsessionDB.

If both are passed, `--force-shared-engines` wins.

```sh
# Strip storage_policy even when targeting ObsessionDB
chkit generate --no-shared-engines

# Keep it for an ObsessionDB service behind a custom domain
chkit generate --force-shared-engines
chkit snapshot rebuild --force-shared-engines
```

The migration files and `snapshot.json` keep what the flag decided, so pass the same flag every time `generate` or `snapshot rebuild` runs for that target. A later `generate` that decides differently plans a change for each affected table, for example `ALTER TABLE analytics.events RESET SETTING storage_policy` once the flag is dropped.

`migrate`, `status`, `drift` and `check` also accept both flags, so scripts can pass them to all six commands, but those four ignore them: they work from the migration files and snapshot that `generate` already wrote.

[chkit-py](/python/overview/#differences-from-the-typescript-version) does not have these flags: its commands reject them, and the plugin always decides from `clickhouse.url`.

## What gets rewritten

| Schema | Generated DDL (every target) |
|---|---|
| `engine: 'SharedMergeTree'` | `ENGINE = MergeTree()` |
| `engine: 'SharedReplacingMergeTree(ts)'` | `ENGINE = ReplacingMergeTree(ts)` |
| `engine: 'SharedAggregatingMergeTree'` | `ENGINE = AggregatingMergeTree()` |
| `engine: 'MergeTree'` | `ENGINE = MergeTree()` |

| Table setting | Regular ClickHouse | ObsessionDB |
|---|---|---|
| `storage_policy` (any value) | stripped | kept |
| Any other setting | kept | kept |

Only tables are affected. Views and materialized views pass through unchanged.

## Related

- [Services](/obsessiondb/services/) — the runtime counterpart: route a single command at a specific service with `--service`.
- [`chkit drift`](/cli/drift/) — normalizes `SharedMergeTree` to `MergeTree` when comparing engines, so managed-side engine substitutions don't show up as drift.
- [Schema Overview](/schema/overview/) — where engines are declared in the DSL.
