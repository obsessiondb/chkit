---
title: Codegen Plugin
description: Generate TypeScript row types, optional Zod schemas, and ingestion functions from chkit schema definitions.
---

This document covers practical usage of the optional `codegen` plugin.

## What it does

- Generates deterministic TypeScript row types from chkit schema definitions.
- Optionally generates Zod schemas from the same definitions.
- Optionally generates typed ingestion functions for inserting rows into ClickHouse tables.

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
      tableNameStyle: 'pascal',
      bigintMode: 'string',
      includeViews: false,
      runOnGenerate: true,
      failOnUnsupportedType: true,
    }),
  ],
})
```

Legacy path-based registration via `{ resolve: './plugins/codegen.ts', options: {...} }` remains supported.

## Options

- `outFile` (default: `./src/generated/chkit-types.ts`)
- `emitZod` (default: `false`)
- `emitIngest` (default: `false`)
- `ingestOutFile` (default: `./src/generated/chkit-ingest.ts`)
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

Useful flags:

- `--out-file <path>`
- `--emit-zod` / `--no-emit-zod`
- `--emit-ingest` / `--no-emit-ingest`
- `--ingest-out-file <path>`
- `--bigint-mode <string|bigint>`
- `--include-views`

## CI / check integration

When configured, [`chkit check`](/cli/check/) includes a `plugins.codegen` block in JSON output and can fail with `plugin:codegen`.

`plugin:codegen` is added to `failedChecks` when the plugin check returns an error finding (for example stale or missing generated artifacts).

## Generate integration

When `runOnGenerate` is enabled (default), [`chkit generate`](/cli/generate/) runs codegen after successful migration/snapshot generation.

If codegen fails in that path, `chkit generate` fails.

## Current limits

- Query-level type inference is not included.
- Arbitrary SQL expression typing is not included.
- Views/materialized views are opt-in and emitted conservatively.
