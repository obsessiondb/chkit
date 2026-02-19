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

Each destructive operation includes a warning code, reason, impact description, and recommendation:

| Warning code | Operation |
|-------------|-----------|
| `drop_table_data_loss` | `DROP TABLE` |
| `drop_column_irreversible` | `DROP COLUMN` |
| `drop_view_dependency_break` | `DROP VIEW` / `DROP MATERIALIZED VIEW` |
| `destructive_operation_review_required` | Other destructive operations |

### Checksum verification

Before applying, the CLI verifies SHA-256 checksums of all previously-applied migrations against the files on disk. If any file has been modified since it was applied, the command aborts with exit code 1.

### Journal

Each applied migration is recorded in `journal.json` (in `metaDir`) with:

- `name` — the migration filename
- `appliedAt` — ISO 8601 timestamp
- `checksum` — SHA-256 hash of the file content

The journal is written after each migration, not batched.

### Table scoping

The `--table` flag filters pending migrations to those containing operations targeting the matched tables. Migration SQL files are parsed for `-- operation:` comment markers to determine which tables they affect.

### Plugin hooks

The `onBeforeApply` plugin hook runs before each migration is executed and can transform the SQL statements. The `onAfterApply` hook runs after successful execution.

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
  "pending": ["0004_add_column.sql", "0005_create_index.sql"]
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
    { "name": "0004_add_column.sql", "appliedAt": "2025-06-15T10:30:00.000Z", "checksum": "a1b2c3..." }
  ],
  "journalFile": "./chkit/meta/journal.json"
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
    { "name": "0002_init.sql", "expected": "abc123...", "actual": "def456..." }
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
  "destructiveMigrations": ["0005_drop_old_table.sql"],
  "destructiveOperations": [
    {
      "migration": "0005_drop_old_table.sql",
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

## Related commands

- [`chkit generate`](/cli/generate/) — produce migration files from schema changes
- [`chkit status`](/cli/status/) — check migration state without applying
- [`chkit check`](/cli/check/) — CI gate that evaluates pending migrations and checksums
