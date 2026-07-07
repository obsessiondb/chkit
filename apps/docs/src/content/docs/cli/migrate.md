---
title: "chkit migrate"
description: "Apply pending migration files to ClickHouse."
sidebar:
  order: 4
---

Applies pending migration SQL files to your ClickHouse instance. Supports plan-only mode, interactive confirmation, destructive operation safety, and checksum verification.

## Synopsis

```
chkit migrate [flags]
```

## Flags

| Flag | Type | Default | Description |
|------|------|---------|-------------|
| `--apply` | boolean | `false` | Apply pending migrations without prompting |
| `--execute` | boolean | `false` | Alias for `--apply` |
| `--allow-destructive` | boolean | `false` | Allow destructive operations (required in non-interactive mode) |
| `--table <selector>` | string | — | Scope migrations to those affecting matching tables |

Global flags documented on [CLI Overview](/cli/overview/#global-flags).

## Behavior

### Plan vs execute

By default, `chkit migrate` shows the list of pending migrations without applying them. Pass `--apply` (or `--execute`) to apply.

In interactive mode (TTY), the CLI prompts for confirmation before applying. In non-interactive mode (CI, piped input), `--apply` is required — otherwise the command only reports the plan.

### CI / non-interactive detection

The CLI detects non-interactive contexts when any of these conditions are true:

- `CI=1` or `CI=true` environment variable is set
- stdin is not a TTY
- stdout is not a TTY

### Destructive operation safety

Migration files containing `risk=danger` operations (such as `DROP TABLE` or `DROP COLUMN`) require explicit approval:

- **Interactive mode**: the CLI prompts for confirmation
- **Non-interactive / CI mode**: `--allow-destructive` must be passed, or `safety.allowDestructive` must be `true` in config. Otherwise the command exits with code 3.
- **JSON mode**: exits with code 3 and includes details about blocked operations

Destructive statements are detected two ways. Planner-emitted migrations carry a `-- operation:` marker per statement, which sets the risk classification directly. In addition, chkit scans the executable SQL itself for hand-written destructive statements (`DROP TABLE`, `DROP COLUMN`, `TRUNCATE`, `DROP VIEW` / `DROP MATERIALIZED VIEW`, `DETACH`, `DROP DATABASE`) that carry no marker — whether a whole migration was hand-written or a statement was appended to a generated one. Such statements previously applied silently in CI; they now require `--allow-destructive` (or `safety.allowDestructive`) like any other destructive operation. Commented-out statements are ignored (comments are stripped before scanning), and planner-marked non-danger statements keep their existing classification, so a generated materialized-view recreate is not blocked.

Each destructive operation includes a warning code, reason, impact description, and recommendation:

| Warning code | Operation |
|-------------|-----------|
| `drop_table_data_loss` | `DROP TABLE` |
| `table_recreate_data_loss` | `DROP TABLE` + `CREATE TABLE` recreate from a structural change (`engine` / `orderBy` / `primaryKey` / `partitionBy` / `uniqueKey`) — all rows lost, table recreated empty |
| `drop_column_irreversible` | `DROP COLUMN` |
| `drop_view_dependency_break` | `DROP VIEW` / `DROP MATERIALIZED VIEW` |
| `destructive_operation_review_required` | Other destructive operations |

### Checksum verification

Before applying, the CLI verifies SHA-256 checksums of all previously-applied migrations against the files on disk. If any file has been modified since it was applied, the command aborts with exit code 1.

### Journal

Each applied migration is recorded in the `_chkit_migrations` journal table in ClickHouse with:

- `name` — the migration filename
- `appliedAt` — ISO 8601 timestamp
- `checksum` — SHA-256 hash of the file content
- `chkit_version` — the CLI version that applied the migration

The journal is written after each migration, not batched. The table is created in the database configured in `clickhouse.database` (it is not qualified with a database name, so on a shared/default-database setup it lives in `default._chkit_migrations`). The table name can be overridden with the `CHKIT_JOURNAL_TABLE` environment variable.

### Table scoping

The `--table` flag filters pending migrations to those containing operations targeting the matched tables. Migration SQL files are parsed for `-- operation:` comment markers to determine which tables they affect.

A hand-written migration with no `-- operation:` markers has no determinable target tables. Rather than silently skip it (which would leave pending work unapplied while appearing successful), `--table` **includes** such migrations and prints a warning listing them. In `--json` mode they are reported in an `undeterminedMigrations` array. If you do not want a hand-written migration applied under a scoped run, add an `-- operation: <type> key=table:<db>.<table> risk=<risk>` marker so its scope can be determined.

### Plugin hooks

The `onBeforeApply` plugin hook runs before each migration is executed and can transform the SQL statements. The `onAfterApply` hook runs after successful execution.

### Async operations (`mode=async`)

Long-running data operations — large `INSERT ... SELECT` loads, backfills — can be marked async so chkit submits the query without blocking on its HTTP response and polls server-side for progress. Add `mode=async` to the statement's `-- operation:` marker:

```sql
-- operation: load_table_data key=table:default.hits risk=caution mode=async
INSERT INTO default.hits SELECT * FROM s3(...);
```

When `chkit migrate --apply` encounters an async operation it:

1. Computes a deterministic `query_id` from `sha256(migration_filename + ':' + statement_index)`.
2. Checks `system.processes` / `system.query_log` for any prior attempt with that id.
3. Submits the query without blocking on the HTTP response, polling every 5 seconds and printing a one-line progress update (`written=N.NM rows (N.N GiB), elapsed Ns`).
4. Records the journal entry on success, or throws the server's exception on failure.

This unblocks two scenarios the synchronous path cannot handle:

- **Long loads through a proxy or load balancer with an HTTP request-duration ceiling** — the deterministic id lets a re-run attach to the still-running query on the server instead of cancelling and restarting it.
- **Transient client-side errors during a multi-minute load** — re-running `chkit migrate` resumes the in-flight query rather than starting over.

The annotation is opt-in and forward-compatible: statements without `mode=async` use the synchronous path, and an unknown mode value falls back to sync. Pair it with the [`-- log:` metadata header](#per-migration-metadata) to print context before the load begins.

## Examples

**Preview pending migrations:**

```sh
chkit migrate
```

**Apply in CI:**

```sh
chkit migrate --apply --json
```

**Apply with destructive operations allowed:**

```sh
chkit migrate --apply --allow-destructive
```

**Scope to a specific table:**

```sh
chkit migrate --apply --table analytics.events
```

## Exit codes

| Code | Meaning |
|------|---------|
| 0 | Success (or no pending migrations) |
| 1 | Checksum mismatch on applied migrations |
| 3 | Destructive operations blocked |

## JSON output

### Plan mode

```json
{
  "command": "migrate",
  "schemaVersion": 1,
  "mode": "plan",
  "scope": { "enabled": false },
  "pending": ["20260604104251_add_column.sql", "20260604105133_create_index.sql"]
}
```

### Successful execution

```json
{
  "command": "migrate",
  "schemaVersion": 1,
  "mode": "execute",
  "scope": { "enabled": false },
  "applied": [
    { "name": "20260604104251_add_column.sql", "appliedAt": "2025-06-15T10:30:00.000Z", "checksum": "a1b2c3..." }
  ]
}
```

### Checksum mismatch error

```json
{
  "command": "migrate",
  "schemaVersion": 1,
  "mode": "execute",
  "scope": { "enabled": false },
  "error": "Checksum mismatch detected on applied migrations",
  "checksumMismatches": [
    { "name": "20260604090000_init.sql", "expected": "abc123...", "actual": "def456..." }
  ]
}
```

### Destructive operations blocked

```json
{
  "command": "migrate",
  "schemaVersion": 1,
  "mode": "execute",
  "scope": { "enabled": false },
  "error": "Blocked destructive migration execution. Re-run with --allow-destructive or set safety.allowDestructive=true after review.",
  "destructiveMigrations": ["20260605112000_drop_old_table.sql"],
  "destructiveOperations": [
    {
      "migration": "20260605112000_drop_old_table.sql",
      "type": "drop_table",
      "key": "default.old_table",
      "risk": "danger",
      "warningCode": "drop_table_data_loss",
      "reason": "...",
      "impact": "...",
      "recommendation": "...",
      "summary": "..."
    }
  ]
}
```

## Per-migration metadata

Migration files can declare optional metadata in the leading comment header. `chkit migrate` reads these keys and uses them to inform the user before the migration runs.

| Key | Effect |
|-----|--------|
| `log` | Printed to stdout immediately before the migration is applied. Use it to flag long-running or risky operations. |

Example header:

```sql
-- chkit-migration-format: v1
-- log: Loading the full ClickBench dataset (~100M rows). Expected duration: 3-5 minutes.
-- generated-at: ...
-- ...

INSERT INTO default.hits SELECT * FROM s3(...);
```

When the migration is listed (plan mode and as part of `--apply`):

```
Pending migrations: 1
- 20260525133130_load_clickbench_data.sql
    Loading the full ClickBench dataset (~100M rows). Expected duration: 3-5 minutes.
```

In `--apply` mode the log line is also re-printed immediately before each migration is executed, so the message stays close to the related work in CI logs:

```
  Loading the full ClickBench dataset (~100M rows). Expected duration: 3-5 minutes.
Applied: 20260525133130_load_clickbench_data.sql
```

Metadata keys are parsed from contiguous `-- key: value` comments at the top of the file (blank lines are tolerated) and stop at the first non-comment line. Unknown keys are ignored, so adding new keys in future releases is backwards-compatible.

## Related commands

- [The migration workflow](/guides/migration-workflow/) — the full generate → commit → migrate loop, and hand-written migrations
- [`chkit generate`](/cli/generate/) — produce migration files from schema changes
- [`chkit status`](/cli/status/) — check migration state without applying
- [`chkit check`](/cli/check/) — CI gate that evaluates pending migrations and checksums
