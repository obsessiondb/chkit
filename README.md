# chkit

**Manage ClickHouse schemas and sync API data.**

[![npm version](https://img.shields.io/npm/v/chkit?label=npm)](https://www.npmjs.com/package/chkit)
[![CI](https://github.com/obsessiondb/chkit/actions/workflows/ci.yml/badge.svg)](https://github.com/obsessiondb/chkit/actions/workflows/ci.yml)
[![Docs](https://img.shields.io/badge/docs-chkit.obsessiondb.com-blue)](https://chkit.obsessiondb.com)

chkit is an open-source CLI for ClickHouse. Review migration SQL before applying it. Keep table definitions and API readers in your repository, alongside the code that uses them. Run the CLI from the terminal or CI.

**TypeScript:** schemas, migrations, and API sync. **Python:** schemas and migrations through [chkit-py](https://chkit.obsessiondb.com/python/overview/).

[Get started](https://chkit.obsessiondb.com/getting-started/) · [Build a data source](https://chkit.obsessiondb.com/api-sync/quickstart/) · [Documentation](https://chkit.obsessiondb.com)

> **Beta:** the public API is still evolving. Keep the CLI, core, and plugins on matching versions.

## Why chkit

- **Define tables and views.** Keep ClickHouse tables, views, materialized views, and dictionaries in code. Import the schema from an existing database.
- **Migrate and backfill data.** Handle complex schema changes and backfill data across materialized views. Track progress and resume interrupted runs.
- **Sync data from any source.** Build reliable syncs from HTTP APIs, databases, and other sources into ClickHouse.
- **Store raw or mapped records.** Retain raw objects for SQL transformations, or map records into established entity tables before loading.
- **Check schema drift in CI.** Detect pending migrations, checksum mismatches, and live schema differences with `chkit check`.
- **Generate types and backfill data.** Plugins generate TypeScript types and Zod schemas or run SQL backfills. Agent skills guide schema and source authoring.

## From a schema to a working sync

Start with a table, load 100 demo API records, then query posts per author. Change the view later using the data already stored in ClickHouse. This walkthrough uses TypeScript and the ingestion plugin. For a project using only `chkit` and `@chkit/core`, follow the [schema tutorial](https://chkit.obsessiondb.com/tutorials/first-schema/).

```sh
bun add -d chkit@beta @chkit/core@beta @chkit/plugin-ingest@beta
```

<details>
<summary>Project configuration</summary>

Create `clickhouse.config.ts` and set the connection environment variables for the intended development database. Export the definitions below from `src/chkit.ts`.

```ts
import { defineConfig } from '@chkit/core'
import { ingest } from '@chkit/plugin-ingest'

export default defineConfig({
  entry: './src/chkit.ts',
  plugins: [ingest()],
  clickhouse: {
    url: process.env.CLICKHOUSE_URL ?? 'http://localhost:8123',
    username: process.env.CLICKHOUSE_USER ?? 'default',
    password: process.env.CLICKHOUSE_PASSWORD ?? '',
    database: 'default',
  },
})
```

The [configuration guide](https://chkit.obsessiondb.com/configuration/overview/) covers existing projects and additional plugins.

</details>

### 1. Define a table

Create `src/chkit.ts`. Explicit columns describe the query shape; `ingestionColumns` adds the metadata used by the reader in step 3.

```ts
import { table } from '@chkit/core'
import { ingestionColumns } from '@chkit/plugin-ingest'

export const posts = table({
  database: 'default', name: 'posts',
  columns: [
    { name: 'id', type: 'String' },
    { name: 'title', type: 'String' },
    { name: 'user_id', type: 'UInt64' },
    ...ingestionColumns,
  ],
  engine: 'ReplacingMergeTree(_chkit_ingested_at)',
  primaryKey: ['id'], orderBy: ['id'],
})
```

### 2. Review and apply a migration

```sh
bunx chkit generate --name create-posts
bunx chkit migrate

# After reviewing the generated SQL and preview:
bunx chkit migrate --apply
```

### 3. Add a source reader

Add this to `src/chkit.ts`. The public demonstration API returns a bounded dataset, so this reader performs a full sync and maps each record into the table.

```ts
import { definePipeline, defineStream, HttpError } from '@chkit/plugin-ingest'

type Post = { id: number; title: string; userId: number }

const postStream = defineStream({
  id: 'demo.posts', destination: posts,
  async *read(context) {
    const page = await context.attempt(async (signal) => {
      const response = await fetch('https://jsonplaceholder.typicode.com/posts', { signal })
      if (!response.ok) throw await HttpError.fromResponse(response)
      return await response.json() as Post[]
    })
    yield { rows: page.map((post) => ({
      id: String(post.id), title: post.title, user_id: post.userId,
    })) }
  },
})

export const content = definePipeline({ id: 'content', streams: [postStream] })
```

```sh
bunx chkit ingest run --tag pipeline:content
```

The default loader writes the rows. For production sources, add [pagination](https://chkit.obsessiondb.com/api-sync/readers/) and [incremental reads](https://chkit.obsessiondb.com/api-sync/incremental-syncs/) when the provider supports them.

### 4. Query through a view

Add this view to the same entry. `FINAL` reconciles repeated object versions before aggregation.

```ts
import { view } from '@chkit/core'

export const postsByAuthor = view({
  database: 'default', name: 'posts_by_author',
  as: `SELECT user_id, count() AS posts
       FROM default.posts FINAL
       GROUP BY user_id`,
})
```

```sh
bunx chkit generate --name posts-by-author
bunx chkit migrate
bunx chkit migrate --apply
bunx chkit query "SELECT * FROM default.posts_by_author ORDER BY user_id LIMIT 3"
```

Expected result for the demo dataset:

| user_id | posts |
| --- | --- |
| 1 | 10 |
| 2 | 10 |
| 3 | 10 |

If the final shape may change, [retain raw records and transform in ClickHouse](https://chkit.obsessiondb.com/api-sync/destinations/) instead of mapping every field up front.

### 5. Evolve the model

Replace the previous view definition to add a measure:

```ts
import { view } from '@chkit/core'

export const postsByAuthor = view({
  database: 'default', name: 'posts_by_author',
  as: `SELECT user_id, count() AS posts,
         countIf(positionCaseInsensitive(title, 'qui') > 0) AS matching_posts
       FROM default.posts FINAL
       GROUP BY user_id`,
})
```

Generate, preview, and apply another migration. chkit recreates the ordinary view with the new SQL. The `matching_posts` measure uses already-stored rows: no API re-fetch or table backfill for this change.

### 6. Verify and repeat

```sh
bunx chkit check
bunx chkit ingest list
bunx chkit ingest run --tag pipeline:content
```

Use `check` in CI for migration state and schema drift. Schedule ingestion through cron, CI, or another job runner, with one ingestion process per target. Incremental sources resume from committed state; this full-sync demo reads the dataset again. See [scheduling and recovery](https://chkit.obsessiondb.com/api-sync/operations/).

## Set up chkit for your project

| Goal | Start here |
|---|---|
| Manage a new schema | [Getting started](https://chkit.obsessiondb.com/getting-started/) |
| Adopt an existing database | [Pull a live schema](https://chkit.obsessiondb.com/plugins/pull/) |
| Implement an API source | [API sync quickstart](https://chkit.obsessiondb.com/api-sync/quickstart/) |
| Generate application types | [TypeScript codegen](https://chkit.obsessiondb.com/plugins/codegen/) |
| Recompute stored data | [SQL backfills](https://chkit.obsessiondb.com/plugins/backfill/) |
| Work with a coding agent | [Agent skills](https://chkit.obsessiondb.com/ai-agents/) |

See the [CLI reference](https://chkit.obsessiondb.com/cli/overview/) for commands, flags, and JSON output.

## Packages

| Package | Description |
|---------|-------------|
| [`chkit`](packages/cli) | CLI binary and command implementations |
| [`@chkit/core`](packages/core) | Schema DSL, config, and diff engine |
| [`@chkit/clickhouse`](packages/clickhouse) | ClickHouse client wrapper |
| [`@chkit/codegen`](packages/codegen) | TypeScript type generation engine |
| [`@chkit/plugin-pull`](packages/plugin-pull) | Pull live schema into local files |
| [`@chkit/plugin-codegen`](packages/plugin-codegen) | Codegen plugin for the CLI |
| [`@chkit/plugin-backfill`](packages/plugin-backfill) | Backfill plugin for data migrations |
| [`@chkit/plugin-ingest`](packages/plugin-ingest) | API source readers, batching, retries, and journaled checkpoints |
| [`@chkit/plugin-obsessiondb`](packages/plugin-obsessiondb) | ObsessionDB integration: auto-rewrite `Shared` engines for ClickHouse targets |

## Python

Install [`chkit-py`](https://pypi.org/project/chkit-py/) (`pip install chkit-py`) to define schemas and run migrations, drift detection, and CI checks with Python config and schema files. API sync requires TypeScript. The Python source is in [`chkit_python/`](chkit_python).

## Documentation

Read the documentation at **[chkit.obsessiondb.com](https://chkit.obsessiondb.com)**.

## ObsessionDB

The [**ObsessionDB**](https://obsessiondb.com) team builds chkit and provides a managed ClickHouse service:

- **Engine configuration.** Use the [`@chkit/plugin-obsessiondb`](packages/plugin-obsessiondb) plugin to select `SharedReplacingMergeTree` / `SharedMergeTree` for managed replication while keeping the same TypeScript schema for your development database.
- **Managed infrastructure.** ObsessionDB manages Keeper, replicas, and scaling.
- **Release tests.** The chkit release pipeline runs its E2E suite against ObsessionDB.

[Try ObsessionDB →](https://obsessiondb.com)

## Community

- [@ObsessionDB on X](https://x.com/ObsessionDB): release notes and updates
- [GitHub Issues](https://github.com/obsessiondb/chkit/issues): bugs and feature requests

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for development setup and guidelines.

## License

[MIT](LICENSE)
