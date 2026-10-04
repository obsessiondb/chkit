# Lemlist raw ingestion example

This is a small editable starting point based on the Lemlist source in [obsessiondb/brain](https://github.com/obsessiondb/brain/tree/main/scripts/brain-sync). It stores provider responses as native JSON without Brain's memory or sales projections.

Set `LEMLIST_API_KEY` in the runtime environment and configure a direct ClickHouse connection. Edit `pageSize` and the stream list in `index.ts` for the resources needed by the project. Native JSON requires ClickHouse 25.3 or later.

Keep each stream ID and destination tied to one Lemlist account. The reader does not resolve the authenticated account identity: when changing the key to another account, use new stream IDs and destinations before ingesting so previous watermarks cannot skip that account's history.

```sh
bunx chkit check
bunx chkit generate --name add_lemlist
# Review the migration before applying it.
bunx chkit migrate --apply
bunx chkit ingest run --tag provider:lemlist
```

## Resources

- `activities` → `lemlist_activities_raw`
- `campaigns` → `lemlist_campaigns_raw`

## Sync and recovery

Activities use the provider's inclusive `minDate`/`maxDate` filters on `createdAt`. The initial range starts at `2000-01-01`; later runs replay one day before the last committed watermark. A large range is split into intervals of at most thirty days. Offset pagination stays local to each interval; an unfinished interval always starts at offset zero after failure. The checkpoint advances only after every page of an interval has been written successfully, including empty intervals. An explicit backfill resumes completed intervals in its own checkpoint namespace while retaining one day of overlap.

The upper bound does not freeze the provider dataset. Late arrivals or deletions can still change offset pages, and older activities can receive backfilled metadata. Do not treat activity offsets as change cursors or row chunks as immutable page identities. Periodic historical replay refreshes metadata and catches arrivals beyond the overlap:

```sh
bunx chkit ingest run --tag provider:lemlist --tag resource:activities --backfill reconcile-2026-10-04 --from 2000-01-01
bunx chkit ingest status --tag provider:lemlist --json
```

Use a new backfill ID for each complete reconciliation; reusing an ID resumes that backfill. A reused ID with an upper bound earlier than its committed frontier is rejected; use a new ID for a narrower historical range. Date intervals intentionally have inclusive shared boundaries; stable `_id` row keys reconcile repeated observations. Empty completion markers carry interval identities, while mutable row chunks do not.

Campaigns always scan from offset zero, ordered by `createdAt:asc`. Their `completedAt` checkpoint records a successful full scan rather than a modification cursor. Creation-only filtering would miss later campaign state changes. Removed campaigns or activities remain stored. Run one ingestion process per ClickHouse target at a time.

## Fixture tests

```sh
bunx chkit add lemlist --with-tests
bun test src/integrations/lemlist/tests/basic.test.ts
```

The portable suite checks bounded interval pagination, committed-frontier recovery, explicit backfill isolation, sink failure and empty scan completion without live credentials.
