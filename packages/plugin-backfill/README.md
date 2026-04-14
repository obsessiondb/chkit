# @chkit/plugin-backfill

Plugin for data backfill operations in chkit.

Part of the [chkit](https://github.com/obsessiondb/chkit) monorepo. This plugin extends the [`chkit`](https://www.npmjs.com/package/chkit) CLI with data backfill commands.

## Install

```bash
bun add -d @chkit/plugin-backfill
```

## Usage

Register the plugin in your config:

```ts
// clickhouse.config.ts
import { defineConfig } from '@chkit/core'
import { backfill } from '@chkit/plugin-backfill'

export default defineConfig({
  schema: './src/db/schema/**/*.ts',
  outDir: './chkit',
  plugins: [
    backfill(),
  ],
  clickhouse: {
    url: process.env.CLICKHOUSE_URL ?? 'http://localhost:8123',
  },
})
```

## Documentation

See the [chkit documentation](https://chkit.obsessiondb.com).

## SDK

The package root is limited to the plugin registration API. Everything used by the CLI itself — the chunk planner, SQL builders, async executor, logging — is also exported from the `@chkit/plugin-backfill/sdk` subpath so you can build your own backfill scripts without going through the CLI.

```ts
import {
  generateChunkPlan,
  buildChunkExecutionSql,
  executeBackfill,
  getBackfillLogger,
  type ChunkPlan,
  type PlannerQuery,
} from '@chkit/plugin-backfill/sdk'
```

The pipeline has three stages, and you can use any subset:

1. **Plan** — `generateChunkPlan(...)` introspects a table and returns a `ChunkPlan` describing how to partition the work into roughly equal-sized chunks.
2. **Build SQL** — `buildChunkExecutionSql(...)` turns a single `Chunk` into an `INSERT … SELECT` statement.
3. **Execute** — `executeBackfill(...)` submits chunks against a real `ClickHouseExecutor` with deterministic query IDs, polling, and resume support.

### Plan a backfill

`generateChunkPlan` is decoupled from any ClickHouse client. You pass in a `query` function with the `PlannerQuery` shape and the planner uses it for every introspection / probe / split query. This makes the planner trivial to instrument or run against alternative clients.

```ts
import { createClient } from '@clickhouse/client'
import { generateChunkPlan, type PlannerQuery } from '@chkit/plugin-backfill/sdk'

const client = createClient({ url: process.env.CLICKHOUSE_URL })

const query: PlannerQuery = async (sql, settings) => {
  const result = await client.query({
    query: sql,
    format: 'JSONEachRow',
    clickhouse_settings: settings as Record<string, string | number | boolean>,
  })
  return result.json()
}

const plan = await generateChunkPlan({
  database: 'analytics',
  table: 'events',
  from: '2025-01-01T00:00:00Z',
  to: '2025-02-01T00:00:00Z',
  targetChunkBytes: 1_000_000_000, // ~1 GiB per chunk
  query,
  // 'count' is exact but slower; 'explain-estimate' is faster but approximate
  rowProbeStrategy: 'count',
})

console.log(`${plan.chunks.length} chunks, ${plan.totalRows.toLocaleString()} rows`)
```

### Execute chunks against a target

`buildChunkExecutionSql` produces the per-chunk `INSERT … SELECT` and `executeBackfill` runs them with concurrency, polling, and progress callbacks. Persist the `progress` argument anywhere you like to support resume.

```ts
import { createClickHouseExecutor } from '@chkit/clickhouse'
import {
  buildChunkExecutionSql,
  executeBackfill,
  type BackfillProgress,
} from '@chkit/plugin-backfill/sdk'

const executor = createClickHouseExecutor({
  url: process.env.CLICKHOUSE_URL!,
  username: 'default',
  password: process.env.CLICKHOUSE_PASSWORD!,
  database: 'analytics',
})

const chunksById = new Map(plan.chunks.map((chunk) => [chunk.id, chunk]))
let saved: BackfillProgress | undefined // load from disk for resume

const result = await executeBackfill({
  executor,
  planId: plan.planId,
  chunks: plan.chunks,
  buildQuery: ({ id }) =>
    buildChunkExecutionSql({
      planId: plan.planId,
      chunk: chunksById.get(id)!,
      target: 'analytics.events_backfill',
      table: plan.table,
    }),
  concurrency: 4,
  pollIntervalMs: 5_000,
  resumeFrom: saved,
  onProgress: async (progress) => {
    saved = progress
    // persist to disk / state store
  },
})

console.log(`done=${result.completed} failed=${result.failed}`)
```

### Plan persistence

Plans contain string boundaries that may include non-UTF-8 bytes (the planner uses `latin1`-encoded byte ranges for string sort keys), so JSON-serializing a `ChunkPlan` directly will lose information. Use the codec helpers when you need to round-trip a plan through storage:

```ts
import {
  encodeChunkPlanForPersistence,
  decodeChunkPlanFromPersistence,
} from '@chkit/plugin-backfill/sdk'

const json = JSON.stringify(encodeChunkPlanForPersistence(plan))
// later …
const plan2 = decodeChunkPlanFromPersistence(JSON.parse(json))
```

### Logging

The planner emits structured logs via [`@logtape/logtape`](https://logtape.org/) under the `['chkit', 'backfill']` category. Configure a sink at process start to see them — slow-query warnings (>5 s) are emitted at `warning` level, planning progress at `info`, and per-strategy decisions at `debug`.

```ts
import { configureSync, getConsoleSink, getTextFormatter } from '@chkit/plugin-backfill/sdk'

configureSync({
  sinks: { console: getConsoleSink({ formatter: getTextFormatter({ timestamp: 'time' }) }) },
  loggers: [{ category: 'chkit', sinks: ['console'], lowestLevel: 'info' }],
  reset: true,
})
```

To capture every SQL statement the planner runs (with timing, server-side stats, and per-strategy classification), wrap your `query` function instead of relying solely on logging — see [`playground/bench-real-planner.ts`](../../playground/bench-real-planner.ts) for a full example that writes a JSONL trace.

### More patterns

The [`playground/`](../../playground) directory contains runnable scripts that exercise the SDK against a real ClickHouse instance and were used while designing the planner. Useful starting points:

- `bench-real-planner.ts` — instrument every planner query with classification, timing, and a JSONL trace
- `bench-first-pass-strategy.ts` / `bench-string-prefix.ts` / `bench-temporal-bucket.ts` — micro-benchmarks for individual split strategies
- `bench-explain-estimate.ts` — compare `count` vs `explain-estimate` row probe strategies
- `slice22-drill.ts` — drill into a single problem partition to understand why the planner produced the chunks it did
- `00-discover.ts` — pure introspection without producing a plan

## License

[MIT](../../LICENSE)
