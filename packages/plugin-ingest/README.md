# @chkit/plugin-ingest

Scheduled pull ingestion from application APIs into ClickHouse for [chkit](https://www.npmjs.com/package/chkit), with journaled checkpoints.

Rows are saved before the bookmark advances: a crash may cause rereading, never skipped rows.

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

Documentation: https://chkit.obsessiondb.com/plugins/ingest/
