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

Ingestion uses the singular `entry` config field instead of `schema` globs. The entry module is imported once: exported tables are collected as schema, and exported pipelines form the ingestion graph. Importing a pipeline without exporting it does not activate it; remove its export to deactivate it.

Configure a direct `clickhouse` connection for ingestion. A host-provided executor, including the ObsessionDB workbench executor, cannot currently guarantee JSON row encoding and per-insert deduplication settings.

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
    start: new Date(0),
    overlapMs: 3_600_000,
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

export const helpdesk = definePipeline({ id: 'helpdesk', streams: [ticketStream], maxFetches: 4 })
```

Spread `ingestionColumns` into every destination table. The loader fills `_chkit_batch_id` and `_chkit_run_id`; `_chkit_ingested_at` is set by ClickHouse at the physical insert.

Batch identity decides whether a retry is deduplicated. By default it includes a content hash of the rows, which prefers a possible duplicate over suppressing rows that changed between attempts; a field like `synced_at: new Date()` therefore defeats retry deduplication. When a chunk covers a stable source interval, declare it with `id` (for example `yield { rows, id: \`page:${cursor}\` }`): the chunk then becomes its own write unit and its identity ignores row content.

## Landing raw objects

Mapping fields in the reader is optional, and usually the wrong place for it. `rawTable` defines a landing table that stores each provider object untouched in a native `JSON` column next to a stable `id`; `rawRows` shapes a page for it. Typed tables are then ordinary chkit views (or materialized views) over the raw layer:

```ts
import { view } from '@chkit/core'
import { defineStream, rawRows, rawTable } from '@chkit/plugin-ingest'

export const rawTickets = rawTable({ database: 'crm', name: 'tickets_raw' })

export const tickets = view({
  database: 'crm',
  name: 'tickets',
  as: `SELECT
  id AS ticket_id,
  raw.subject::String AS subject,
  raw.requester.email::String AS requester_email,
  arrayMap(t -> t.name::String, raw.tags[]) AS tags,
  parseDateTime64BestEffortOrNull(raw.updated_at::String, 3, 'UTC') AS updated_at
FROM crm.tickets_raw FINAL`,
})

const ticketStream = defineStream({
  id: 'helpdesk.tickets',
  destination: rawTickets,
  async *read(context) {
    for await (const page of listTickets(context)) yield { rows: rawRows(page, (ticket) => ticket.id) }
  },
})
```

The raw table is a `ReplacingMergeTree`, so overlapping windows and replays collapse to the latest version of each `id`. Because the transform lives in ClickHouse, changing it never requires re-fetching the source: a view picks the change up immediately, and a materialized view can be rebuilt from the raw table. A `_raw` suffix next to the typed view of the same name keeps the pair easy to find.

## Progress and checkpoints

| Strategy | Use when | Bookmark advances |
|---|---|---|
| none (full sync) | The source is small or has no change filter | Never; every run reads everything |
| `timestampWindow({ start, overlapMs })` | The API filters by an updated-since timestamp | To the run cutoff, after the whole window loaded |
| `cursorState({ id, version, parse })` | The provider owns the state: compound cursor, change token, page position | Whenever a yielded chunk carries `state` and its rows have been saved |

`timestampWindow` starts its first sync at `start`. Later runs begin at the committed watermark minus `overlapMs` (zero by default). Explicit backfill bounds take precedence. For custom lower bounds, use `timestampWindow({ from: ({ watermark, cutoff }) => ... })` instead. Both forms retain the same checkpoint format and only advance after the entire window is saved.

Provider clients can accept the exported `FetchContext` type, containing `attempt` and `signal`. `ReadContext` extends it with the stream selection and checkpoint, so readers can pass their context directly without coupling clients to checkpoint generics.

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

Successful syncs start a new batch identity cycle, recorded by the existing journal. Failed or interrupted syncs retain their cycle for replay. This also applies to full syncs, which have no incremental bookmark.

The duration budget bounds journal operations as well as readers. Shutdown gives unfinished readers or writes up to five seconds to settle; each terminal journal append has a separate five-second limit. Interrupted writes never count as successful ingestion.

Run at most one ingestion process per project and target at a time. Use your scheduler's concurrency control (for example a GitHub Actions concurrency group) to enforce it.

## Options

| Option | Default | Description |
|---|---|---|
| `journalTable` | `_chkit_ingestion_journal` | Journal table name in the configured database |
| `maxDurationSeconds` | `3600` | Execution budget. Exhausting it ends the run as incomplete and keeps committed progress |
| `prefetchBatches` | `1` | Mapped batches buffered between fetching and loading |
