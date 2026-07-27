---
title: Codegen Plugin
description: Generate TypeScript row types, optional Zod schemas, ingestion functions, and runtime migration modules from chkit schema definitions.
sidebar:
  order: 2
---

This document covers practical usage of the optional `codegen` plugin.

## What it does

- Generates deterministic TypeScript row types from chkit schema definitions.
- Generates a typed interface (and optional Zod schema) for each `dictionary()` from its `attributes` — dictionaries are always included, regardless of `includeViews`.
- Optionally generates Zod schemas from the same definitions.
- Optionally generates typed ingestion functions for inserting rows into ClickHouse tables. Generated ingest helpers gzip-compress request bodies by default and can opt out per call.
- Optionally generates a self-contained runtime migration module with all migration SQL inlined, for environments without filesystem access (e.g., Cloudflare Workers).

## How it fits your workflow

The plugin is designed so your existing chkit workflow can stay the same.

- [`chkit generate`](/cli/generate/) integration:
  - After a successful migration/snapshot generate, codegen runs automatically by default (`runOnGenerate: true`).
  - Result: migration artifacts and generated types stay in sync in normal dev flow.
- [`chkit check`](/cli/check/) integration:
  - `check` evaluates codegen freshness via plugin hook.
  - If generated types are missing/stale, `failedChecks` includes `plugin:codegen`.
  - Result: CI enforcement works without adding a separate codegen step.
- [`chkit codegen`](/cli/codegen/) command:
  - Optional manual trigger.
  - Useful when you explicitly want to regenerate or run an isolated `--check`.

## Plugin setup

In `clickhouse.config.ts`, register `codegen(...)` from `@chkit/plugin-codegen`.

:::note
`zod` is a peer dependency (`^4.0.0`). Install it alongside the plugin — generated Zod schemas (`emitZod: true`) import `zod` from your project, so they resolve against your own copy rather than a bundled one.

```sh
bun add -d @chkit/plugin-codegen zod
```
:::

Recommended typed setup:

```ts
import { defineConfig } from '@chkit/core'
import { codegen } from '@chkit/plugin-codegen'

export default defineConfig({
  schema: './src/db/schema/**/*.ts',
  plugins: [
    codegen({
      outFile: './src/generated/chkit-types.ts',
      emitZod: false,
      emitIngest: false,
      ingestOutFile: './src/generated/chkit-ingest.ts',
      emitMigrations: false,
      migrationsOutFile: './src/generated/chkit-migrations.ts',
      tableNameStyle: 'pascal',
      bigintMode: 'string',
      includeViews: false,
      runOnGenerate: true,
      failOnUnsupportedType: true,
    }),
  ],
})
```

## Options

- `outFile` (default: `./src/generated/chkit-types.ts`)
- `emitZod` (default: `false`)
- `emitIngest` (default: `false`)
- `ingestOutFile` (default: `./src/generated/chkit-ingest.ts`)
- `emitMigrations` (default: `false`)
- `migrationsOutFile` (default: `./src/generated/chkit-migrations.ts`)
- `tableNameStyle` (default: `pascal`) values: `pascal | camel | raw`
- `bigintMode` (default: `string`) values: `string | bigint`
- `includeViews` (default: `false`)
- `runOnGenerate` (default: `true`)
- `failOnUnsupportedType` (default: `true`)

Invalid option values fail fast at startup via plugin config validation.

## Commands

- [`chkit codegen`](/cli/codegen/)
  - Optional manual command to generate and write output atomically.
- [`chkit codegen --check`](/cli/codegen/)
  - Optional manual check to validate output is current without writing.
  - Fails with:
    - `codegen_missing_output` (types file missing)
    - `codegen_stale_output` (types content drift)
    - `codegen_missing_ingest_output` (ingest file missing, when `emitIngest` is enabled)
    - `codegen_stale_ingest_output` (ingest content drift, when `emitIngest` is enabled)
    - `codegen_missing_migrations_output` (migrations file missing, when `emitMigrations` is enabled)
    - `codegen_stale_migrations_output` (migrations content drift, when `emitMigrations` is enabled)

Useful flags:

- `--out-file <path>`
- `--emit-zod` / `--no-emit-zod`
- `--emit-ingest` / `--no-emit-ingest`
- `--ingest-out-file <path>`
- `--emit-migrations` / `--no-emit-migrations`
- `--migrations-out-file <path>`
- `--bigint-mode <string|bigint>`
- `--include-views`

## Generated ingest helpers

When `emitIngest` is enabled, generated ingest helpers accept runtime options. Request-body compression is enabled by default for these helpers:

```ts
await ingestDefaultUsers(db, rows)
```

Disable compression for a specific call when needed:

```ts
await ingestDefaultUsers(db, rows, { compressed: false })
```

When `emitZod` is enabled, the same options object also controls validation:

```ts
await ingestDefaultUsers(db, rows, { validate: true })
```

## CI / check integration

When configured, [`chkit check`](/cli/check/) includes a `plugins.codegen` block in JSON output and can fail with `plugin:codegen`.

`plugin:codegen` is added to `failedChecks` when the plugin check returns an error finding (for example stale or missing generated artifacts).

## Generate integration

When `runOnGenerate` is enabled (default), [`chkit generate`](/cli/generate/) runs codegen after successful migration/snapshot generation.

If codegen fails in that path, `chkit generate` fails.

## Runtime migration module

When `emitMigrations` is enabled, the plugin generates a self-contained TypeScript module that inlines all migration SQL. This is designed for environments without filesystem access at runtime — such as Cloudflare Workers, Deno Deploy, or serverless functions — where reading `.sql` files from disk is not possible.

The generated file exports:

- **`migrations`** — an array of `MigrationEntry` objects, each containing a `name` and the raw `sql` string.
- **`runMigrations(executor, options?)`** — applies pending migrations against a provided executor, tracking progress in a `_chkit_migrations` journal table.

### MigrationExecutor interface

The `runMigrations` function accepts any object that satisfies the `MigrationExecutor` interface:

```ts
interface MigrationExecutor {
  execute(sql: string): Promise<void>
  query<T>(sql: string): Promise<T[]>
}
```

This keeps the generated module independent of any specific ClickHouse client library. Wrap your client to match this interface.

### Usage example

```ts
import { runMigrations } from './generated/chkit-migrations'

const result = await runMigrations(executor)
// result.applied  — migrations that were run
// result.skipped  — migrations already in the journal
```

You can override the journal table name:

```ts
await runMigrations(executor, { journalTable: 'my_migrations' })
```

### How it stays in sync

When `runOnGenerate` is enabled (the default), the migration module is regenerated every time `chkit generate` produces new migrations. `chkit check` and `chkit codegen --check` detect stale or missing migration output via the `codegen_missing_migrations_output` and `codegen_stale_migrations_output` error codes.

## Current limits

- Query-level type inference is not included.
- Arbitrary SQL expression typing is not included.
- Views/materialized views are opt-in (`includeViews`) and emitted conservatively (`{ [key: string]: unknown }`). Dictionaries are always included and typed from `attributes`, since their shape is structured rather than an arbitrary query.
