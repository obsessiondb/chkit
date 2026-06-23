---
title: CLI Overview
description: Command surface of the chkit CLI.
sidebar:
  order: 1
---

The `chkit` CLI manages ClickHouse schemas, migrations, drift detection, and CI checks from the command line. It follows a workflow-oriented design: define your schema in TypeScript, generate migrations, apply them, and verify everything stays in sync.

## Commands

| Command | Description |
|---------|-------------|
| [`chkit init`](/cli/init/) | Scaffold a new project with config and example schema |
| [`chkit generate`](/cli/generate/) | Diff schema definitions against the last snapshot and produce migration SQL |
| [`chkit migrate`](/cli/migrate/) | Apply pending migration files to ClickHouse |
| [`chkit status`](/cli/status/) | Show migration status (total, applied, pending, checksum mismatches) |
| [`chkit drift`](/cli/drift/) | Compare snapshot against live ClickHouse and report differences |
| [`chkit check`](/cli/check/) | Run policy checks for CI gates (pending, checksums, drift, plugins) |
| [`chkit query`](/cli/query/) | Run an ad-hoc SQL query against the configured target |
| [`chkit pull`](/cli/pull/) | Introspect live ClickHouse and generate a TypeScript schema file |
| [`chkit codegen`](/cli/codegen/) | Generate TypeScript types from schema definitions |
| [`chkit plugin`](/cli/plugin/) | List or run plugin commands |

## Typical workflow

```
chkit init          # scaffold config + example schema
chkit generate      # diff schema → produce migration SQL + snapshot
chkit migrate       # apply pending migrations to ClickHouse
chkit status        # verify migration state
chkit check         # CI gate: pending, checksums, drift, plugins
```

## Global flags

These flags are available on every command that loads a config file:

| Flag | Type | Default | Description |
|------|------|---------|-------------|
| `--config <path>` | string | `clickhouse.config.ts` | Path to the chkit config file |
| `--json` | boolean | `false` | Emit machine-readable JSON output |
| `--table <selector>` | string | — | Narrow some commands to matching tables (exact name or trailing wildcard prefix, e.g. `events_*`). Effect varies per command — see note below |
| `--help` | boolean | — | Show help text |
| `--version` | boolean | — | Print CLI version |

`--table` is accepted by every command, but it is **not a universal, whole-command filter** — treat it as a scoping hint, not a guarantee:

- `generate`, `migrate`, and `drift` use it to narrow the schema/migration operations they plan or evaluate.
- `check` applies it only to its drift and plugin checks; the pending-migration and checksum checks still run across **all** tables, so `chkit check --table app.users` can still fail on an unrelated pending migration.
- `status`, `codegen`, and `pull` accept the flag but ignore it, so `chkit status --table app.users` still reports unscoped totals.

When you need a result strictly limited to specific tables, check the individual command's page for its exact scoping behavior.
