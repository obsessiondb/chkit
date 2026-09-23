---
title: Ingestion quickstart
description: Read a public API into a raw ClickHouse table and query it through a SQL view.
---

Ingest the small [JSONPlaceholder posts dataset](https://jsonplaceholder.typicode.com/guide/) into ClickHouse, then query typed fields through a view.

## Prerequisites

Use a TypeScript project, Bun, a direct ClickHouse connection, and a chkit release that includes `@chkit/plugin-ingest`. This example uses native JSON; use ClickHouse 25.3+ for production support of that type. See [compatibility](/guides/clickhouse-compatibility/).

JSONPlaceholder is a public demonstration API with a small dataset, so use a full sync. For larger sources, add [pagination](/ingestion/readers/) and [incremental reads](/ingestion/incremental-syncs/) based on the provider API.

## Install and configure

Install the `beta` release. Keep the CLI, core, and plugin versions aligned:

```sh
bun add -d chkit@beta @chkit/core@beta @chkit/plugin-ingest@beta
```

Create `clickhouse.config.ts`:

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

Set the connection environment variables for the intended development database before running commands.

## Define the source

Create `src/chkit.ts`:

```ts
import { view } from '@chkit/core'
import { definePipeline, defineStream, HttpError, rawRows, rawTable } from '@chkit/plugin-ingest'

type Post = { id: number; userId: number; title: string; body: string }

export const postsRaw = rawTable({ database: 'default', name: 'posts_raw' })

export const posts = view({
  database: 'default',
  name: 'posts',
  as: `SELECT id, raw.title::String AS title, raw.userId::UInt64 AS user_id
       FROM default.posts_raw FINAL`,
})

const postStream = defineStream({
  id: 'jsonplaceholder.posts',
  destination: postsRaw,
  async *read(context) {
    const items = await context.attempt(async (signal) => {
      const response = await fetch('https://jsonplaceholder.typicode.com/posts', { signal })
      if (!response.ok) throw await HttpError.fromResponse(response)
      return await response.json() as Post[]
    }, { label: 'GET /posts' })
    yield { rows: rawRows(items, (post) => String(post.id)) }
  },
})

export const demo = definePipeline({ id: 'demo', streams: [postStream] })
```

`rawTable` supplies the ingestion metadata columns and a `ReplacingMergeTree` keyed by `id`. No `incremental` option means full sync; no `loader` option selects `simpleLoader`. The view uses `FINAL` to reconcile repeated object versions at query time.

## Create tables and run

```sh
bunx chkit ingest list
bunx chkit check --offline
bunx chkit generate --name add-posts-ingestion
bunx chkit migrate
```

Review the generated migration, then apply it to the intended development database:

```sh
bunx chkit migrate --apply
bunx chkit ingest run --tag stream:jsonplaceholder.posts
bunx chkit query "SELECT count() FROM default.posts"
bunx chkit query "SELECT id, title FROM default.posts LIMIT 5"
```

The demonstration dataset contains 100 posts. Run ingestion again and query the view: it should still return 100 logical posts. Physical rows can contain multiple versions until ClickHouse merges them. A full sync has no incremental bookmark, so `ingest status` can show no checkpoint after a successful run.

## Existing projects

Keep the current connection and plugin registrations; add `ingest()` to them. When switching from `schema` globs to `entry`, remove `schema` and re-export **all existing schema definitions** from the entry module alongside the new tables and pipelines. This preserves the schema input to migration generation.

Only exported pipelines are active. Importing a source module for side effects does not activate it, and a table referenced by a stream must still be exported to participate in schema migrations. Inspect the generated SQL for unintended removals before applying it.

Keep a small first source in one entry file. As sources grow, move each provider's client, schema, and streams into modules and re-export them from that same entry. Group streams into a pipeline when they share retry defaults, tags, or concurrency limits; use separate stream IDs for independently resumable resources. Pipelines do not sequence dependencies.

## Related pages

- [Destinations and transformations](/ingestion/destinations/): choose the stored shape and where to map fields.
- [Readers and pagination](/ingestion/readers/): fetch bounded pages with retries.
- [Incremental syncs](/ingestion/incremental-syncs/): avoid rereading the whole source.
