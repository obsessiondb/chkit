---
title: Destinations and transformations
description: Store raw data for flexible ClickHouse transformations or map records into a known schema before loading.
---

Choose between retaining source objects and transforming them in ClickHouse, or mapping them into the required columns before loading.

## Stored shape

| Approach | Choose when |
|---|---|
| **Store raw, transform in ClickHouse** | You expect the schema or query requirements to change. Retain the returned fields and expose the current shape through SQL views. |
| **Map first, store shaped rows** | The schema is already defined, such as warehouse tables for tickets, customers, and comments. A mapping function produces the columns to load. |

**Start with raw storage when the final shape may change and storage is affordable.** You can transform retained fields with SQL without fetching the source again. At large volumes, weigh the storage and ingestion cost of fields you do not expect to use. Both approaches store data in ClickHouse and use the same default loader.

Map before loading into established warehouse tables. Define columns for measures and relationships, and choose types and ordering for the intended queries. You can populate new tables from retained raw records as requirements change.

## Store raw and expose a view

`rawTable` stores an ID, native JSON, and ingestion metadata. The reader uses `rawRows` to preserve the returned object; an ordinary view supplies typed query columns.

```ts
import { view } from '@chkit/core'
import { definePipeline, defineStream, rawRows, rawTable } from '@chkit/plugin-ingest'

export const ticketsRaw = rawTable({ database: 'default', name: 'tickets_raw' })

const ticketsSource = defineStream({
  id: 'demo.tickets', destination: ticketsRaw,
  async *read() {
    // A fixture represents one provider page. Replace it with a paginated reader.
    const page = [{ id: '1', subject: 'Login issue', status: 'open' }]
    yield { rows: rawRows(page, (ticket) => ticket.id) }
  },
})

export const tickets = view({
  database: 'default', name: 'tickets',
  as: `SELECT id,
         raw.subject::String AS subject,
         raw.status::String AS status
       FROM default.tickets_raw FINAL`,
})

export const demo = definePipeline({ id: 'demo', streams: [ticketsSource] })
```

