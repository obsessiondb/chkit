---
title: Python Overview
description: chkit-py is the Python port of chkit — same schema DSL, diff engine, and migration pipeline, importable as chkit.
sidebar:
  order: 1
---

`chkit-py` is the Python port of chkit — the same schema DSL, canonicalization, diff engine, migration planner, and SQL rendering, written in strict, fully typed Python.

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

The CLI commands, flags, exit codes, and `--json` output match the TypeScript CLI — the [CLI Reference](/cli/overview/) applies to both. Config lives in `clickhouse.config.py` instead of `clickhouse.config.ts`, and schema files are Python modules instead of TypeScript modules.

## Design

- **Type safety first.** Every public surface is annotated. Ships clean under `mypy --strict` and `pyright` strict mode.
- **Pydantic v2 models.** All schema objects are frozen, validated at construction, and reject unknown fields — typos surface as validation errors instead of being silently ignored.
- **Imperative core.** Pure functions over data; minimal classes outside of Pydantic models and the CLI shell.
- **No magic.** No dynamic imports and no runtime introspection of user code beyond what Pydantic provides.

## Interoperability with TypeScript chkit

Both implementations produce the same artifacts, so a project (or a team) can mix them:

- **Snapshots** — models serialize with the same camelCase JSON field names as `@chkit/core`, so `chkit/meta/snapshot.json` is readable by either implementation.
- **Journal** — migrations are recorded in the same ClickHouse `_chkit_migrations` table with the same schema and checksums.
- **SQL** — the planner and renderer emit the same DDL for the same schema, including `ON CLUSTER` stamping when `clickhouse.cluster` is set.

## Differences from the TypeScript version

The CLI, plugin set, and backfill engine are at full parity. The only remaining differences are by design (Python convention or ecosystem difference):

- `chkit skills` proxy and the `create-chkit` scaffolder — use `chkit init` instead.
- `deps.ts`-style dependency auto-install — install packages explicitly with `pip`.

## These pages

This section covers what is Python-specific: install, interoperability, and the [Core API](/python/core-api/) — loading, validation, diffing, planning, snapshots, and SQL rendering as library functions. The schema DSL itself is documented once for both languages, with synced language tabs, in the [Schema DSL Reference](/schema/dsl-reference/).

## Related

- [Schema DSL Reference](/schema/dsl-reference/) — `table()`, `view()`, `materialized_view()`, `dictionary()` with TypeScript/Python tabs.
- [CLI Reference](/cli/overview/) — commands and flags, shared by both implementations.
- [Configuration Overview](/configuration/overview/) — config keys with tabbed examples, identical modulo file extension.
