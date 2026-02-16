---
title: Typegen Plugin
description: Generate TypeScript row types and optional Zod schemas from chkit schema definitions.
---

This document covers practical usage of the optional `typegen` plugin.

## What it does

- Generates deterministic TypeScript row types from chkit schema definitions.
- Optionally generates Zod schemas from the same definitions.

## How it fits your workflow

The plugin is designed so your existing chkit workflow can stay the same.

- `chkit generate` integration:
  - After a successful migration/snapshot generate, typegen runs automatically by default (`runOnGenerate: true`).
  - Result: migration artifacts and generated types stay in sync in normal dev flow.
- `chkit check` integration:
  - `check` evaluates typegen freshness via plugin hook.
  - If generated types are missing/stale, `failedChecks` includes `plugin:typegen`.
  - Result: CI enforcement works without adding a separate typegen step.
- `chkit typegen` command:
  - Optional manual trigger.
  - Useful when you explicitly want to regenerate or run an isolated `--check`.

## Plugin setup

In `clickhouse.config.ts`, register `typegen(...)` from `@chkit/plugin-typegen`.

Recommended typed setup:

```ts
import { defineConfig } from '@chkit/core'
import { typegen } from '@chkit/plugin-typegen'

export default defineConfig({
  schema: './src/db/schema/**/*.ts',
  plugins: [
    typegen({
      outFile: './src/generated/chkit-types.ts',
      emitZod: false,
      tableNameStyle: 'pascal',
      bigintMode: 'string',
      includeViews: false,
      runOnGenerate: true,
      failOnUnsupportedType: true,
    }),
  ],
})
```

Legacy path-based registration via `{ resolve: './plugins/typegen.ts', options: {...} }` remains supported.

## Options

- `outFile` (default: `./src/generated/chkit-types.ts`)
- `emitZod` (default: `false`)
- `tableNameStyle` (default: `pascal`) values: `pascal | camel | raw`
- `bigintMode` (default: `string`) values: `string | bigint`
- `includeViews` (default: `false`)
- `runOnGenerate` (default: `true`)
- `failOnUnsupportedType` (default: `true`)

Invalid option values fail fast at startup via plugin config validation.

## Commands

- `chkit typegen`
  - Optional manual command to generate and write output atomically.
- `chkit typegen --check`
  - Optional manual check to validate output is current without writing.
  - Fails with:
    - `typegen_missing_output` (file missing)
    - `typegen_stale_output` (content drift)

Useful flags:

- `--out-file <path>`
- `--emit-zod` / `--no-emit-zod`
- `--bigint-mode <string|bigint>`
- `--include-views`

## CI / check integration

When configured, `chkit check` includes a `plugins.typegen` block in JSON output and can fail with `plugin:typegen`.

`plugin:typegen` is added to `failedChecks` when the plugin check returns an error finding (for example stale or missing generated artifacts).

## Generate integration

When `runOnGenerate` is enabled (default), `chkit generate` runs typegen after successful migration/snapshot generation.

If typegen fails in that path, `chkit generate` fails.

## Current limits

- Query-level type inference is not included.
- Arbitrary SQL expression typing is not included.
- Views/materialized views are opt-in and emitted conservatively.
