---
title: "chkit status"
description: "Show migration status including total, applied, pending, and checksum mismatches."
sidebar:
  order: 5
---

Reports the current migration state by comparing migration files on disk against the migration journal stored in ClickHouse. Requires a ClickHouse connection.

## Synopsis

```
chkit status [flags]
```

## Flags

No command-specific flags. See [global flags](/cli/overview/#global-flags).

## Behavior

`chkit status` reads the migrations directory and the `_chkit_migrations` journal table in ClickHouse to compute:

- **Total** migration files (`.sql` files in `migrationsDir`, sorted alphabetically)
- **Applied** migrations (entries recorded in the journal table)
- **Pending** migrations (on disk but not yet applied)
- **In progress** migrations (pending migrations that failed part-way)
- **Checksum mismatches** (applied migrations whose SHA-256 checksum no longer matches the file on disk)

A migration that failed part-way counts as pending until a later run applies it. `chkit status` also lists it under **In progress**, with the number of completed statements, the state of every other recorded statement, and the command that continues it. See [failed migrations](/cli/migrate/#failed-migrations).

`chkit status` requires a ClickHouse connection and fails if no `clickhouse` connection is configured. It only reads: when the `_chkit_migrations` journal table does not exist, every migration is pending, and the table is not created (the first `chkit migrate --apply` creates it). A read-only user (`readonly = 1` or `readonly = 2`, with `SELECT` on the journal) can run it, as well as `chkit check`, `chkit drift`, `chkit migrate` without `--apply` and `chkit query`. The one exception is a journal created by a chkit version without per-operation tracking: the first command that reads it adds the missing columns with `ALTER TABLE ... ADD COLUMN IF NOT EXISTS`, which needs a user that can alter the table.

## Examples

```sh
chkit status
```

```
Migrations: 5 total, 3 applied, 2 pending
Checksum mismatches: 0
```

With a migration that failed part-way:

```
In progress (failed part-way, still pending):
- 20260929001110_funnel-model.sql: 1 statement completed
  Statement 2 failed: Unknown table expression identifier 'analytics.sessions' in scope SELECT session_id FROM analytics.sessions.
  Next: chkit migrate --apply
```

```sh
chkit status --json
```

## Exit codes

| Code | Meaning |
|------|---------|
| 0 | Success |
| 1 | Error (e.g. no ClickHouse connection configured) |

## JSON output

```json
{
  "command": "status",
  "schemaVersion": 1,
  "migrationsDir": "/absolute/path/to/migrations",
  "total": 5,
  "applied": 3,
  "pending": 2,
  "pendingMigrations": ["20260604104251_add_column.sql", "20260604105133_create_index.sql"],
  "inProgressMigrations": [],
  "checksumMismatchCount": 0,
  "checksumMismatches": []
}
```

Each `inProgressMigrations` entry has the migration `name`, `fileChanged` (the file changed since its last failed attempt), `completedStatements`, `statements` and `nextSteps` (the commands that continue it, in order). `statements` lists every recorded statement that is not completed, with its 1-based `statement` number, operation `type` and `key`, and a `state`:

| `state` | Meaning |
|---------|---------|
| `failed` | The statement failed; `error` holds the error. |
| `interrupted` | chkit stopped while the statement ran, so it may have run. |
| `running` | An async statement whose query may still run on the server; `queryId` names it. |
| `awaiting_replicas` | The statement ran, but its change has not reached every replica; the next apply waits for it again. |
| `abandoned` | [`--abandon`](/cli/migrate/#abandoning-a-failed-migration) reset it; `was` is its status before. |

When checksum mismatches are detected, each entry includes the migration `name`, `expected` checksum (from the journal), and `actual` checksum (from the file on disk).

## Related commands

- [`chkit migrate`](/cli/migrate/) — apply pending migrations
- [`chkit check`](/cli/check/) — CI gate that evaluates pending migrations and checksums
