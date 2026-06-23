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
- **Checksum mismatches** (applied migrations whose SHA-256 checksum no longer matches the file on disk)

`chkit status` requires a ClickHouse connection and fails if no `clickhouse` connection is configured. It does not change your schema or migration history, but it is **not a pure read**: before reading the journal it ensures the `_chkit_migrations` table exists and has the current columns, issuing idempotent `CREATE TABLE IF NOT EXISTS` and `ALTER TABLE ... ADD COLUMN IF NOT EXISTS` statements. The connecting user therefore needs privileges to create and alter the journal table, not just `SELECT` — provision credentials accordingly rather than a read-only user.

## Examples

```sh
chkit status
```

```
Migrations: 5 total, 3 applied, 2 pending
Checksum mismatches: 0
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
  "checksumMismatchCount": 0,
  "checksumMismatches": []
}
```

When checksum mismatches are detected, each entry includes the migration `name`, `expected` checksum (from the journal), and `actual` checksum (from the file on disk).

## Related commands

- [`chkit migrate`](/cli/migrate/) — apply pending migrations
- [`chkit check`](/cli/check/) — CI gate that evaluates pending migrations and checksums
