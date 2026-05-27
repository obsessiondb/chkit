---
title: Refreshable Materialized Views
description: Schedule ClickHouse materialized views to refresh on a cron-like cadence, with APPEND mode, DEPENDS ON chains, and the three hard rules chkit enforces.
sidebar:
  order: 2
---

ClickHouse [refreshable materialized views](https://clickhouse.com/docs/materialized-view/refreshable-materialized-view) (RMVs) periodically re-execute a SELECT on a schedule, rather than firing per-INSERT like regular incremental MVs. They've been production-ready since ClickHouse 24.10.

chkit models an RMV as a regular `materializedView()` with an extra `refresh` field:

```ts
import { materializedView } from '@chkit/core'

const dailyReport = materializedView({
  database: 'analytics',
  name: 'daily_report_mv',
  to: { database: 'analytics', name: 'daily_report' },
  refresh: {
    every: '1 DAY',
    offset: '2 HOUR',
  },
  as: 'SELECT toDate(ts) AS day, count() AS total FROM analytics.events GROUP BY day',
})
```

Without a `refresh` field, the definition is a plain incremental materialized view.

## The `refresh` field

| Field | Type | Description |
|-------|------|-------------|
| `every` | `string` | Calendar-aligned schedule (e.g., `'1 HOUR'`, `'30 SECOND'`, `'1 DAY'`). Mutually exclusive with `after`. |
| `after` | `string` | Relative schedule — `after` the previous refresh completed. Mutually exclusive with `every`. |
| `offset` | `string` | Shifts calendar-aligned time (e.g., `'2 HOUR'` with `every: '1 DAY'` refreshes at 02:00 UTC). |
| `randomize` | `string` | Adds jitter to avoid thundering herd. `'30 SECOND'` spreads refreshes over a 30-second window. |
| `dependsOn` | `Array<{ database, name }>` | Chain refreshes: run only after the listed MVs finish. Only valid with `every` — not `after`. |
| `settings` | `Record<string, string \| number>` | Refresh settings. Common keys: `refresh_retries`, `refresh_retry_initial_backoff_ms`, `refresh_retry_max_backoff_ms`. |
| `append` | `boolean` | When `true`, refreshes INSERT rather than REPLACE. See below. |
| `empty` | `boolean` | Suppress the initial refresh on creation. |

Intervals use the ClickHouse form: `<integer> <unit>` where `<unit>` is `SECOND`, `MINUTE`, `HOUR`, `DAY`, `WEEK`, `MONTH`, or `YEAR`. chkit canonicalizes `'1 hour'` → `'1 HOUR'` automatically.

## APPEND vs. default

| Mode | Behavior | Atomicity |
|------|----------|-----------|
| Default (`append: false`, omitted) | **Truncate and replace** — the target table is atomically swapped with the refresh result | Atomic — readers always see a complete, consistent snapshot |
| `append: true` | **INSERT** — rows accumulate on each refresh | Non-atomic, like a regular `INSERT SELECT` |

APPEND is useful for periodic snapshots where you want history, e.g.:

```ts
const hourlySnapshot = materializedView({
  database: 'analytics',
  name: 'hourly_snapshot_mv',
  to: { database: 'analytics', name: 'hourly_snapshots' },
  refresh: {
    every: '1 HOUR',
    append: true,
  },
  as: 'SELECT now() AS snapshot_ts, org_id, count() AS cnt FROM analytics.events GROUP BY org_id',
})
```

## Chaining refreshes with `DEPENDS ON`

Use `dependsOn` to ensure an RMV runs only after its upstream MVs have refreshed:

```ts
const hourlyBase = materializedView({
  database: 'analytics',
  name: 'hourly_base_mv',
  to: { database: 'analytics', name: 'hourly_base' },
  refresh: { every: '1 HOUR' },
  as: 'SELECT ...',
})

const hourlyAggregate = materializedView({
  database: 'analytics',
  name: 'hourly_aggregate_mv',
  to: { database: 'analytics', name: 'hourly_aggregate' },
  refresh: {
    every: '1 HOUR',
    dependsOn: [{ database: 'analytics', name: 'hourly_base_mv' }],
  },
  as: 'SELECT ... FROM analytics.hourly_base GROUP BY ...',
})
```

`DEPENDS ON` is only supported with `REFRESH EVERY` — ClickHouse rejects it when paired with `REFRESH AFTER`. chkit enforces this at `generate` / `check` time (`refresh_depends_on_requires_every`).

## Three hard rules chkit enforces

These come from the ClickHouse server's actual behavior, not the docs. Each rule has a validation code you'll see in `chkit check --json`.

### Rule 1 — `APPEND` is structural

`ALTER TABLE … MODIFY REFRESH` cannot add or remove `APPEND`. Server returns: *"Adding or removing APPEND is not supported."*

Any change to `refresh.append` between the old and new definition triggers **drop + recreate** (risk `caution`). Schedule-only changes stay as a single `MODIFY REFRESH`.

### Rule 2 — Re-include `APPEND` on refresh-only changes

Omitting `APPEND` in `MODIFY REFRESH` for an existing APPEND MV is interpreted as "remove APPEND" and rejected. chkit always re-emits `APPEND` in the generated `ALTER` when the MV has `append: true`, so you never need to think about it.

### Rule 3 — Non-APPEND RMV + replicated target is rejected

On any `SharedMergeTree` / `Replicated*` target (e.g. [ObsessionDB](https://obsessiondb.com)), a non-APPEND RMV is refused outright with: *"This combination doesn't work: refreshable materialized view, no APPEND, non-replicated database, replicated table. Each refresh would replace the replicated table locally, but other replicas wouldn't see it. Refusing to create."*

chkit validates this at `generate` / `check` time whenever the target table is defined in the same schema. Validation code: `refresh_append_required_for_replicated_target`. Fix: set `refresh.append = true`, or target a non-replicated table.

## Generated SQL

For the `dailyReport` example at the top, `chkit generate` produces:

```sql
CREATE MATERIALIZED VIEW IF NOT EXISTS analytics.daily_report_mv
REFRESH EVERY 1 DAY OFFSET 2 HOUR TO analytics.daily_report AS
SELECT toDate(ts) AS day, count() AS total FROM analytics.events GROUP BY day;
```

## Migration behavior

| Change | Migration emitted | Risk |
|--------|-------------------|------|
| Adding `refresh` to an existing non-refreshable MV | `DROP TABLE ... SYNC` + `CREATE MATERIALIZED VIEW` | `caution` |
| Removing `refresh` | `DROP TABLE ... SYNC` + `CREATE MATERIALIZED VIEW` | `caution` |
| Toggling `append` | `DROP TABLE ... SYNC` + `CREATE MATERIALIZED VIEW` (Rule 1) | `caution` |
| Changing `every` / `after` / `offset` / `randomize` / `dependsOn` / `settings` only | `ALTER TABLE ... MODIFY REFRESH ...` | `caution` |
| Changing `as`, `to`, or `comment` | `DROP TABLE ... SYNC` + `CREATE MATERIALIZED VIEW` | `caution` |
| No change | No operation | — |

## Monitoring

Check refresh status in `system.view_refreshes`:

```sql
SELECT database, view, status, last_success_time, last_refresh_time, next_refresh_time, read_rows, written_rows
FROM system.view_refreshes
WHERE database = 'analytics';
```

Manual control:

```sql
SYSTEM REFRESH VIEW analytics.daily_report_mv;   -- trigger immediate refresh
SYSTEM STOP VIEW   analytics.daily_report_mv;    -- pause scheduling
SYSTEM START VIEW  analytics.daily_report_mv;    -- resume scheduling
SYSTEM CANCEL VIEW analytics.daily_report_mv;    -- cancel in-flight refresh
```

## Version requirements

| ClickHouse version | Status |
|--------------------|--------|
| 23.12 – 24.9 | Experimental — required `allow_experimental_refreshable_materialized_view = 1` |
| 24.9 | APPEND mode added |
| 24.10 + | **Production-ready** — no flag required |

chkit targets 24.10 and above for refreshable MV support.
