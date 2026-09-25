---
title: Test a source
description: Verify source selection, checkpoint safety, and replay using in-memory ingestion adapters.
---

Use fixture responses and the in-memory adapters to test source behavior before connecting the reader to a live destination.

## Choose the test boundary

| Boundary | Use for | Does not establish |
|---|---|---|
| Reader plus fixture client | Mapping, pagination termination, time bounds, and provider errors | Durable checkpoint ordering |
| `runIngestion` plus memory adapters | Commit ordering, failures, resumption, and selected stream behavior | Actual ClickHouse encoding, engine merges, or deduplication-window settings |
| An isolated development database | Schema compatibility, JSON encoding, and query results after replay | Every future provider response or production load profile |

Import the testing adapters from `@chkit/plugin-ingest/testing`. `runIngestion`, `selectStreams`, and the ClickHouse runtime adapters are public APIs; embedding them means the host supplies the journal, destination, cancellation, and other runtime settings normally provided by the CLI.

## Example: a lost acknowledgement

Save as `src/ingestion.test.ts` and run `bun test src/ingestion.test.ts`. The memory destination accepts the second row, then the simulated transport reports failure. A new run must resume from the previous durable checkpoint and replay the ambiguous write without adding a duplicate:

```ts
import { expect, test } from 'bun:test'
import { cursorState, definePipeline, defineStream, rawRows, rawTable, runIngestion, selectStreams } from '@chkit/plugin-ingest'
import { createMemoryDestination, createMemoryJournal } from '@chkit/plugin-ingest/testing'

test('replays an acknowledged write whose response was lost', async () => {
  const source = [{ id: '1' }, { id: '2' }, { id: '3' }]
  const stream = defineStream({
    id: 'fixture.items',
    destination: rawTable({ database: 'default', name: 'items_raw' }),
    batchSize: 1,
    incremental: cursorState({
      id: 'fixture.offset', version: 1,
      parse(raw) {
        if (typeof raw !== 'number' || !Number.isSafeInteger(raw) || raw < 0) {
          throw new Error('Invalid offset')
        }
        return raw
      },
    }),
    async *read({ state }) {
      // A fixed fixture has stable offsets; a mutable API may not.
      for (let offset = state ?? 0; offset < source.length; offset += 1) {
        yield { rows: rawRows(source.slice(offset, offset + 1), (item) => item.id), state: offset + 1 }
      }
    },
  })
  // Disable reader restarts so the first execution exposes the write failure.
  const pipeline = definePipeline({ id: 'fixture', streams: [stream], retry: { retries: 0 } })
  const selected = selectStreams([pipeline], [])
  const journal = createMemoryJournal()
  const destination = createMemoryDestination()
  const failed = await runIngestion({ selected, backfill: undefined }, {
    journal,
    destination: {
      async insert(input) {
        await destination.insert(input)
        if (input.rows[0]?.id === '2') throw new Error('acknowledgement lost')
      },
    },
  })
  expect(failed.ok).toBe(false)
  expect((await journal.readCheckpoint(stream.id)).envelope?.state).toBe(1)

  const resumed = await runIngestion({ selected, backfill: undefined }, { journal, destination })
  expect(resumed.ok).toBe(true)
  expect((await journal.readCheckpoint(stream.id)).envelope?.state).toBe(3)
  expect(destination.tables.get('default.items_raw')?.map((row) => row.id)).toEqual(['1', '2', '3'])
}, 10_000)
```

The memory destination deduplicates tokens without a time limit. It does not model `ReplacingMergeTree` merges or the destination's real deduplication window; verify those against the intended ClickHouse target.

## Cases to cover for a real source

- Empty input, several pages, an empty page with a continuation, and a repeated continuation.
- Inclusive/exclusive timestamp boundaries, late updates, overlap, and explicit backfill bounds.
- Provider cursor expiration, malformed saved state, and terminal cursor behavior.
- Transient failures, rate limiting, permanent auth failures, and cancellation.
- Failure after rows are saved but before progress is journaled; reruns and later successful syncs.
- Missing fields, large records, current state versus history, and replay after a tombstone.
- Child edits/deletes that do not change the parent timestamp; a failed child fetch must not publish an incomplete root as complete.
- Deletion discovery and checkpointing; a partial reconciliation scan must not mark unseen records as deleted.

Start with `chkit ingest list` and `chkit check --offline` to verify exports and required metadata columns. These checks do not prove that a provider reader or live table behaves correctly.

## Related pages

- [Readers and pagination](/api-sync/readers/): request and source contracts.
- [Incremental syncs](/api-sync/incremental-syncs/): durable state boundaries.
- [Scheduling and recovery](/api-sync/operations/): interpret production outcomes.
