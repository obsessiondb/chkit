---
title: "chkit generate"
description: "Diff schema definitions against the last snapshot and produce migration SQL."
sidebar:
  order: 3
---

Compares your current TypeScript schema definitions against the previous snapshot, computes a migration plan, and writes migration SQL and an updated snapshot.

## Synopsis

```
chkit generate [flags]
```

## Flags

| Flag | Type | Default | Description |
|------|------|---------|-------------|
| `--name <name>` | string | — | Migration name (used in the filename) |
| `--migration-id <id>` | string | — | Deterministic migration file prefix override |
| `--rename-table <mapping>` | string | — | Explicit table rename: `old_db.old_table=new_db.new_table` |
| `--rename-column <mapping>` | string | — | Explicit column rename: `db.table.old_column=new_column` |
| `--table <selector>` | string | — | Scope operations to matching tables |
| `--dryrun` | boolean | `false` | Print the plan without writing any files |

Global flags documented on [CLI Overview](/cli/overview/#global-flags).

## Behavior

### Schema diff and plan

1. Loads your config and schema definitions
2. Reads the previous snapshot from `metaDir/snapshot.json`
3. Computes a diff between old and new definitions using `planDiff()` from `@chkit/core`
4. Produces an ordered list of SQL operations

If there are no differences, no migration file is created.

### Risk levels

Every operation in the plan is assigned a risk level:

| Risk | Meaning | Example operations |
|------|---------|-------------------|
| `safe` | Non-destructive, no data loss | `CREATE TABLE`, `ADD COLUMN` |
| `caution` | Potentially impactful, review recommended | `ALTER TABLE` settings changes |
| `danger` | Destructive, may cause data loss | `DROP TABLE`, `DROP COLUMN` |

### Table scoping

The `--table` flag limits operations to tables matching a selector:

- `database.table` — exact match
- `database.prefix*` — prefix wildcard in a specific database
- `table` — matches across all databases

An empty match set emits a warning and produces no output.

### Rename workflow

chkit detects potential renames through two mechanisms:

1. **Schema metadata** — set `renamedFrom` on your schema definition
2. **CLI flags** — `--rename-table old_db.old_table=new_db.new_table` and `--rename-column db.table.old_col=new_col`

CLI flags take priority when both sources specify a mapping for the same object. Rename flags accept comma-separated values for multiple mappings.

Validation errors are raised for conflicting, chained, or cyclic rename mappings.

### Dryrun mode

With `--dryrun`, the command prints the migration plan (operations with risk levels and SQL) without writing any files. Useful for previewing changes before committing.

### Codegen integration

If the codegen plugin is configured with `runOnGenerate: true` (the default), `chkit generate` automatically runs codegen after writing migration artifacts. A codegen failure causes `generate` to fail.

### Validation errors

Schema validation issues (such as invalid definitions) produce a `validation_failed` error with structured issue codes and messages. The process exits with code 1.

## Examples

**Generate a named migration:**

```sh
chkit generate --name add_users_table
```

**Preview changes without writing files:**

```sh
chkit generate --dryrun
```

**Scope to a specific table:**

```sh
chkit generate --table analytics.events
```

**Explicit table rename:**

```sh
chkit generate --rename-table old_db.users=new_db.accounts
```

**Explicit column rename:**

```sh
chkit generate --rename-column analytics.events.old_name=new_name
```

## Exit codes

| Code | Meaning |
|------|---------|
| 0 | Success |
| 1 | Validation error |

## JSON output

### Plan mode (`--dryrun`)

```json
{
  "command": "generate",
  "schemaVersion": 1,
  "scope": { "enabled": false },
  "mode": "plan",
  "operationCount": 2,
  "riskSummary": { "safe": 1, "caution": 1, "danger": 0 },
  "operations": [
    { "type": "create_table", "key": "default.users", "risk": "safe", "sql": "CREATE TABLE ..." }
  ],
  "renameSuggestions": []
}
```

### Apply mode (default)

```json
{
  "command": "generate",
  "schemaVersion": 1,
  "scope": { "enabled": false },
  "migrationFile": "./chkit/migrations/0001_add_users_table.sql",
  "snapshotFile": "./chkit/meta/snapshot.json",
  "definitionCount": 3,
  "operationCount": 2,
  "riskSummary": { "safe": 1, "caution": 1, "danger": 0 }
}
```

### Validation error

```json
{
  "command": "generate",
  "schemaVersion": 1,
  "error": "validation_failed",
  "issues": [{ "code": "...", "message": "..." }]
}
```

## Related commands

- [`chkit init`](/cli/init/) — scaffold a project before your first generate
- [`chkit migrate`](/cli/migrate/) — apply generated migrations to ClickHouse
- [`chkit codegen`](/cli/codegen/) — manually trigger TypeScript type generation
