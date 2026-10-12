# chkit

**ClickHouse schema management in TypeScript.**

[![npm version](https://img.shields.io/npm/v/chkit?label=npm)](https://www.npmjs.com/package/chkit)
[![CI](https://github.com/obsessiondb/chkit/actions/workflows/ci.yml/badge.svg)](https://github.com/obsessiondb/chkit/actions/workflows/ci.yml)
[![Docs](https://img.shields.io/badge/docs-chkit.obsessiondb.com-blue)](https://chkit.obsessiondb.com)

Define ClickHouse schemas in code, generate reviewable SQL migrations, and detect live schema drift from the terminal or CI. chkit manages tables, views, materialized views and dictionaries alongside your application.

**Define → generate → review → migrate → check.**

[Getting started](https://chkit.obsessiondb.com/getting-started/) · [Adopt an existing database](https://chkit.obsessiondb.com/getting-started/add-to-existing-project/) · [Data-preserving migrations](https://chkit.obsessiondb.com/guides/data-preserving-migrations/) · [Documentation](https://chkit.obsessiondb.com)

## Quickstart

For a ready-made TypeScript project with two tables and an existing migration:

```sh
bun create chkit@latest my-app --example hello
# npm alternative:
npm create chkit@latest my-app -- --example hello
```

For an existing TypeScript project, install the CLI and schema DSL:

```sh
bun add -d chkit @chkit/core
# npm alternative (Node.js 22+):
npm install --save-dev chkit @chkit/core
```

Use matching versions of chkit and its plugins, and commit your package-manager lockfile. The examples below run from the project root; use `npx chkit` instead of `bunx chkit` with npm.

### 1. Configure the target

Supply your actual development database connection through `CLICKHOUSE_URL` (HTTP/HTTPS endpoint and port), `CLICKHOUSE_USER`, `CLICKHOUSE_PASSWORD`, and `CLICKHOUSE_DB`. An intentionally blank password is allowed; an absent password is missing information. Keep credentials out of Git.

If you don't have a connection yet, prepare definitions and generate offline after choosing the database namespace. Ask for missing values before any connected command; don't assume localhost, a default user, or a default database is the intended target.

Create `src/db/database.ts`:

```ts
export const database = process.env.CLICKHOUSE_DB
if (!database) throw new Error('Set CLICKHOUSE_DB to the database you intend to manage.')
```

Create `clickhouse.config.ts`:

```ts
import { defineConfig } from '@chkit/core'
import { database } from './src/db/database'

function required(name: string): string {
  const value = process.env[name]
  if (value === undefined || (name !== 'CLICKHOUSE_PASSWORD' && !value.trim())) {
    throw new Error(`Missing ${name}; configure the connection before running this command.`)
  }
  return value
}

export default defineConfig(({ command }) => ({
  schema: './src/db/schema/**/*.ts',
  outDir: './chkit',
  // Preserve target metadata when supplied, including during generation.
  clickhouse: !process.env.CLICKHOUSE_URL && (command === 'generate' || command === 'snapshot') ? undefined : {
    url: required('CLICKHOUSE_URL'),
    username: required('CLICKHOUSE_USER'),
    password: required('CLICKHOUSE_PASSWORD'),
    database,
  },
}))
```

Export these variables in your shell or CI. Bun also loads a root `.env`; for npm/Node, explicitly load it:

```sh
# Add .env to .gitignore first. Run from the project root with Node.js 22+:
node --env-file=.env ./node_modules/chkit/dist/bin/chkit.js status
# Use the same prefix for generate, migrate, check and other commands.
```

### 2. Define a table

Create `src/db/schema/events.ts`:

```ts
import { schema, table } from '@chkit/core'
import { database } from '../database'

export default schema(table({
  database,
  name: 'events',
  engine: 'MergeTree',
  columns: [
    { name: 'id', type: 'UInt64' },
    { name: 'source', type: 'String' },
    { name: 'occurred_at', type: 'DateTime64(3)' },
  ],
  primaryKey: ['id'],
  orderBy: ['id'],
  partitionBy: 'toYYYYMM(occurred_at)',
}))
```

### 3. Generate, review and apply

```sh
bunx chkit generate --name create-events
# Read chkit/migrations/*.sql before proceeding.
bunx chkit migrate --json
bunx chkit migrate --apply
bunx chkit status --json
bunx chkit check --strict --json
```

The initial migration can include `CREATE DATABASE`. If the target already exists and your account manages only its contents, remove that provisioning statement from the **unapplied** migration before applying; retain the table statements. Never change SQL already recorded as applied.

`migrate --json` previews pending work without applying its migration statements, but a connected command may initialize the journal. Commit definitions, migration SQL and `chkit/meta/snapshot.json` together. `check --strict` exits nonzero for pending migrations, modified checksums or live drift. `drift --json` describes differences; use `check` as the CI failure gate.

For existing tables, start with the [adoption guide](https://chkit.obsessiondb.com/getting-started/add-to-existing-project/) instead of generating a replacement schema. For changes to sorting/partition keys or stored values, follow the [data-preserving migration recipe](https://chkit.obsessiondb.com/guides/data-preserving-migrations/) and review the data copy and recovery plan before applying.

## Documentation

| Goal | Start here |
| --- | --- |
| Build a first schema, insert/query data and evolve it | [First-schema tutorial](https://chkit.obsessiondb.com/tutorials/first-schema/) |
| Adopt populated tables and establish migration history | [Existing-database adoption](https://chkit.obsessiondb.com/getting-started/add-to-existing-project/) |
| Change layout and backfill without discarding data | [Data-preserving migrations](https://chkit.obsessiondb.com/guides/data-preserving-migrations/) |
| Define tables, views and dictionaries | [Schema DSL reference](https://chkit.obsessiondb.com/schema/dsl-reference/) |
| Deploy migrations and enforce checks in CI | [CI/CD integration](https://chkit.obsessiondb.com/guides/ci-cd/) |
| Generate TypeScript row types and Zod schemas | [Codegen](https://chkit.obsessiondb.com/plugins/codegen/) |
| Replay historical data through materialized views | [Backfill plugin (beta)](https://chkit.obsessiondb.com/plugins/backfill/) |
| Onboard with a coding agent | [Agent instructions](https://chkit.obsessiondb.com/ai-agents/) |

## Packages

| Package | Description |
| --- | --- |
| [`chkit`](packages/cli) | Schema and migration CLI |
| [`@chkit/core`](packages/core) | TypeScript schema DSL, configuration and diff engine |
| [`@chkit/plugin-pull`](packages/plugin-pull) | Import live schema definitions |
| [`@chkit/plugin-codegen`](packages/plugin-codegen) | Generate TypeScript types and Zod schemas |
| [`@chkit/plugin-backfill`](packages/plugin-backfill) | Checkpointed partition/sort-key backfills (beta) |
| [`@chkit/plugin-obsessiondb`](packages/plugin-obsessiondb) | ObsessionDB connection and remote execution |

Python support is in alpha through [`chkit-py`](https://pypi.org/project/chkit-py/). See the [Python documentation](https://chkit.obsessiondb.com/python/overview/) for its setup and limitations.

## ObsessionDB and chkit Sync

The [ObsessionDB](https://obsessiondb.com) team builds chkit. Use schema management with self-hosted ClickHouse, ClickHouse Cloud or ObsessionDB. We're also building **chkit Sync**, a separate beta workflow for syncing business applications into ClickHouse; see the [Sync documentation](https://chkit.obsessiondb.com/sync/).

## Community and contributing

Follow [@ObsessionDB](https://x.com/ObsessionDB), report bugs through [GitHub Issues](https://github.com/obsessiondb/chkit/issues), and see [CONTRIBUTING.md](CONTRIBUTING.md) for development setup.

[MIT license](LICENSE).
