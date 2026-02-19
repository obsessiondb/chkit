---
title: "chkit init"
description: "Scaffold a new chkit project with config and example schema files."
sidebar:
  order: 2
---

Creates a `clickhouse.config.ts` configuration file and an example schema file in your project. If either file already exists, it is left untouched.

## Synopsis

```
chkit init
```

## Flags

No command-specific flags. See [global flags](/cli/overview/#global-flags).

## Behavior

`chkit init` writes two files relative to the current working directory:

1. **`clickhouse.config.ts`** — project configuration with sensible defaults:
   - `schema: './src/db/schema/**/*.ts'`
   - `outDir: './chkit'`
   - `migrationsDir: './chkit/migrations'`
   - `metaDir: './chkit/meta'`
   - `plugins: []`
   - `clickhouse` block reading from environment variables (`CLICKHOUSE_URL`, `CLICKHOUSE_USER`, `CLICKHOUSE_PASSWORD`, `CLICKHOUSE_DB`)

2. **`src/db/schema/example.ts`** — a sample table definition using `MergeTree` engine with columns `id` (UInt64), `source` (String), and `ingested_at` (DateTime64(3)).

The command is idempotent — running it again on an existing project does nothing.

## Examples

**Initialize a new project:**

```sh
chkit init
```

Output:

```
Created clickhouse.config.ts
Created src/db/schema/example.ts
```

**Run on an existing project (no changes):**

```sh
chkit init
# No output — both files already exist
```

## Related commands

- [`chkit generate`](/cli/generate/) — generate migrations from your schema after init
