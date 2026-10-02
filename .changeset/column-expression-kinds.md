---
"@chkit/core": patch
"@chkit/codegen": patch
"@chkit/clickhouse": patch
"chkit": patch
"@chkit/plugin-pull": patch
"@chkit/plugin-codegen": patch
"@chkit/plugin-backfill": patch
"@chkit/plugin-ingest": patch
"@chkit/plugin-obsessiondb": patch
---

Support `MATERIALIZED`, `ALIAS`, and `EPHEMERAL` columns with a new `defaultKind` column field. `default` holds the value or `fn:` expression for every kind, and `EPHEMERAL` may omit it. SQL rendering, `pull`, snapshots, and drift keep the kind; validation reports `column_expression_required` and `column_default_kind_invalid`.

- `DEFAULT`/`MATERIALIZED` expression changes emit `MODIFY COLUMN` with a warning that stored values are not rewritten, and removed expressions emit `REMOVE DEFAULT`/`REMOVE MATERIALIZED`. Conversions to or from `ALIAS`/`EPHEMERAL` fail `generate` with `column_kind_change_unsupported`.
- Codegen emits `Row` (`SELECT *`), `RowExplicit` (all readable columns), and `RowInsert` (all insertable columns) for these tables; ingest helpers take `RowInsert`.
- Inserts into tables with `EPHEMERAL` columns name their columns: generated ingest helpers pass `columns`, which `@chkit/clickhouse` `insert()` and the ObsessionDB remote executor send, and the `@chkit/plugin-ingest` destination does the same.
- Automatic backfills omit `MATERIALIZED` and `ALIAS` columns and check live column kinds first: a copy is blocked only when the target has both `EPHEMERAL` and `MATERIALIZED` columns, `mv_replay` by any `EPHEMERAL` column, and a missing target fails with "does not exist or is not visible yet".
- `drift` and `check` compare defaults token by token. Write expressions in the canonical form ClickHouse stores, such as `CAST(x, 'String')`, to avoid drift.
- Fix string defaults containing backslashes: `C:\temp` now renders as `DEFAULT 'C:\\temp'`.
