# @chkit/plugin-ingest

Write TypeScript readers to load application API data into ClickHouse with [chkit](https://www.npmjs.com/package/chkit). Use an external scheduler for repeated runs.

The executor records progress after writes succeed. Run-scoped journal identities keep overlapping executions independent. A retry resumes from a validated checkpoint and may reread rows.

`paginate()` yields complete `{ items, next, metadata? }` pages, including empty terminal pages. Read rows from `page.items`; use `next` for request continuation and explicitly map checkpoint metadata into a chunk's `state` with `cursorState`. The executor commits that state after the rows are saved. This replaces the previous item-array return type; existing readers must use `page.items`.

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

The append-only ClickHouse journal records each run's starting checkpoint and local event sequence. Two processes may start from the same checkpoint without reusing event identities. Complete snapshot validation excludes malformed run tails while retaining acknowledged progress. A stale but valid read can cause replay; destination writes remain at-least-once.

Diagnose the journal or preview evidence-preserving recovery:

```sh
chkit ingest doctor --tag stream:helpdesk.tickets
chkit ingest repair --tag stream:helpdesk.tickets
```

Overlapping valid runs need no repair. For damaged evidence, stop all ingestion writers and review the plan. `chkit ingest repair --tag stream:helpdesk.tickets --apply <fingerprint>` materializes a verified archive and replacement journal while preserving the original. Keep writers stopped, set `ingest({ journalTable: '<replacementTable>' })` to the returned table, then restart them. The command leaves activation to this explicit configuration change. Other streams' evidence is copied unchanged.

Documentation: https://chkit.obsessiondb.com/api-sync/

For raw storage, typed rows, and where to map fields, see [Destinations and transformations](https://chkit.obsessiondb.com/api-sync/destinations/).

Install the source-authoring skill for a coding agent:

```sh
npx skills add obsessiondb/chkit --skill chkit-ingestion
```
