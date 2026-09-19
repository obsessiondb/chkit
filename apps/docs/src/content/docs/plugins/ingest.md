---
title: Ingest Plugin
description: Scheduled pull ingestion from application APIs into ClickHouse with journaled checkpoints.
sidebar:
  order: 5
---

This document covers practical usage of the optional `ingest` plugin.

## What it does

- Runs finite, scheduled pulls from application APIs into chkit-managed tables.
- Keeps progress in an append-only ingestion journal inside the target database. Checkpoints are a projection of that journal.
- Saves rows before advancing the bookmark. A crash may cause rereading; it never causes unsaved rows to be skipped.
- Retries source requests with backoff, `Retry-After`, and failure classification.
- Selects streams by exact tags so any external scheduler (cron, CI, Kubernetes) can drive it.

The plugin never creates or changes destination tables. Your chkit schema stays the only DDL authority.

## Plugin setup

Ingestion uses the singular `entry` config field instead of `schema` globs. The entry module is imported once: exported tables are collected as schema, and pipelines register themselves while it loads.

```ts
// clickhouse.config.ts
import { defineConfig } from '@chkit/core'
import { ingest } from '@chkit/plugin-ingest'

export default defineConfig({
  entry: './src/chkit.ts',
  plugins: [ingest()],
  clickhouse: { url: process.env.CLICKHOUSE_URL ?? '' },
})
```

## Writing a stream

A stream is a destination table plus a `read` generator. Fetching and mapping are ordinary code inside `read`; each yielded chunk carries rows already shaped for the table.

```ts
// src/chkit.ts
import { table } from '@chkit/core'
import { HttpError, definePipeline, defineStream, ingestionColumns, paginate, timestampWindow } from '@chkit/plugin-ingest'

export const tickets = table({
  database: 'crm',
  name: 'tickets',
  columns: [
    { name: 'id', type: 'String' },
    { name: 'updated_at', type: "DateTime64(3, 'UTC')" },
    { name: 'raw', type: 'String' },
    ...ingestionColumns,
  ],
  engine: 'ReplacingMergeTree(updated_at)',
  primaryKey: ['id'],
  orderBy: ['id'],
})

const ticketStream = defineStream({
  id: 'helpdesk.tickets',
  destination: tickets,
  tags: ['schedule:1h'],
  incremental: timestampWindow({
    // Re-read one hour of overlap; ReplacingMergeTree reconciles repeats.
    from: ({ watermark }) => (watermark ? new Date(watermark.getTime() - 3_600_000) : new Date(0)),
  }),
  async *read(context) {
    const pages = paginate({
      context,
      label: 'GET /tickets',
      fetchPage: async (cursor: string | undefined, signal) => {
        const url = new URL('https://api.example.com/tickets')
        url.searchParams.set('updated_since', context.selection.from.toISOString())
        if (cursor) url.searchParams.set('cursor', cursor)
        const response = await fetch(url, { signal, headers: { Authorization: `Bearer ${process.env.HELPDESK_TOKEN}` } })
        if (!response.ok) throw await HttpError.fromResponse(response)
        const body = await response.json()
        return { items: body.data, next: body.next_cursor ?? undefined }
      },
    })
    for await (const items of pages) {
      yield { rows: items.map((item) => ({ id: item.id, updated_at: item.updated_at, raw: JSON.stringify(item) })) }
    }
  },
})

definePipeline({ id: 'helpdesk', streams: [ticketStream], maxFetches: 4 })
```

Spread `ingestionColumns` into every destination table. The loader fills `_chkit_batch_id` and `_chkit_run_id`; `_chkit_ingested_at` is set by ClickHouse at the physical insert.

Batch identity decides whether a retry is deduplicated. By default it includes a content hash of the rows, which prefers a possible duplicate over suppressing rows that changed between attempts; a field like `synced_at: new Date()` therefore defeats retry deduplication. When a chunk covers a stable source interval, declare it with `id` (for example `yield { rows, id: \`page:${cursor}\` }`): the chunk then becomes its own write unit and its identity ignores row content.

## Progress and checkpoints

| Strategy | Use when | Bookmark advances |
|---|---|---|
| none (full sync) | The source is small or has no change filter | Never; every run reads everything |
| `timestampWindow({ from })` | The API filters by an updated-since timestamp | To the run cutoff, after the whole window loaded |
| `cursorState({ id, version, parse })` | The provider owns the state: compound cursor, change token, page position | Whenever a yielded chunk carries `state` and its rows have been saved |

With `cursorState`, `state` on a chunk must be the complete state that is safe to resume from once every row up to that chunk is saved. Omit it when you cannot make that claim; the run then restarts from the previous checkpoint after a failure.

A checkpoint records its strategy id and version. Changing either makes the next run fail rather than reinterpret old state.

## Commands

```sh
chkit ingest list                       # streams in the loaded graph
chkit ingest run                        # run every stream
chkit ingest run --tag schedule:1h      # exact tag match; repeat --tag for AND
chkit ingest run --tag stream:helpdesk.tickets
chkit ingest status                     # committed checkpoint per stream
chkit ingest run --backfill jan --from 2026-01-01 --to 2026-02-01
```

Every stream also carries the derived tags `pipeline:<id>` and `stream:<id>`. `schedule:<cadence>` is a convention only: chkit never interprets it. A `--tag` filter that matches nothing fails before any work runs.

A backfill uses its own checkpoint namespace, so it never moves the scheduled bookmark. Rerunning the same `--backfill` id resumes it.

`chkit check` verifies that every stream destination carries the ingestion metadata columns.

## Delivery guarantee

Ingestion is at-least-once. Each batch is inserted with a stable `insert_deduplication_token`, so a retry after a lost acknowledgement is suppressed while the table's deduplication window covers it. Pick a destination engine that reconciles repeats for your data, for example `ReplacingMergeTree` keyed by the provider id.

Run at most one ingestion process per project and target at a time. Use your scheduler's concurrency control (for example a GitHub Actions concurrency group) to enforce it.

## Options

| Option | Default | Description |
|---|---|---|
| `journalTable` | `_chkit_ingestion_journal` | Journal table name in the configured database |
| `maxDurationSeconds` | `3600` | Execution budget. Exhausting it ends the run as incomplete and keeps committed progress |
| `prefetchBatches` | `1` | Mapped batches buffered between fetching and loading |
