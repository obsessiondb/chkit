---
title: "chkit generate"
description: "Diff schema definitions against the last snapshot and produce migration SQL."
sidebar:
  order: 3
---

Compares your current schema definitions against the previous snapshot, computes a migration plan, and writes migration SQL and an updated snapshot.

## Synopsis

```
chkit generate [flags]
```

## Flags

| Flag | Type | Default | Description |
|------|------|---------|-------------|
| `--name <name>` | string | — | Migration name (used in the filename) |
| `--migration-id <id>` | string | — | Escape hatch: override the default timestamp migration prefix |
| `--rename-table <mapping>` | string | — | Explicit table rename: `old_db.old_table=new_db.new_table` |
| `--rename-column <mapping>` | string | — | Explicit column rename: `db.table.old_column=new_column` |
| `--rename-dictionary <mapping>` | string | — | Explicit dictionary rename: `old_db.old_dict=new_db.new_dict` |
| `--table <selector>` | string | — | Scope operations to matching tables |
| `--dryrun` | boolean | `false` | Print the plan without writing any files |
| `--empty` | boolean | `false` | Scaffold a blank manual migration without diffing the schema |

Global flags documented on [CLI Overview](/cli/overview/#global-flags).

## Behavior

### Schema diff and plan

1. Loads your config and schema definitions
2. Reads the previous snapshot from `metaDir/snapshot.json`
3. Computes a diff between old and new definitions using `planDiff()` from `@chkit/core`
4. Produces an ordered list of SQL operations (see [Operation order](/cli/generate/#operation-order))

Definitions are compared in canonical form. SQL fragments such as a view's `as` lose their comments and have each run of whitespace collapsed to one space, so editing a comment or re-indenting a query does not produce a migration. See [SQL fragments](/schema/dsl-reference/#sql-fragments).

If there are no differences, no migration file is created.

### Operation order

Operations run in groups. Without a rename, the order is drops, then `ALTER` statements, then `CREATE DATABASE`, then creates. When a rename is applied (a `--rename-*` flag or `renamedFrom`), the order is drops, then `CREATE DATABASE`, then table and dictionary renames, then the other `ALTER` statements (column renames included), then creates. Creates run tables first, then views, then dictionaries and materialized views; drops run one object type at a time. Each group is sorted by name. Statements for the same column keep their planned order: removing a column's expression (`REMOVE DEFAULT` or `REMOVE MATERIALIZED`) runs right before the column's `MODIFY COLUMN`.

`generate` then reorders creates and drops by the dependencies between the objects in the migration: an object is created after every object it reads and dropped before them. A view that reads another view, a materialized view, or a dictionary is created after it, even when its name sorts first. Dependencies come from:

- `database.name` references in a view or materialized view query, including subqueries, joins, and `IN` clauses
- unqualified names directly after `FROM` or `JOIN`, resolved against the view's own database (CTE names are skipped)
- the name argument of `dictGet` and its variants, `dictHas`, `dictIsIn`, `joinGet`, and the `dictionary()` table function, as a string (`'analytics.users_dict'`) or a name (`analytics.users_dict`, `users_dict`); either form without a database resolves against the object's own database
- a materialized view's `to` table and `refresh.dependsOn` views
- the column expressions (`DEFAULT`, `MATERIALIZED`, `ALIAS`, and `EPHEMERAL`) of a table that is created or dropped, such as a default that calls `dictGet`
- a dictionary's `CLICKHOUSE` source, as `TABLE`/`DB` or `QUERY`

Apart from those name arguments and source parameters, names inside string literals and comments are ignored. Objects with no dependency inside the migration keep the kind-then-name order, and objects that reference each other in a cycle keep that order among themselves. Only dependencies inside the migration count: a refreshable materialized view whose `DEPENDS ON` target already exists is ordered like any other object.

`ALTER` statements are not reordered. A migration that adds or modifies a column whose expression calls `dictGet` on a dictionary created in the same migration fails, because the `ALTER` runs before the dictionary exists. A migration that drops a dictionary and also drops or changes the column expression that calls it fails too, because the dictionary drop runs first. Split such a change into two migrations: create the dictionary first, or change the column first.

Qualify names in view SQL (`analytics.events`, not `events`). ClickHouse resolves an unqualified name against the session's current database, which `generate` can't see, so `generate` assumes the view's own database.

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
2. **CLI flags** — `--rename-table old_db.old_table=new_db.new_table`, `--rename-column db.table.old_col=new_col`, and `--rename-dictionary old_db.old_dict=new_db.new_dict`

CLI flags take priority when both sources specify a mapping for the same object. Rename flags accept comma-separated values for multiple mappings.

A dictionary rename emits a single `RENAME DICTIONARY IF EXISTS ... TO ...` statement instead of a `drop_dictionary` + `create_dictionary` pair — see [Dictionary rename](/schema/dsl-reference/#dictionary-rename).

Validation errors are raised for conflicting, chained, or cyclic rename mappings.

### Dictionary password warnings

A dictionary's `SOURCE(...)` clause is a raw string (see [Credentials in `source`](/schema/dsl-reference/#credentials-in-source)), so any credentials it embeds are written verbatim into the generated migration SQL — ClickHouse has no DDL-level secret substitution. A password change is a real diff like any other field change and produces a `CREATE OR REPLACE DICTIONARY` migration.

`generate` warns when a dictionary being created or replaced this run has a literal `password '...'` in its `SOURCE(...)` — it will land in the committed migration file as plain text. This prints to the console and is included as a `warnings` array in `--json` output.

The one exception: a dictionary whose `source` still carries ClickHouse's `[HIDDEN]` introspection placeholder (written by [`chkit pull`](/plugins/pull/#credential-handling-hidden-passwords) when it can't recover the real password) never produces a migration on its own — chkit doesn't know the real value, so it can't safely diff or render it. Replace `[HIDDEN]` with a real credential in the schema file first.

### Dryrun mode

With `--dryrun`, the command prints the migration plan (operations with risk levels and SQL) without writing any files. Useful for previewing changes before committing.

Plans for objects in a database include a `create_database` operation (`CREATE DATABASE IF NOT EXISTS`, risk `safe`), so a single new table reports `operationCount: 2` — the `create_database` plus the `create_table`. The `CREATE DATABASE` is idempotent and a no-op if the database already exists.

### Empty mode

With `--empty`, the command skips the schema diff entirely and writes a blank, timestamped migration stub for you to hand-edit. Use it for DDL that chkit does not model — raw `INSERT`/backfill statements, `OPTIMIZE`, manual dictionary reloads, or one-off data fixes.

The stub carries the standard migration header (with `operation-count: 0`) plus a placeholder comment. The snapshot is left untouched, so an empty migration never absorbs pending schema drift. The `--name` and `--migration-id` flags apply; without `--name`, the file defaults to `manual`. Schema-diff flags (`--table`, `--rename-table`, `--rename-column`, `--rename-dictionary`, `--dryrun`) are not used in empty mode.

`chkit migrate` picks the file up like any other migration and applies it in filename order. Until the stub contains at least one SQL statement, `chkit migrate --apply` refuses to run and lists it (see [empty migrations](/cli/migrate/#empty-migrations)), so an unfinished stub is never recorded as applied. Editing a migration after it has run triggers a checksum mismatch.

### Codegen integration

If the codegen plugin is configured with `runOnGenerate: true` (the default), `chkit generate` automatically runs codegen after writing migration artifacts. A codegen failure causes `generate` to fail.

### Validation errors

Schema validation issues (such as invalid definitions) produce a `validation_failed` error with structured issue codes and messages. The process exits with code 1 and writes no migration or snapshot. For example, a function call written as the plain string `DEFAULT` of a column that cannot hold a string (`default: 'now64(3)'` on a `DateTime64` column) fails with `column_default_looks_like_expression` instead of producing a migration that ClickHouse rejects. See [Validation rules](/schema/dsl-reference/#validation-rules) for every code.

## Examples

**Generate a named migration:**

```sh
chkit generate --name add_users_table
```

**Preview changes without writing files:**

```sh
chkit generate --dryrun
```

**Scaffold a blank manual migration:**

```sh
chkit generate --empty --name backfill_signups
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

**Explicit dictionary rename:**

```sh
chkit generate --rename-dictionary old_db.old_dict=new_db.new_dict
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
  "riskSummary": { "safe": 2, "caution": 0, "danger": 0 },
  "operations": [
    { "type": "create_database", "key": "database:default", "risk": "safe", "sql": "CREATE DATABASE IF NOT EXISTS default;" },
    { "type": "create_table", "key": "default.users", "risk": "safe", "sql": "CREATE TABLE ..." }
  ],
  "renameSuggestions": [],
  "warnings": []
}
```

### Apply mode (default)

```json
{
  "command": "generate",
  "schemaVersion": 1,
  "scope": { "enabled": false },
  "migrationFile": "./chkit/migrations/20260604104251_add_users_table.sql",
  "snapshotFile": "./chkit/meta/snapshot.json",
  "definitionCount": 3,
  "operationCount": 2,
  "riskSummary": { "safe": 2, "caution": 0, "danger": 0 },
  "warnings": []
}
```

### Empty mode (`--empty`)

```json
{
  "command": "generate",
  "schemaVersion": 1,
  "mode": "empty",
  "migrationFile": "./chkit/migrations/20260604104251_backfill_signups.sql"
}
```

### Validation error

```json
{
  "command": "generate",
  "schemaVersion": 1,
  "error": "validation_failed",
  "issues": [
    {
      "code": "column_default_looks_like_expression",
      "kind": "table",
      "database": "analytics",
      "name": "events",
      "message": "Table analytics.events column \"updated_at\" has default \"now64(3)\", a plain string that looks like a SQL function call. Plain strings render as quoted literals (DEFAULT 'now64(3)'), which ClickHouse rejects for type DateTime64(3, 'UTC'). Use default: { expression: \"now64(3)\" } to render DEFAULT now64(3). If chkit misjudged the type and the column should store this text, use default: { expression: \"'now64(3)'\" }."
    }
  ]
}
```

## Related commands

- [The migration workflow](/guides/migration-workflow/) — why generate is offline, and what to commit alongside the SQL
- [`chkit init`](/cli/init/) — scaffold a project before your first generate
- [`chkit migrate`](/cli/migrate/) — apply generated migrations to ClickHouse
- [`chkit codegen`](/cli/codegen/) — manually trigger type generation
- [`chkit snapshot`](/cli/snapshot/) — rebuild `snapshot.json` after two branches conflict on it
