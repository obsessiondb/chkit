---
title: Getting Started with ObsessionDB
description: Sign up, install the plugin, authenticate, and route chkit commands at your first ObsessionDB service.
sidebar:
  order: 2
---

Five steps from nothing to a working ObsessionDB target: sign up, install the plugin, authenticate, select a service, and run your first query.

## 1. Sign up for a free instance

Create an account and spin up a service at [console.obsessiondb.com](https://console.obsessiondb.com). The free tier is enough to follow this guide end-to-end. Once your service is provisioned, note its name — you'll select it from a list in step 4, so you don't need to copy any URLs or tokens by hand.

## 2. Install the plugin

```sh
bun add -d @chkit/plugin-obsessiondb
```

Register it in your `clickhouse.config.ts`:

```ts
import { defineConfig } from '@chkit/core'
import { obsessiondb } from '@chkit/plugin-obsessiondb'

export default defineConfig({
  schema: './src/db/schema/**/*.ts',
  outDir: './chkit',
  plugins: [obsessiondb()],
})
```

You don't need a `clickhouse` block at this point — once a service is selected, the plugin routes SQL through the ObsessionDB API.

## 3. Authenticate

```sh
chkit obsessiondb login
```

This opens an interactive browser flow against the ObsessionDB API. Credentials are stored locally so subsequent commands don't re-prompt.

Verify the login:

```sh
chkit obsessiondb whoami
```

If you're on a non-default ObsessionDB region, pass `--api-url` to `login` to point at the correct endpoint. See [Services](/obsessiondb/services/) for credential storage details and how to switch regions.

## 4. Select a service

List services across the organizations you belong to:

```sh
chkit obsessiondb service list
```

Then pick one interactively:

```sh
chkit obsessiondb service select
```

The selection is written to `.chkit/obsessiondb.json` next to your config file and becomes the default target for every `chkit` command after that.

## 5. Run your first command

Confirm the routing works:

```sh
chkit query "SELECT 1"
```

The query goes through the ObsessionDB API to your selected service. If it returns a row, you're done — your schema commands (`generate`, `migrate`, `status`, `drift`, `check`) will use the same target from here on.

## Next

- [Engine Rewriting](/obsessiondb/engine-rewriting/) — what the plugin does to `Shared*` engines when you also target regular ClickHouse.
- [Services](/obsessiondb/services/) — managing multiple services, per-command overrides, and aliases.
