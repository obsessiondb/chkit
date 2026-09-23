# @chkit/plugin-ingest

Write TypeScript readers to load application API data into ClickHouse with [chkit](https://www.npmjs.com/package/chkit). Use an external scheduler for repeated runs.

The executor records progress after writes succeed. A retry can reread rows from the last committed checkpoint.

```ts
import { defineConfig } from '@chkit/core'
import { ingest } from '@chkit/plugin-ingest'

export default defineConfig({
  entry: './src/chkit.ts',
  plugins: [ingest()],
  clickhouse: { url: process.env.CLICKHOUSE_URL ?? '' },
})
```

```sh
chkit ingest run --tag schedule:1h
```

Documentation: https://chkit.obsessiondb.com/ingestion/

For raw storage, typed rows, and where to map fields, see [Destinations and transformations](https://chkit.obsessiondb.com/ingestion/destinations/).

Install the source-authoring skill for a coding agent:

```sh
npx skills add obsessiondb/chkit --skill chkit-ingestion
```
