---
title: "chkit migrate"
description: "Apply pending migration files to ClickHouse."
sidebar:
  order: 4
---

Applies pending migration SQL files to your ClickHouse instance. Supports plan-only mode, interactive confirmation, destructive operation safety, checksum verification, and recovery from failed migrations.

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
| `--retry <migration>` | string | — | Resume a [failed migration](#failed-migrations) after editing its file; completed statements are skipped. Takes effect with `--apply` |
| `--abandon <migration>` | string | — | Reset a failed migration so the next apply runs it from statement 1. Previews without `--apply`; cannot be combined with `--retry`, `--table`, or `--allow-destructive` |
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

### Failed migrations

chkit records the progress of each statement in the journal while a migration runs. When a statement fails, the migration stays **in progress**: the statements before it remain applied in ClickHouse, and the migration is not recorded as applied. Re-running `chkit migrate --apply` resumes it: completed statements are skipped and the failed statement runs again. That fixes a failure whose cause is outside the file, such as a missing table, a permission, or a transient error.

When the file itself is wrong, edit it. What the next `chkit migrate --apply` does depends on how far the migration got:

- **No statement is recorded as completed** (the first statement failed, or the migration was [abandoned](#abandoning-a-failed-migration), in which case the statements that ran stay applied and run again): the edited file runs again from statement 1, and the command prints `<file> changed since its last failed attempt; no statement is recorded as completed, so it runs again from statement 1.`
- **Some statements completed, or one was interrupted while it ran**: they ran from the old file, so `migrate` does not continue on its own:

```
Migration 20260929001110_funnel-model.sql has in-progress journal state for checksum 7808…, but the current file checksum is 3397…: the file changed after some of its statements had run.
  Resume with the edited file (completed statements are skipped): chkit migrate --apply --retry 20260929001110_funnel-model.sql
  Or discard the partial run, so the next apply starts the file over: chkit migrate --apply --abandon 20260929001110_funnel-model.sql
  Or restore the original file content and re-run chkit migrate --apply.
```

:::caution
Edit a failed migration only if no other environment that runs the same files has applied it, because checksum verification fails there. If the migration succeeded elsewhere, fix the cause in the failing environment and re-run `chkit migrate --apply` with the unchanged file.
:::

### Retrying a failed migration

```sh
chkit migrate --apply --retry 20260929001110_funnel-model.sql
```

`--retry` accepts the edited file for the named migration when every statement that completed still sits at the same position with the same `-- operation:` marker (operation type and key). chkit then records the new checksum and continues from the first statement that did not complete, so a later failure resumes with a plain `chkit migrate --apply`. The name may be the file name with or without `.sql`, or a path to the file.

- Completed statements are skipped by position and never run again. Edits to them have no effect; correct an applied statement with a new migration.
- Statements without an `-- operation:` marker are matched by position only. Do not add, remove, or reorder statements above the one that failed.
- An [async statement](#async-operations-modeasync) that may still be running must also keep its position and marker.
- If a completed statement moved or its marker changed, `--retry` refuses and lists the statements. Restore them, or [abandon](#abandoning-a-failed-migration) the partial run.
- Statements can share a marker: a column's generated `REMOVE DEFAULT` or `REMOVE MATERIALIZED` carries the marker of the `MODIFY COLUMN` after it. Keep both in the file and edit only the one that failed. `--retry` cannot tell them apart, so it also refuses an edit that leaves fewer statements with a completed statement's marker than the failed run recorded, such as one that deletes the completed `REMOVE`.
- `--retry` changes nothing on its own: like `--allow-destructive`, it takes effect when `--apply` (or the interactive confirmation) applies migrations. Without `--apply`, the plan shows where the migration will resume.
- When the named migration has no in-progress state, did not change since it failed, is already applied, has no executable statements, or is outside the `--table` scope, `--retry` has no effect and the output says so, also when nothing is pending, so the same command can run against every environment. A name that matches no migration file is an error.

### Abandoning a failed migration

```sh
chkit migrate --abandon 20260929001110_funnel-model.sql          # preview
chkit migrate --abandon 20260929001110_funnel-model.sql --apply  # reset
```

Resets the journal state of a failed migration so the next `chkit migrate --apply` runs it from statement 1. Without `--apply` the command only reports what it would reset; an interactive terminal asks for confirmation. It runs no migration SQL and applies no migration. It reads neither the migration file nor `snapshot.json`, so it works after the file was deleted or while `snapshot.json` has merge conflicts. It cannot be combined with `--retry`, `--table`, or `--allow-destructive`.

The report lists the statements that completed. They **stay applied** in ClickHouse, and the next apply runs them again with the rest of the file:

- Each statement must be safe to run twice. Generated `CREATE` and `DROP` statements use `IF NOT EXISTS` / `IF EXISTS`, but a table recreate drops the table again, with any rows written since, a data load such as `INSERT ... SELECT` adds its rows again, and a column's `REMOVE DEFAULT` or `REMOVE MATERIALIZED` fails, because the column no longer has that expression. Remove such statements from the file. When the `MODIFY COLUMN` after a completed `REMOVE` failed, [`--retry`](#retrying-a-failed-migration) skips the `REMOVE` instead. The destructive-operation check asks again for destructive statements.
- An [async](#async-operations-modeasync) load (`mode=async`) can undo its earlier run with a `-- before-retry:` line instead. The line runs only when the statement keeps its position and its `-- operation:` type and key, so adding a marker to a load after the abandon does not help. A statement without `mode=async` ignores `-- before-retry:`.
- An async statement that was interrupted may still be running on the server. The report prints its `query_id`; wait for the query to finish or run `KILL QUERY WHERE query_id = '…'` before you apply the migration again.

To regenerate the migration instead, delete the file, restore `chkit/meta/snapshot.json` from git to its state before the migration was generated, and run `chkit generate`. The statements that completed stay applied. The new migration runs the ones it repeats again, so they must be safe to run twice, as above: delete a repeated `REMOVE DEFAULT` or `REMOVE MATERIALIZED` from it before you apply it. Run `chkit drift` after you apply the new migration: a completed statement that the new migration does not repeat, such as a `DROP VIEW`, leaves the database out of step with the schema.

`--abandon` fails when the journal has no in-progress state for the migration, or when the migration is already applied.

### Empty migrations

`chkit migrate --apply` refuses to apply a pending migration file without executable statements, such as a [`chkit generate --empty`](/cli/generate/#empty-mode) stub that still waits for its SQL, or a file that holds only comments. Recording such a file as applied would make any SQL added to it later fail checksum verification. The command applies nothing, lists the files, and exits with code 1; add SQL to each file or delete it. In an interactive terminal, `chkit migrate` without `--apply` prints the plan and then refuses the same way, before its confirmation prompt. A plan-only run (in CI, or with `--json` and no `--apply`) marks empty files and exits with code 0; `--json` reports them in an `emptyMigrations` array.

A statement made only of comments, such as a block comment after the last `;`, is not executable either. chkit skips it instead of sending it to ClickHouse, which would reject it as `Empty query`.

### Journal

Each migration has one row in the `_chkit_migrations` journal table in ClickHouse:

- `name` — the migration filename
- `applied_at` — time of the last change to the row
- `checksum` — SHA-256 hash of the file content
- `chkit_version` — the CLI version that wrote the row
- `migration_completed` — `true` once every statement has run
- `operations` — the progress of each statement (`completed`, `failed`, or `started`) while the migration runs

The journal is written as each statement runs, not batched. The table is created in the database configured in `clickhouse.database` (it is not qualified with a database name, so on a shared/default-database setup it lives in `default._chkit_migrations`). The table name can be overridden with the `CHKIT_JOURNAL_TABLE` environment variable.

The table is a `ReplacingMergeTree` keyed by `name`: every change inserts a newer version of the row, and chkit reads it with `FINAL`, which returns the newest version. A `SELECT` without `FINAL` can show several rows per migration until background merges collapse them. `--abandon` writes a new version too, so it needs no privilege beyond the `INSERT` that every journal write uses.

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
2. Checks `system.processes` for an attempt with that id that is still running, and attaches to it instead of submitting again.
3. Otherwise submits the query without blocking on the HTTP response.
4. Polls every 5 seconds and prints a one-line progress update (`written=N.NM rows (N.N GiB), elapsed Ns`). Only `system.query_log` entries of queries that started no earlier than this submission, or than the attempt chkit attached to, count. Both are measured on the server clock with a 2-second margin, so an earlier attempt with the same id is never mistaken for this one.
5. Records the journal entry on success, or throws the server's exception on failure.

When an earlier attempt of the statement failed, was interrupted, or was [abandoned](#abandoning-a-failed-migration), chkit runs the statement's `-- before-retry:` SQL before it submits the statement again. Put the line right after the `-- operation:` marker to undo a partial load:

```sql
-- operation: load_table_data key=table:default.hits risk=caution mode=async
-- before-retry: TRUNCATE TABLE default.hits
INSERT INTO default.hits SELECT * FROM s3(...);
```

Only async statements run `-- before-retry:`. On a statement without `mode=async`, chkit ignores the line.

In `--json` mode, progress lines go to stderr, so stdout holds only the JSON output.

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

**Resume a failed migration after editing it:**

```sh
chkit migrate --apply --retry 20260929001110_funnel-model.sql
```

**Discard the partial run of a failed migration:**

```sh
chkit migrate --abandon 20260929001110_funnel-model.sql --apply
```

## Exit codes

| Code | Meaning |
|------|---------|
| 0 | Success (or no pending migrations) |
| 1 | Error: checksum mismatch on applied migrations, a pending migration without executable statements, a failed statement, or a rejected `--retry` / `--abandon` request |
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

### Plan mode with `--retry` and an empty migration

```json
{
  "command": "migrate",
  "schemaVersion": 1,
  "mode": "plan",
  "scope": { "enabled": false },
  "pending": ["20260929001110_funnel-model.sql", "20260930090000_backfill.sql"],
  "emptyMigrations": ["20260930090000_backfill.sql"],
  "retry": {
    "action": "resume",
    "migration": "20260929001110_funnel-model.sql",
    "previousChecksum": "7808…",
    "checksum": "3397…",
    "totalStatements": 16,
    "completedStatements": 4,
    "resumeAtStatement": 5,
    "unmarkedCompletedStatements": 0
  }
}
```

When `--retry` has no effect, `retry` is `{ "action": "none", "migration": "…", "reason": "…" }`, with `reason` one of `already_applied`, `not_in_scope`, `empty_migration`, `not_in_progress`, or `checksum_unchanged`. The execute payload, and the payload of a run with nothing pending (`"pending": []`), carry the same `retry` object.

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

### Empty migrations blocked

```json
{
  "command": "migrate",
  "schemaVersion": 1,
  "mode": "execute",
  "scope": { "enabled": false },
  "error": "Pending migrations contain no executable statements. Add SQL statements to each file or delete it.",
  "emptyMigrations": ["20260930090000_backfill.sql"]
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

### Abandon

Without `--apply`, `mode` is `plan` and nothing changes; with `--apply`, it is `execute`. `operations` is the progress of each statement before the reset. `completedStatements` also counts statements that completed before an earlier `--abandon`: their `lastError` reads `abandoned via chkit migrate --abandon (was completed)`, and abandoning again keeps it.

```json
{
  "command": "migrate",
  "schemaVersion": 1,
  "mode": "execute",
  "scope": { "enabled": false },
  "abandon": {
    "migration": "20260929001110_funnel-model.sql",
    "checksum": "7808…",
    "completedStatements": 1,
    "operations": [
      { "operationIndex": 0, "operationKey": "table:analytics.events", "operationType": "alter_table_add_column", "queryId": "", "status": "completed", "startedAt": "2026-09-29 00:11:10.120", "finishedAt": "2026-09-29 00:11:10.180", "lastError": "" },
      { "operationIndex": 1, "operationKey": "view:analytics.funnel", "operationType": "create_view", "queryId": "", "status": "failed", "startedAt": "2026-09-29 00:11:10.240", "finishedAt": "2026-09-29 00:11:10.260", "lastError": "Unknown table expression identifier 'analytics.funnel_steps' …" }
    ]
  }
}
```

### Errors

A failure that stops the command prints the standard error envelope:

```json
{
  "command": "migrate",
  "schemaVersion": 1,
  "ok": false,
  "error": {
    "code": "in_progress_checksum_mismatch",
    "message": "Migration 20260929001110_funnel-model.sql has in-progress journal state for checksum 7808…"
  }
}
```

| Code | When |
|------|------|
| `in_progress_checksum_mismatch` | The file of an in-progress migration changed after some of its statements ran, and `--retry` was not given for it |
| `retry_mismatch` | `--retry`: a statement that completed, or an async statement that may still be running, no longer matches the edited file, or the edit left fewer statements with a marker that a completed statement shares |
| `migration_not_found` | `--retry` names a file that is not in the migrations directory |
| `migration_not_in_progress` | `--abandon`: the journal has no in-progress state for the migration |
| `migration_already_applied` | `--abandon`: the migration is already applied |
| `invalid_usage` | `--abandon` combined with `--retry`, `--table`, or `--allow-destructive`, or an empty migration name |

Other failures, such as a statement that ClickHouse rejects, use the code `error`.

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
