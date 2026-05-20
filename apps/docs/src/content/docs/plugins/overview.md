---
title: Plugins Overview
description: How chkit plugins work and which official plugins are available.
---

Plugins extend chkit with capabilities that don't belong in the core CLI — code generation, schema introspection, data backfill, ObsessionDB integration, and anything else you want to bolt on. They're regular npm packages that you register in `clickhouse.config.ts`:

```ts
import { defineConfig } from '@chkit/core'
import { codegen } from '@chkit/plugin-codegen'
import { pull } from '@chkit/plugin-pull'

export default defineConfig({
  schema: './src/db/schema/**/*.ts',
  outDir: './chkit',
  plugins: [
    codegen({ outFile: './src/generated/chkit-types.ts' }),
    pull({ outFile: './src/db/schema/pulled.ts' }),
  ],
  // ...
})
```

## How plugins hook in

Plugins implement a small set of lifecycle hooks — for example, transforming schema definitions before diff, registering new CLI commands, or running code after a migration applies. The [CLI: `chkit plugin`](/cli/plugin/) command lists plugins active in your config.

You can author your own plugins; the existing official plugins are the reference. See [Contributing](https://github.com/obsessiondb/chkit/blob/main/CONTRIBUTING.md#plugins) for the entry point.

## Official plugins

- [`@chkit/plugin-codegen`](/plugins/codegen/) — TypeScript row types and optional Zod schemas, generated from your schema files.
- [`@chkit/plugin-pull`](/plugins/pull/) — introspect a live ClickHouse database into local schema files. Useful for adopting chkit on an existing database.
- [`@chkit/plugin-backfill`](/plugins/backfill/) — time-windowed data backfill with checkpoints, for materialized views and historical data loads.
- [`@chkit/plugin-obsessiondb`](/plugins/obsessiondb/) — run a single set of schema files against both [ObsessionDB](https://obsessiondb.com) (with `Shared` engines) and regular ClickHouse. Recommended if you deploy to ObsessionDB.
