---
title: Python Core API
description: The chkit.core pipeline as library functions — loading, validation, diffing, planning, snapshots, and SQL rendering.
sidebar:
  order: 3
---

`chkit.core` exposes the pipeline underneath the CLI as plain functions over Pydantic models — load definitions, validate them, diff against a snapshot, and render SQL, all without the CLI.

```python
from chkit import (
    load_schema_definitions,
    validate_definitions,
    plan_diff,
    to_create_sql,
    apply_on_cluster_to_plan,
    define_config,
    resolve_config,
)
from chkit.core import create_snapshot, canonicalize_definitions, assert_valid_definitions
```

## The pipeline

`chkit generate` is, in essence, this sequence:

```python
from chkit import load_schema_definitions, plan_diff

old = snapshot.definitions          # last applied state (empty list on first run)
new = load_schema_definitions("./src/db/schema/**/*.py")
plan = plan_diff(old, new)

for op in plan.operations:
    print(op.risk, op.type, op.sql)
```

Each stage is available on its own.

## Loading definitions

### `load_schema_definitions(schema_globs, *, cwd=None)`

Resolves one glob (or a list of globs), imports each matching Python module, collects every module-level schema definition, and returns them canonicalized. Raises `SchemaLoaderError` when no files match (`NO_MATCH_MESSAGE`) and `ModuleLoadError` when a schema module fails to import.

```python
definitions = load_schema_definitions("./src/db/schema/**/*.py")
```

### `collect_definitions_from_module(mod)`

The lower-level collector: takes a module's `__dict__`-style mapping, walks its values (including nested lists and tuples), and returns the schema definitions found, deduplicated and canonicalized.

## Canonicalization

### `canonicalize_definitions(definitions)`

Normalizes definitions into the canonical form the diff engine compares — engine normalization, key-clause splitting, codec canonicalization — deduplicates by identity, and sorts deterministically (tables, then views, then materialized views; then by database and name). Both sides of every diff are canonicalized first, so cosmetic differences (`'MergeTree'` vs `'MergeTree()'`, `['id, org_id']` vs `['id', 'org_id']`) never produce operations.

### `definition_key(definition)`

Returns the stable identity string `"<kind>:<database>.<name>"` used for deduplication and operation keys.

## Validation

### `validate_definitions(definitions)`

Returns a list of `ValidationIssue` objects — empty when the definitions are valid. Each issue has a `code` (e.g. `duplicate_column_name`, `order_by_missing_column`, `codec_chain_must_end_with_general`), the offending object's `kind`, `database`, and `name`, and a human-readable `message`.

### `assert_valid_definitions(definitions)`

Same checks, but raises `ChxValidationError` (carrying the issue list as `.issues`) instead of returning them. The planner and SQL renderer call this internally, so invalid definitions cannot reach SQL generation.

## Planning

### `plan_diff(old_definitions, new_definitions)`

Canonicalizes both sides, validates the new side, and returns a `MigrationPlan`:

- `operations` — ordered `MigrationOperation` list; each has a `type` (e.g. `create_table`, `alter_table_add_column`, `drop_table`), a `key` identifying the object, a `risk` level, and the rendered `sql`.
- `risk_summary` — counts of `safe` / `caution` / `danger` operations.
- `rename_suggestions` — detected drop+add column pairs that look like renames, each with the `confirmation_sql` to apply the rename instead.

Risk levels drive CLI behavior: `danger` operations (drops, table recreates) are blocked by `chkit migrate` unless `--allow-destructive` is passed.

```python
plan = plan_diff(old, new)
if plan.risk_summary.danger > 0:
    raise SystemExit("plan contains destructive operations")
```

## Snapshots

### `create_snapshot(definitions)`

Canonicalizes the definitions and returns a `SnapshotV1` — `version: 1`, a UTC `generated_at` timestamp, and the canonical definition list. Serialized with camelCase aliases it has the same JSON shape as the TypeScript `chkit/meta/snapshot.json`:

```python
snapshot = create_snapshot(definitions)
payload = snapshot.model_dump(mode="json", by_alias=True)
```

Loading goes through the same model: `SnapshotV1.model_validate_json(text)` accepts snapshots written by either implementation.

## SQL rendering

### `to_create_sql(definition)`

Renders a single definition to its `CREATE TABLE` / `CREATE VIEW` / `CREATE MATERIALIZED VIEW` DDL string. Validates first, so it raises `ChxValidationError` on an invalid definition.

### `apply_on_cluster_to_plan(plan, cluster)`

Post-pass that stamps `ON CLUSTER '<name>'` into every DDL statement of a plan (and into each rename suggestion's confirmation SQL). No-op when `cluster` is `None`. This is how `clickhouse.cluster` from the config takes effect — the planner itself stays cluster-agnostic.

## Configuration

### `define_config(config)`

Anchors the config object in `clickhouse.config.py`. Accepts a `ChxUserConfig` instance, a plain dict (validated through Pydantic on entry), or a callable `(env: ChxConfigEnv) -> config` for dynamic per-command configs (see the [CI/CD guide](/guides/ci-cd/)):

```python
import os

from chkit import define_config

config = define_config(
    {
        "schema": "./src/db/schema/**/*.py",
        "outDir": "./chkit",
        "clickhouse": {
            "url": os.environ.get("CLICKHOUSE_URL", "http://localhost:8123"),
            "username": os.environ.get("CLICKHOUSE_USER", "default"),
            "password": os.environ.get("CLICKHOUSE_PASSWORD", ""),
            "database": os.environ.get("CLICKHOUSE_DB", "default"),
        },
    }
)
```

### `resolve_config(config)`

Fills in defaults and returns a `ChxResolvedConfig`: `out_dir` defaults to `./chkit`, `migrations_dir` to `<outDir>/migrations`, `meta_dir` to `<outDir>/meta`; the `check` flags default to `true` and `safety.allowDestructive` to `false`; ClickHouse credentials default to `default` / empty password / database `default`. A `clickhouse.cluster` value is validated here (identifier or `{macro}` form) — invalid names fail fast with a `ValueError`.

The option keys and defaults match the TypeScript config — see the [Configuration Overview](/configuration/overview/).

## Related

- [Schema DSL Reference](/schema/dsl-reference/) — building the definitions this pipeline consumes, with synced TypeScript/Python examples.
- [CLI: `chkit generate`](/cli/generate/) — the CLI wrapper around `plan_diff`.
- [CLI: `chkit migrate`](/cli/migrate/) — how plans are applied and journaled.
