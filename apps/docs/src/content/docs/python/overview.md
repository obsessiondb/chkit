---
title: Python Overview
description: Define ClickHouse schemas and run migrations in Python with chkit-py.
sidebar:
  order: 1
---

Use `chkit-py` to define ClickHouse schemas and run the chkit migration workflow in Python.

## Install

```sh
pip install chkit-py
chkit --help
```

The package is named `chkit-py` on PyPI; the import name is `chkit`.

## Quickstart

```sh
pip install chkit-py
chkit init                    # scaffold clickhouse.config.py + example schema
chkit generate --name init    # diff schema vs snapshot, write migrations/*.sql
chkit migrate --apply         # apply pending migrations
chkit status                  # show applied / pending counts
chkit check --strict          # CI gate (pending, drift, checksum)
```

Use the [CLI Reference](/cli/overview/) for shared commands, flags, exit codes, and `--json` output. See the [TypeScript-only features](#differences-from-the-typescript-version) below. Config lives in `clickhouse.config.py` instead of `clickhouse.config.ts`, and schema files are Python modules instead of TypeScript modules.

## Design

- **Type checking.** Public APIs have type annotations checked with `mypy --strict` and pyright strict mode.
- **Pydantic v2 models.** Schema objects are frozen. Pydantic validates them at construction and rejects unknown fields.
- **Imperative core.** Pure functions over data; minimal classes outside of Pydantic models and the CLI shell.

## Interoperability with TypeScript chkit

Both implementations produce the same artifacts, so a project (or a team) can mix them:

- **Snapshots**: models serialize with the same camelCase JSON field names as `@chkit/core`, so `chkit/meta/snapshot.json` is readable by either implementation.
- **Journal**: migrations are recorded in the same ClickHouse `_chkit_migrations` table with the same schema and checksums.
- **SQL**: the planner and renderer emit the same DDL statements for the same schema, including `ON CLUSTER` stamping when `clickhouse.cluster` is set. The statement order can differ when objects in a migration depend on each other, and the SQL differs when a SQL fragment or an expression default contains comments (see below).

## Differences from the TypeScript version

The schema/migration CLI and backfill engine share the TypeScript workflow. The following features are TypeScript-only:

- `chkit skills` proxy and the `create-chkit` scaffolder: use `chkit init` instead.
- [`chkit snapshot rebuild`](/cli/snapshot/): chkit-py cannot rewrite a conflicted `snapshot.json` from the schema definitions yet, and reports conflict markers as a JSON parse error.
- `deps.ts`-style dependency auto-install: install packages explicitly with `pip`.
- [`@chkit/plugin-ingest`](/api-sync/) and the project `entry` module: API sync source authoring requires TypeScript.
- Dependency-ordered migrations: chkit-py orders creates and drops by kind and name, so a view that reads another view, a materialized view, or a dictionary can be created before it. See [Operation order](/cli/generate/#operation-order).
- Comments in SQL fragments: chkit-py keeps comments when it puts a view query or another SQL fragment on one line, so a `--`, `//`, or `#` comment swallows the rest of the statement. Keep comments out of these fields with chkit-py. See [SQL fragments](/schema/dsl-reference/#sql-fragments).
- Expression column defaults: chkit-py accepts only the `fn:` spelling (`"default": "fn:now64(3)"`), not `{"expression": ...}`, and does not run the `column_default_looks_like_expression` and `column_default_invalid` checks, so a function call written as the plain string default of a `DEFAULT` or `EPHEMERAL` column reaches ClickHouse as a quoted literal. It also keeps comments in an expression default when it renders it. Snapshots stay compatible: TypeScript chkit stores `{ expression }` defaults as `fn:` strings. See [`default`](/schema/dsl-reference/#default-string--number--boolean--sqlexpression-optional).
- Failed-migration recovery: chkit-py records the progress of async statements only. Re-running a failed migration runs its other statements again from statement 1, including those that completed, and an edited file is refused once one of its async statements was attempted. chkit-py has no `migrate --retry` or `--abandon`, records a migration file without executable statements as applied, and sends a statement made only of comments to ClickHouse, which rejects it. Its async status polling can mistake an earlier attempt with the same query id for the current one, and in `--json` mode it drops async progress lines instead of writing them to stderr. See [failed migrations](/cli/migrate/#failed-migrations).
- ObsessionDB override flags: chkit-py's commands reject `--force-shared-engines` and `--no-shared-engines`, so the ObsessionDB plugin always decides from `clickhouse.url` whether to strip `storage_policy`. See [CLI flag overrides](/obsessiondb/engine-rewriting/#cli-flag-overrides).

## These pages

Use the [Core API](/python/core-api/) to load and validate definitions, plan diffs, manage snapshots, and render SQL from Python. Use the Python tabs in the [Schema DSL Reference](/schema/dsl-reference/) for schema definitions.

## Related

- [Schema DSL Reference](/schema/dsl-reference/): `table()`, `view()`, `materialized_view()`, `dictionary()` with TypeScript/Python tabs.
- [CLI Reference](/cli/overview/): commands and flags, shared by both implementations.
- [Configuration Overview](/configuration/overview/): config keys with tabbed examples, identical modulo file extension.
