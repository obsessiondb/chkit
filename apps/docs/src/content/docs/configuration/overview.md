---
title: "Configuration Overview"
description: "clickhouse.config.ts structure and defaults."
---

`chx` is configured through `clickhouse.config.ts`.

## Core Fields

- `schema`: glob path to schema files
- `outDir`: root folder for generated artifacts
- `migrationsDir`: SQL migration file folder
- `metaDir`: state folder (`snapshot.json`, `journal.json`)
- `plugins`: plugin registrations
- `clickhouse`: live connection options
- `check`: CI gate behavior
- `safety`: destructive migration safety behavior

## Example

```ts
import { defineConfig } from '@chx/core'

export default defineConfig({
  schema: './src/db/schema/**/*.ts',
  outDir: './chx',
  migrationsDir: './chx/migrations',
  metaDir: './chx/meta',
  clickhouse: {
    url: process.env.CLICKHOUSE_URL ?? 'http://localhost:8123',
    username: process.env.CLICKHOUSE_USER ?? 'default',
    password: process.env.CLICKHOUSE_PASSWORD ?? '',
    database: process.env.CLICKHOUSE_DB ?? 'default',
  },
})
```
