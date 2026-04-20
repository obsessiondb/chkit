---
"@chkit/core": patch
"@chkit/plugin-pull": patch
---

Add support for ClickHouse refreshable materialized views (RMVs), GA since ClickHouse 24.10.

Define a refreshable MV by adding a `refresh` field to `materializedView()`:

```ts
const dailyReport = materializedView({
  database: 'analytics',
  name: 'daily_report_mv',
  to: { database: 'analytics', name: 'daily_report' },
  refresh: { every: '1 DAY', offset: '2 HOUR' },
  as: 'SELECT toDate(ts) AS day, count() AS total FROM analytics.events GROUP BY day',
})
```

Supported fields: `every`, `after`, `offset`, `randomize`, `dependsOn`, `settings`, `append`, `empty`.

Highlights:
- `chkit generate` emits `ALTER TABLE ... MODIFY REFRESH` for schedule-only changes and `DROP ... SYNC` + `CREATE` for structural changes (added/removed refresh, toggled APPEND).
- `chkit pull` parses the REFRESH clause from `system.tables.create_table_query` and ignores the `DEFINER` / `SQL SECURITY` clauses that ClickHouse Cloud auto-injects.
- Validation catches: missing/both `every`/`after`, invalid interval formats, non-APPEND RMV pointing at a replicated (`SharedMergeTree` / `Replicated*`) target (ClickHouse rejects this), and `DEPENDS ON` paired with `REFRESH AFTER`.

See the [Refreshable materialized views docs](https://chkit.obsessiondb.com/schema/refreshable-views/) for the full reference.
