---
title: Kafka tables
description: Define Kafka queues and materialized-view ingestion pipelines in schema code.
sidebar:
  order: 4
---

Use `table({ engine: 'Kafka', ... })` to manage a Kafka queue together with its
materialized view and storage table. Kafka tables have columns and engine settings,
but no `primaryKey`, `orderBy`, partitioning, TTL, indexes, or projections.

```ts
import { schema, table, materializedView } from '@chkit/core'

const columns = [
  { name: 'id', type: 'String' },
  { name: 'event_time', type: 'DateTime64(3)' },
]

const queue = table({
  database: 'analytics', name: 'events_queue', engine: 'Kafka', columns,
  settings: {
    kafka_broker_list: 'kafka01:9092,kafka02:9092',
    kafka_topic_list: 'events',
    kafka_group_name: 'analytics_events',
    kafka_format: 'JSONEachRow',
    kafka_num_consumers: 1,
    input_format_skip_unknown_fields: true,
  },
})

const events = table({
  database: 'analytics', name: 'events', engine: 'MergeTree', columns,
  primaryKey: ['event_time', 'id'], orderBy: ['event_time', 'id'],
  partitionBy: 'toYYYYMM(event_time)',
})

const consumer = materializedView({
  database: 'analytics', name: 'events_consumer',
  to: { database: 'analytics', name: 'events' },
  as: 'SELECT id, event_time FROM analytics.events_queue',
})

export default schema(queue, events, consumer)
```

Run `chkit generate`, review the SQL, then `chkit migrate --apply`. Tables are
created before materialized views. Attaching the view starts background consumption.
The Kafka engine must be available on the target server, which must be able to
reach the brokers. This workflow is tested on self-hosted ClickHouse 25.3 and 26.3.

## Settings and validation

Kafka settings are literal values: strings are quoted and escaped, numbers remain
numbers, and booleans render as `1` or `0`. Pass `kafka_format: 'JSONEachRow'`, not
a string containing SQL quotes. Existing MergeTree setting strings keep their
previous raw SQL behavior; this addition does not reinterpret older snapshots.

With `engine: 'Kafka'` or `'Kafka()'`, supply nonempty `kafka_broker_list`,
`kafka_topic_list`, `kafka_group_name`, and `kafka_format` settings. Positional
arguments such as `Kafka('broker:9092', 'topic', 'group', 'JSONEachRow')` and
`Kafka(named_collection)` are also retained on pull. The server validates those
arguments and named collections.

Kafka columns cannot have `DEFAULT` values. Compute defaults in the consuming
materialized view instead. Format-specific settings are passed through; check
their availability on your ClickHouse version.

`kafka_auto_offset_reset` is not a standard ClickHouse Kafka table setting. Set
`auto_offset_reset` in the server's extended Kafka configuration. See the
[ClickHouse Kafka reference](https://clickhouse.com/docs/engines/table-engines/integrations/kafka).

## Changing a queue

`generate` refuses changes to an existing Kafka table's columns, settings, engine,
or comment with `kafka_change_requires_replacement`. It leaves migrations and the
snapshot untouched. Kafka does not support the generic column/settings ALTER
operations used for MergeTree tables, and automatically replacing an active queue
could disrupt ingestion.

For an intentional replacement:

1. Remove the queue and **all consuming materialized views** from your schema.
   Keep the destination storage table. Generate a migration with
   `chkit generate --name stop-events-queue`.
2. Re-add the updated queue and views. Generate a second migration with
   `chkit generate --name restart-events-queue`.
3. Review both migrations, the interruption window, and the consumer group and
   offset behavior. Apply with `chkit migrate --apply --allow-destructive`.

The generated drop migration removes views before synchronously dropping the
queue; the second migration creates the queue before its views. The storage table
is retained, and both generated snapshots remain consistent with the migration
history. This is an explicit replacement, not a zero-downtime operation. Existing
consumer-group offsets, broker retention, and in-flight batches determine whether
messages resume, replay, or are unavailable. chkit does not promise exactly-once
delivery or reset offsets. Coordinate other consumers and unmanaged views yourself.

`generate --empty` still provides manual SQL, but intentionally does not update
schema snapshots. Use the two generated migrations above when replacing a managed
queue so the snapshot follows the change.

## Pull, drift, and scope

`chkit pull schema` emits a Kafka definition without sorting keys and decodes its
settings into literal values. `drift` and `check` compare the engine, columns, and
settings declared in the snapshot. Numeric/boolean metadata and SQL string quoting
are normalized without removing meaningful whitespace from strings.

Consumer offsets, lag, assignments, topic contents, and server configuration or
named-collection contents are runtime/external state, outside schema drift. Server
settings absent from the desired schema are not treated as drift.

Prefer server-side configuration for credentials. Pull warns when credential
settings are returned in plaintext or redacted; `[HIDDEN]` credentials must be
resolved before generating SQL. Values evaluated from environment variables in
schema code are still written into snapshots and migration files.

Distributed and other integration engines are outside this release's scope.
