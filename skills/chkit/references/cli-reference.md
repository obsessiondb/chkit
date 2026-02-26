# CLI Reference

## Global Flags

Available on every command that loads a config file:

| Flag | Type | Default | Description |
|------|------|---------|-------------|
| `--config <path>` | string | `clickhouse.config.ts` | Path to config file |
| `--json` | boolean | `false` | Machine-readable JSON output |
| `--table <selector>` | string | — | Scope to matching tables |
| `--help` | boolean | — | Show help text |
| `--version` | boolean | — | Print CLI version |

### Table selector syntax

- Exact: `database.table` or `table`
- Prefix wildcard: `database.prefix*` or `prefix*`

## chkit init

Scaffolds `clickhouse.config.ts` and `src/db/schema/example.ts`. No flags.

## chkit generate

| Flag | Type | Description |
|------|------|-------------|
| `--name <name>` | string | Migration name (used in filename) |
| `--migration-id <id>` | string | Deterministic file prefix override |
| `--rename-table <mapping>` | string[] | `old_db.old_table=new_db.new_table` |
| `--rename-column <mapping>` | string[] | `db.table.old_column=new_column` |
| `--dryrun` | boolean | Print plan without writing files |
| `--table <selector>` | string | Scope to matching tables |

Exit codes: 0 = success, 1 = validation error.

### Risk levels

| Risk | Meaning | Examples |
|------|---------|---------|
| `safe` | No data loss | `CREATE TABLE`, `ADD COLUMN` |
| `caution` | Review recommended | Settings changes |
| `danger` | May cause data loss | `DROP TABLE`, `DROP COLUMN` |

## chkit migrate

| Flag | Type | Description |
|------|------|-------------|
| `--apply` | boolean | Apply pending migrations |
| `--execute` | boolean | Alias for `--apply` |
| `--allow-destructive` | boolean | Allow danger operations |
| `--table <selector>` | string | Scope to matching tables |

Exit codes: 0 = success, 1 = checksum mismatch, 3 = destructive operations blocked.

Non-interactive detection: `CI=1`/`CI=true`, stdin/stdout not TTY.

## chkit status

No command-specific flags. Read-only, no ClickHouse connection.

Reports: total, applied, pending migrations, checksum mismatches.

## chkit drift

| Flag | Type | Description |
|------|------|-------------|
| `--table <selector>` | string | Scope drift detection |

Requires snapshot and clickhouse config. Always exits 0 (use `chkit check` to enforce).

### Drift reason codes

Object-level: `missing_object`, `extra_object`, `kind_mismatch`
Table-level: `missing_column`, `extra_column`, `changed_column`, `setting_mismatch`, `index_mismatch`, `ttl_mismatch`, `engine_mismatch`, `primary_key_mismatch`, `order_by_mismatch`, `partition_by_mismatch`, `unique_key_mismatch`, `projection_mismatch`

## chkit check

| Flag | Type | Description |
|------|------|-------------|
| `--strict` | boolean | Force all policies on |

Exit codes: 0 = all pass, 1 = one or more failed.

### Policies

| Policy | Config key | Default |
|--------|-----------|---------|
| Fail on pending | `check.failOnPending` | `true` |
| Fail on checksum mismatch | `check.failOnChecksumMismatch` | `true` |
| Fail on drift | `check.failOnDrift` | `true` |

Failed check codes: `pending_migrations`, `checksum_mismatch`, `schema_drift`, `plugin:<name>`

## chkit codegen (plugin)

| Flag | Type | Description |
|------|------|-------------|
| `--check` | boolean | Validate output is current |
| `--out-file <path>` | string | Override output path |
| `--emit-zod` / `--no-emit-zod` | boolean | Toggle Zod schemas |
| `--emit-ingest` / `--no-emit-ingest` | boolean | Toggle ingest functions |
| `--ingest-out-file <path>` | string | Override ingest output path |
| `--bigint-mode <mode>` | string | `string` or `bigint` |
| `--include-views` | boolean | Include views in output |

## chkit pull (plugin)

Introspects live ClickHouse and generates TypeScript schema files.

## chkit plugin

Lists registered plugins and their commands. Usage: `chkit plugin [pluginName] [commandName]`.

## JSON Output Schema

All JSON responses include `command` and `schemaVersion: 1`.

### generate (dryrun)
```json
{ "command": "generate", "schemaVersion": 1, "mode": "plan",
  "operationCount": 2, "riskSummary": { "safe": 1, "caution": 1, "danger": 0 },
  "operations": [{ "type": "create_table", "key": "default.users", "risk": "safe", "sql": "..." }] }
```

### migrate (plan)
```json
{ "command": "migrate", "schemaVersion": 1, "mode": "plan",
  "pending": ["0004_add_column.sql"] }
```

### status
```json
{ "command": "status", "schemaVersion": 1,
  "total": 5, "applied": 3, "pending": 2,
  "pendingMigrations": ["0004_add_column.sql"],
  "checksumMismatchCount": 0 }
```

### check
```json
{ "command": "check", "schemaVersion": 1, "ok": false,
  "failedChecks": ["pending_migrations"],
  "pendingCount": 2, "drifted": false }
```
