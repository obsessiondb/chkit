# Google Calendar raw ingestion

This editable reader stores canonical Google Calendar responses as native JSON and checkpoints provider sync tokens in the chkit ingestion journal. It follows the recoverable ingestion patterns in [obsessiondb/brain](https://github.com/obsessiondb/brain/tree/main/scripts/brain-sync), using Google's change-token protocol for canonical events.

Set `GOOGLE_CALENDAR_ACCESS_TOKEN` in the runtime environment and configure a direct ClickHouse connection. Review `sourceId`, `streamPrefix`, `calendarId`, `database`, and `maxChunks` in `config.ts`. Native JSON requires ClickHouse 25.3 or later. Keep `sourceId` tied to one OAuth installation. Schema imports do not need credentials; requests read the token at runtime and do not refresh it.

```sh
bunx chkit check
bunx chkit generate --name add_google_calendar
# Review the migration before applying it.
bunx chkit migrate --apply
bunx chkit ingest run --tag provider:google-calendar
bunx chkit ingest status --tag provider:google-calendar
```

## Resources and identities

- `events` → `google_calendar_events_raw`

The first run reads canonical events with `singleEvents=false` and `showDeleted=true`: one-off events, recurring series masters, exceptions, and cancellation payloads. It does not expand every occurrence of a recurring series. Raw row IDs are `[sourceId, resolvedCalendarId, event.id]`; calendar metadata resolves `primary` to a stable calendar ID and prevents a different account from silently reusing its checkpoint.

The raw destination keeps the latest observed payload per identity. A recurring master contains recurrence rules; applications needing occurrences should add a separate bounded instances reader or derive an occurrence projection. A cancelled payload can be sparse and remains unmodified.

## Pipeline and stream

One installation exports one `google_calendarPipeline` with the canonical `events` stream. `pipeline.ts` wires the stream to its destination and sync-token strategy; `sources/events.ts` owns provider progress, and `client.ts` owns validated requests. The ingestion library owns retries, cancellation, budgets, and load acknowledgements.

`sourceId` scopes raw identities and checkpoint query state. `streamPrefix` scopes pipeline and journal IDs; the defaults keep `google-calendar.events` and its existing checkpoint. Use a separate source label and stream prefix for another installation. `createGoogleCalendarPipeline` in `pipeline.ts` snapshots reader settings and binds injectable fetch/token dependencies. It uses the exported raw destination; edit `database` in the installation's `config.ts` before schema imports to change its placement. Database placement is a setup-time schema setting, excluded from runtime reader configuration.

## Checkpoints and recovery

Each acknowledged event page checkpoints its next page token while retaining the same input sync token. Only an acknowledged terminal page promotes `nextSyncToken`. Empty terminal pages also commit progress. A failed load leaves the preceding checkpoint, so rerunning resumes safely and may replay observations. Requests have a 30-second timeout. Each run permits 200 page chunks; budget exhaustion preserves progress for the next run. The executor owns retries, cancellation, and sink acknowledgements; run one ingestion process per ClickHouse target at a time.

Subsequent runs send the committed `syncToken` and ingest Google's changes, including cancelled events. All pages use fixed request parameters. `syncToken` cannot be combined with `timeMin`, `timeMax`, `updatedMin`, or `orderBy`, so this reader rejects explicit `--from`/`--to` bounds. A separately named backfill without date bounds has an isolated checkpoint and performs its own canonical sync. See [Google's synchronization guide](https://developers.google.com/workspace/calendar/api/guides/sync) and [events.list](https://developers.google.com/workspace/calendar/api/v3/reference/events/list).

`410 Gone` on an incremental request clears provider progress and starts a full baseline. A rejected page token replays its current sync once; repeated rejection fails visibly. Neither recovery path drops stored raw rows. A record absent from the rebuilt baseline can remain in ClickHouse, so this table is a latest-observed archive, not a reconciled current calendar. A current-state projection needs completed-baseline generations or explicit reconciliation before treating absence as removal.

The recovery count stays in the checkpoint until the terminal sync page has destination acknowledgement. Pausing immediately after recovery or successfully replaying a nonterminal page keeps that count. A second token rejection for the same unfinished sync fails across scheduled executions. Edit `maxChunks` in `config.ts` to change the stream chunk cap, choose sufficient `--max-duration`, and run frequently enough to finish while provider tokens remain valid. After correcting those conditions and reviewing coverage, migrate the saved state explicitly or use a new stream identity for a deliberate fresh sync.

Checkpoint state validates source/query scope and resolved calendar identity. Changing source settings requires an explicit state migration or another stream ID; the reader never silently reinterprets old progress.

## Upgrading from 0.1.x

Version 0.2.0 replaces the rolling occurrence window with canonical change-token sync and changes row identities to include the resolved calendar and installation. Keep the existing raw table as an archive and use a new table/stream identity for a fresh canonical dataset, or deliberately migrate existing row identities. Existing expanded occurrences are not removed automatically.

## Fixture tests

```sh
bunx chkit add google-calendar --with-tests
bun test src/integrations/google-calendar/tests/basic.test.ts
```

Fixtures verify page resumption, empty deltas, terminal token promotion after loads, cancellation payloads, token expiry, scope changes, malformed pagination, isolated factory configuration, and request-time token rotation without live credentials.

The [Google Calendar integration guide](https://chkit.obsessiondb.com/integrations/google-calendar/) covers installation and sync behavior.
