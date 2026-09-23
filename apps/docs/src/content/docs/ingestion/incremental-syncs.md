---
title: Incremental syncs
description: Start with a full sync, then use time windows or durable provider state to fetch changes.
---

Use an incremental strategy to select the records to fetch and the state to commit after their writes succeed.

## Start with a full sync

For a small, bounded dataset, omit `incremental` as in the [quickstart](/ingestion/quickstart/). Each run reads the source again with no bookmark. Keep this approach when the provider has no reliable change filter and the cost of a complete read is acceptable.

A full sync does not replace the destination snapshot or detect missing records. See [deletion handling](/ingestion/destinations/#handle-deleted-records) before treating the destination as a complete current-state mirror.

For expensive full reads, use the provider's change mechanism: a timestamp window for time filters, or durable provider state for a resumable change feed. Pagination tokens alone do not establish either contract.

## Timestamp windows

`start` is the first run's lower bound. Later runs start at the last watermark minus `overlapMs` (default `0`). The upper bound is a fixed execution cutoff, or the explicit backfill upper bound. Choose overlap based on provider indexing delays and late updates; reconcile repeated records in the destination.

This complete source module uses the client from [Readers and pagination](/ingestion/readers/#a-reusable-page-client). Save it as `src/sources/helpdesk.ts` and re-export its table and pipeline from the project entry:

```ts
import { definePipeline, defineStream, paginate, rawRows, rawTable, timestampWindow } from '@chkit/plugin-ingest'
import { fetchTicketPage } from './helpdesk-client.js'

export const ticketsRaw = rawTable({ database: 'default', name: 'tickets_raw' })

const tickets = defineStream({
  id: 'helpdesk.tickets',
  destination: ticketsRaw,
  incremental: timestampWindow({
    start: new Date('2026-01-01T00:00:00Z'),
    overlapMs: 60 * 60 * 1000,
  }),
  async *read(context) {
    const pages = paginate({
      context,
      label: 'GET /tickets',
      fetchPage: async (cursor: string | undefined, signal) => {
        const page = await fetchTicketPage(context.selection, cursor, signal)
        return { items: page.data, next: page.next_cursor ?? undefined }
      },
    })
    for await (const page of pages) {
      yield { rows: rawRows(page, (ticket) => ticket.id) }
    }
  },
})

export const helpdesk = definePipeline({ id: 'helpdesk', streams: [tickets] })
```

The client applies **both** `selection.from` and `selection.to`. chkit does not filter arbitrary provider rows itself. If an API supports only a lower bound, the reader must enforce the upper bound using documented timestamp/order semantics and terminate pagination correctly. Specify whether boundaries are inclusive or exclusive and test them.

After a failure or budget exhaustion, the timestamp strategy rereads the window from its previous watermark. Saved rows remain in the destination. Intermediate pagination cursors do not become checkpoints. If a window exceeds the run budget, reduce the source selection, increase the budget, or use a strategy with resumable intermediate state.

<details>
<summary>Customize the lower bound</summary>

Use `timestampWindow({ from })` when `start` and `overlapMs` do not express the required lower-bound rule. The callback receives `{ watermark, cutoff }` and is mutually exclusive with those options. It uses the same whole-window checkpoint rule. Explicit backfill bounds take precedence.

</details>

## Provider cursors and compound state

Choose `cursorState` when the provider guarantees resumption across runs. `parse` validates the saved state. `context.state` and `context.selection` expose it to the reader; neither contains uncommitted progress.

This standalone fixture demonstrates a provider with stable, increasing change sequence numbers. Replace the fixture read with a documented provider operation inside `context.attempt`:

```ts
import { cursorState, definePipeline, defineStream, rawRows, rawTable } from '@chkit/plugin-ingest'

const changes = [
  { sequence: 1, id: 'a', subject: 'Opened' },
  { sequence: 2, id: 'a', subject: 'Resolved' },
  { sequence: 3, id: 'b', subject: 'Opened' },
]

export const ticketsRaw = rawTable({ database: 'default', name: 'tickets_raw' })
const tickets = defineStream({
  id: 'fixture.tickets', destination: ticketsRaw,
  batchSize: 2,
  incremental: cursorState({
    id: 'fixture.change-sequence', version: 1,
    parse(raw) {
      if (typeof raw !== 'number' || !Number.isSafeInteger(raw) || raw < 0) {
        throw new Error('Invalid saved change sequence')
      }
      return raw
    },
  }),
  async *read(context) {
    let after = context.state ?? 0
    while (true) {
      const page = await context.attempt(async (signal) => {
        signal.throwIfAborted()
        return changes.filter((change) => change.sequence > after).slice(0, 2)
      }, { label: 'read changes' })
      const last = page.at(-1)
      if (!last) return
      yield { rows: rawRows(page, (ticket) => ticket.id), state: last.sequence }
      after = last.sequence
    }
  },
})

export const fixture = definePipeline({ id: 'fixture', streams: [tickets] })
```

`state` is the complete resume state safe after all rows through that chunk are saved. It can be a scalar or an object such as `{ snapshot, cursor }`. Omit it if the source cannot guarantee a safe boundary. An empty chunk with state can record progress when no destination rows are needed.

A pagination token may expire between runs. Confirm expiration, snapshot lifetime, ordering, and terminal-token behavior before storing one. Resumption must not skip unfinished pages or repeatedly reuse an expired cursor.

## Custom strategies and changes to state

<details>
<summary>Extend planning or change an existing checkpoint format</summary>

Implement `IncrementalStrategy` only when `cursorState`'s opaque state or timestamp windows are insufficient. A custom strategy has a stable `id` and `version`, validates existing state with `parseState`, and plans selections from `{ state, cutoff, range }`. Its optional `complete` runs only after the whole selection is consumed.

Changing the strategy ID or version makes an existing checkpoint incompatible and fails the run. Plan an explicit state migration or a new stream identity; renaming a stream starts a separate checkpoint history. Moving it between pipelines does not reset state.

The built-in full-sync and cursor strategies do not interpret `--from` / `--to`. Historical range selection works with timestamp windows or a custom strategy that handles `range`.

</details>

## Related pages

- [Readers and pagination](/ingestion/readers/): provider contracts and bounded fetching.
- [Loading and batching](/ingestion/loading/#batch-identity): checkpoint state versus batch identity.
- [Scheduling and recovery](/ingestion/operations/#backfill-source-data): isolated historical runs.
