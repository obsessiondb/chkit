---
title: "Configuration Overview"
description: "clickhouse.config.ts structure and defaults."
---

`chkit` is configured through `clickhouse.config.ts`.

## Core Fields

- `schema`: glob path to [schema files](/schema/dsl-reference/)
- `outDir`: root folder for generated artifacts
- `migrationsDir`: SQL migration file folder
- `metaDir`: state folder (`snapshot.json`)
- `plugins`: plugin registrations
- `clickhouse`: live connection options
- `check`: CI gate behavior
- `safety`: destructive migration safety behavior

Migration state (the journal of applied migrations) is not stored in `metaDir`. It lives in the `_chkit_migrations` table in your configured `clickhouse.database`, so `status`, `migrate`, and `check` require a ClickHouse connection.

## Example

```ts
import { defineConfig } from '@chkit/core'

export default defineConfig({
  schema: './src/db/schema/**/*.ts',
  outDir: './chkit',
  migrationsDir: './chkit/migrations',
  metaDir: './chkit/meta',
  clickhouse: {
    url: process.env.CLICKHOUSE_URL ?? 'http://localhost:8123',
    username: process.env.CLICKHOUSE_USER ?? 'default',
    password: process.env.CLICKHOUSE_PASSWORD ?? '',
    database: process.env.CLICKHOUSE_DB ?? 'default',
  },
})
```

## User profile config fallback

Project-scoped commands (`generate`, `migrate`, `status`, `drift`, `check`, `codegen`, `pull`) always require a project config in the working directory.

[`chkit query`](/cli/query/) is the exception: when no project config is found, chkit falls back to a user-profile config at `~/.config/chkit/config.ts` (honoring `XDG_CONFIG_HOME`). This lets ad-hoc queries run from any directory. If ObsessionDB credentials are present (`~/.config/chkit/credentials.json`), chkit synthesizes a minimal query-only config automatically, so `chkit query` works after `chkit obsessiondb login` without a local config file at all.
