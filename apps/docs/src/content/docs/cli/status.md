---
title: "chkit status"
description: "Show migration status including total, applied, pending, and checksum mismatches."
sidebar:
  order: 5
---

Reports the current migration state by comparing migration files on disk against the applied migration journal stored in ClickHouse.

## Synopsis

```
chkit status [flags]
```

## Flags

No command-specific flags. See [global flags](/cli/overview/#global-flags).

## Behavior

`chkit status` reads the migrations directory and the `_chkit_migrations` table in ClickHouse to compute:

- **Total** migration files (`.sql` files in `migrationsDir`, sorted alphabetically)
- **Applied** migrations (entries recorded in `_chkit_migrations`)
- **Pending** migrations (on disk but not yet applied)
- **Checksum mismatches** (applied migrations whose SHA-256 checksum no longer matches the file on disk)

`chkit status` requires a `clickhouse` config block because the migration journal is stored in ClickHouse. It does not modify your schema, but it is not strictly read-only: on the first run, if the `_chkit_migrations` journal table does not yet exist, it is created automatically. That first invocation therefore needs write privileges (or run [`chkit migrate`](/cli/migrate/) first, which creates the table). Once the table exists, `chkit status` only reads from it.

## Examples

```sh
chkit status
```

```
Migrations directory: /absolute/path/to/chkit/migrations
Total migrations:     5
Applied:              3
Pending:              2
```

```sh
chkit status --json
```

## Exit codes

| Code | Meaning |
|------|---------|
| 0 | Success |
| 1 | Command failed (for example missing `clickhouse` config or connection error) |

## JSON output

```json
{
  "command": "status",
  "schemaVersion": 1,
  "migrationsDir": "/absolute/path/to/migrations",
  "total": 5,
  "applied": 3,
  "pending": 2,
  "pendingMigrations": ["0004_add_column.sql", "0005_create_index.sql"],
  "checksumMismatchCount": 0,
  "checksumMismatches": []
}
```

When checksum mismatches are detected, each entry includes the migration `name`, `expected` checksum (from the journal), and `actual` checksum (from the file on disk).

## Related commands

- [`chkit migrate`](/cli/migrate/) — apply pending migrations
- [`chkit check`](/cli/check/) — CI gate that evaluates pending migrations and checksums