Change the view through a schema migration to query retained rows with the new expression. `FINAL` reconciles repeated object versions at query time. The raw table retains the latest ingested version per ID; use the [history model](#current-state-or-history) to preserve earlier revisions.

<details>
<summary>Native JSON compatibility</summary>

Native JSON is [production-ready from ClickHouse 25.3](https://clickhouse.com/docs/reference/data-types/newjson). If it is unsuitable for the target, a custom table can retain serialized JSON in a `String` column and queries can use JSON extraction functions. This is a storage representation of the same raw approach.

</details>

## Map into a known schema

Use a mapping function inside `read` to produce the destination columns. There is no separate mapping hook to register. This alternative is a complete source module; re-export its table and pipeline from the project entry.

```ts
import { table } from '@chkit/core'
import { definePipeline, defineStream, ingestionColumns } from '@chkit/plugin-ingest'

type Ticket = { id: string; subject: string; status: string; customer_id: string }

function mapTicket(ticket: Ticket) {
  return {
    id: ticket.id,
    subject: ticket.subject,
    status: ticket.status,
    customer_id: ticket.customer_id,
  }
}

export const tickets = table({
  database: 'default', name: 'tickets',
  columns: [
    { name: 'id', type: 'String' },
    { name: 'subject', type: 'String' },
    { name: 'status', type: 'LowCardinality(String)' },
    { name: 'customer_id', type: 'String' },
    ...ingestionColumns,
  ],
  engine: 'ReplacingMergeTree(_chkit_ingested_at)',
  primaryKey: ['id'], orderBy: ['id'],
})

const ticketsSource = defineStream({
  id: 'demo.tickets', destination: tickets,
  async *read() {
    const page: Ticket[] = [
      { id: '1', subject: 'Login issue', status: 'open', customer_id: 'customer-1' },
    ]
    yield { rows: page.map(mapTicket) }
  },
})

export const demo = definePipeline({ id: 'demo', streams: [ticketsSource] })
```

Add `ingestionColumns` to custom destinations. The default loader supplies batch/run IDs and ClickHouse supplies ingestion time. Migrations create the tables before ingestion runs. Query this current-state table with `FINAL`, or expose a view that does so.

Changing the mapping affects future writes. Updating older rows requires replaying retained raw data or refetching the source. Fields discarded before storage cannot be reconstructed by changing a view.

## Root objects and related tables

Decide what one row represents alongside its stored shape. A reader can fetch a root object and its children, but chkit does not discover relationships or load child objects automatically.

**Embed children when the application consumes a complete object.** For example, retain a ticket and its comments together for document retrieval. This denormalized shape keeps its context in one record, at the cost of rebuilding that record when a child changes. Fetch all required child pages before yielding the root; see [nested loading](/ingestion/readers/#parent-records-and-child-collections).

**Use separate entity tables when children need independent queries or updates.** For a warehouse, `tickets`, `ticket_comments`, and `customers` can have their own columns and stable keys, with `ticket_id` and `customer_id` linking them. Each stream has one destination; define separate streams for separately loaded tables, or derive them in ClickHouse from retained raw objects.

A structured warehouse need not be fully normalized. Denormalize frequently used attributes into a fact table when that reduces query-time joins; keep reusable or independently changing entities separate. Choose based on query patterns and update behavior. See [ClickHouse's modeling guidance](https://clickhouse.com/resources/engineering/when-to-denormalize-when-to-join).

Use tables with a defined entity or event meaning for general analytics. A single table containing unrelated document types fits specialized document-retrieval applications.

## Current state or history

For **current state**, reuse a stable source ID across versions. `rawTable` uses `ReplacingMergeTree(_chkit_ingested_at)`: the latest ingestion wins. Use a custom table versioned by a provider revision when older source records can arrive later, including during backfills.

For **history**, retain each event or revision under its own stable identity, such as a provider event ID or `(object_id, revision)`. Reconcile replays by that identity instead of collapsing every version of an object. Periodic snapshots capture only observed versions; a complete change history requires a source that exposes it.

Include account identity in keys when provider IDs are only unique within an account. Keep replacement keys stable across updates.

## Handle deleted records

For a current-state sync, prefer **tombstones**: insert a newer version with the same key and an `is_deleted` flag, then exclude deleted versions from current-state queries after resolving versions. This preserves deletion evidence through replay. Tombstones are an application schema convention; chkit does not add or interpret them automatically.

:::caution[Deleted records need an explicit source path]
An absent record in an incremental response does not establish deletion. Read the provider's deleted-record endpoint, deletion flag, or change feed. Without a deletion signal, implement a complete reconciliation scan covering the same source scope.

chkit has no built-in snapshot replacement or missing-record reconciliation. A full sync rereads records; it does not clear the table or remove absent IDs. Never infer deletions from a failed, partial, or differently scoped scan.
:::

If deletion records and updates share a checkpoint, finish both reads before advancing it. A custom cursor strategy must retain enough state to resume both safely. A deleted parent also needs an explicit policy for separately stored children; there is no cascading delete.

<details>
<summary>Example: a current-state table with tombstones</summary>

This standalone fixture assumes the provider supplies a monotonically increasing revision per ticket, including deletions. Adapt the version field to the actual source contract. The loader inserts deletion records like any other row.

```ts
import { table, view } from '@chkit/core'
import { definePipeline, defineStream, ingestionColumns } from '@chkit/plugin-ingest'

export const ticketVersions = table({
  database: 'default', name: 'ticket_versions',
  columns: [
    { name: 'id', type: 'String' },
    { name: 'subject', type: 'String' },
    { name: 'version', type: 'UInt64' },
    { name: 'is_deleted', type: 'UInt8' },
    ...ingestionColumns,
  ],
  engine: 'ReplacingMergeTree(version)',
  primaryKey: ['id'], orderBy: ['id'],
})

export const currentTickets = view({
  database: 'default', name: 'current_tickets',
  as: `SELECT id, subject FROM default.ticket_versions FINAL WHERE is_deleted = 0`,
})

const changes = defineStream({
  id: 'fixture.ticket-changes', destination: ticketVersions,
  async *read() {
    yield { rows: [{ id: '1', subject: 'Login issue', version: 1, is_deleted: 0 }] }
    yield { rows: [{ id: '1', subject: '', version: 2, is_deleted: 1 }] }
  },
})

export const demo = definePipeline({ id: 'demo', streams: [changes] })
```

After both writes, `current_tickets` excludes ticket `1`. A late replay of version `1` cannot supersede its version `2` tombstone. If the source supports restoration, represent it with a greater version and `is_deleted: 0`. Retaining tombstones is a logical-delete policy, not physical data erasure. See [ClickHouse versioned replacement](https://clickhouse.com/docs/concepts/features/operations/update/replacing-merge-tree).

</details>

## Additional transformations

Add a stored SQL transformation for query performance, or a separate reader to build application documents from retained rows.

<details>
<summary>Persist a SQL transformation for faster queries</summary>

An incremental materialized view transforms inserted blocks into a target table. Changing its expression does not rebuild old target rows. With mutable objects, source-table replacement does not retract earlier counts or sums, so replay and updates need explicit handling. See [materialized views](https://clickhouse.com/docs/concepts/features/materialized-views/incremental-materialized-view) and the [SQL backfill plugin](/plugins/backfill/).

For periodic SQL recomputation, see [refreshable views](/schema/refreshable-views/). This ClickHouse feature is separate from source refresh or deletion detection; ingestion does not supply a refreshing loader.

</details>

<details>
<summary>Build derived documents with application code</summary>

A separate stream can read retained raw tables, assemble documents in `read`, and write a custom destination with the default loader. Run it after the source streams succeed; pipeline declarations do not sequence dependencies. Use stable output keys, optionally skip unchanged content, and bound the scan's working memory. Writes publish per batch, not as an atomic replacement of the entire result.

</details>

## Related pages

- [Readers and pagination](/ingestion/readers/): fetch root objects and their children.
- [Loading and batching](/ingestion/loading/): start with the default loader.
- [Schema DSL](/schema/dsl-reference/): table and view definitions.
- [Scheduling and recovery](/ingestion/operations/#backfill-source-data): source rereads versus SQL backfills.
