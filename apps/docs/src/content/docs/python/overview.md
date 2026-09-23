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
- **SQL**: the planner and renderer emit the same DDL for the same schema, including `ON CLUSTER` stamping when `clickhouse.cluster` is set.

## Differences from the TypeScript version

The schema/migration CLI and backfill engine share the TypeScript workflow. The following features are TypeScript-only:

- `chkit skills` proxy and the `create-chkit` scaffolder: use `chkit init` instead.
- `deps.ts`-style dependency auto-install: install packages explicitly with `pip`.
- [`@chkit/plugin-ingest`](/ingestion/) and the project `entry` module: ingestion source authoring requires TypeScript.

## These pages

Use the [Core API](/python/core-api/) to load and validate definitions, plan diffs, manage snapshots, and render SQL from Python. Use the Python tabs in the [Schema DSL Reference](/schema/dsl-reference/) for schema definitions.

## Related

- [Schema DSL Reference](/schema/dsl-reference/): `table()`, `view()`, `materialized_view()`, `dictionary()` with TypeScript/Python tabs.
- [CLI Reference](/cli/overview/): commands and flags, shared by both implementations.
- [Configuration Overview](/configuration/overview/): config keys with tabbed examples, identical modulo file extension.
