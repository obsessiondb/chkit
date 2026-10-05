# Google Meet raw ingestion

This editable reader stores provider responses as native JSON and journals fixed discovery windows plus pending conference and artifact progress. It builds on the overlapping-window pattern in [obsessiondb/brain](https://github.com/obsessiondb/brain/tree/main/scripts/brain-sync) and retains parents so late artifacts survive discovery advancing.

Set `GOOGLE_MEET_ACCESS_TOKEN` in the runtime environment and configure a direct ClickHouse connection. Review `sourceId`, `streamPrefix`, `lookbackDays`, `overlapDays`, `windowDays`, `database`, and limits in `config.ts`. Keep `sourceId` and stream IDs tied to one authenticated Google account. The API does not expose a source identity check in these list responses; changing the token's account requires a separate source/checkpoint. Native JSON requires ClickHouse 25.3 or later. Tokens are read at request time and are not refreshed by this reader.

```sh
bunx chkit check
bunx chkit generate --name add_google_meet
# Review the migration before applying it.
bunx chkit migrate --apply
bunx chkit ingest run --tag provider:google-meet
bunx chkit ingest status --tag provider:google-meet
```

## Resources and identities

- `conferences` → `google_meet_conferences_raw`
- `transcripts` → `google_meet_transcripts_raw` (transcript metadata with `conference_name`)
- `transcript-entries` → `google_meet_transcript_entries_raw` (one entry per row with `conference_name` and `transcript_name`)

Every resource uses `[sourceId, provider.name]` as its row identity. Entries are emitted page by page rather than buffering a full transcript inside one JSON row. Join metadata and entries through their provider resource names. These raw destinations keep the latest observed value; they do not capture later edits to the Google Docs transcript document.

## Pipeline and streams

One installation exports one `google_meetPipeline` containing three independently selectable streams. `pipeline.ts` wires resource streams to destinations; `sources/resources.ts` shares provider traversal code while every stream keeps its own pending work and checkpoint. `client.ts` owns validated HTTP requests. The ingestion library owns retries, cancellation, budgets, and load acknowledgements.

Transcript and entry streams discover their own parent conferences. Running either stream does not require the conferences stream to run first. Nested pagination follows Meet's parent-scoped endpoints; it does not create a pipeline or stream for every conference or transcript.

```sh
bunx chkit ingest run --tag provider:google-meet --tag resource:conferences
bunx chkit ingest run --tag provider:google-meet --tag resource:transcripts
bunx chkit ingest run --tag provider:google-meet --tag resource:transcript-entries
```

`sourceId` scopes raw identities and checkpoint query state. `streamPrefix` scopes pipeline and journal IDs; the defaults preserve existing `google-meet.*` streams. Use a separate source label and stream prefix for another installation. `createGoogleMeetPipeline` in `pipeline.ts` snapshots reader settings and binds injectable fetch/token dependencies. It uses the exported raw destinations; edit `database` in the installation's `config.ts` before schema imports to change their placement. Database placement is a setup-time schema setting, excluded from runtime reader configuration.

The default pipeline runs one stream and request at a time. Stream selection permits separate schedules and execution budgets; every stream's journal progress remains independent.

## Discovery and pending work

Each stream independently discovers completed conferences through `end_time` bounds and ongoing conferences through `end_time IS NULL`. This includes long-running calls whose start predates the lookback. Initial discovery defaults to the retained 30-day period; later runs overlap seven days. A cycle's bounds are persisted before requesting its first page, so pauses keep the same window. `windowDays` caps forward advancement per cycle.

Transcript and entry streams retain discovered conference names until `expireTime`, independently of the discovery watermark. Every completed cycle checks those parents again, including parents with no transcripts and transcripts still being generated. This captures late artifacts outside the seven-day discovery overlap. Retention, access, and polling frequency still determine coverage; this is polling, not a provider change feed. Meet exposes no modification/change token and does not support transcript/entry date filters. See [conference filtering](https://developers.google.com/workspace/meet/api/reference/rest/v2/conferenceRecords/list) and [artifact behavior](https://developers.google.com/workspace/meet/api/guides/artifacts).

## Checkpoints and recovery

Acknowledged pages checkpoint discovery, parent, transcript-page, and entry-page positions. A failed entry load retains its preceding page position. Rejected page tokens restart their scoped collection once and may replay observations; repeated rejection and malformed pagination fail visibly. Candidate state is complete and advances only after its rows have sink evidence.

Recovery counts remain saved for an unfinished discovery phase, parent transcript collection, or transcript entry collection until its terminal boundary has destination acknowledgement. A budget pause after recovery or a successful nonterminal replay page keeps its count. A second rejection for that unfinished collection fails even in a fresh scheduled execution. Edit `maxChunks` in `config.ts` to change the stream chunk cap, choose sufficient `--max-duration`, and run frequently enough to finish before tokens expire. After fixing those conditions and reviewing coverage, migrate saved state explicitly or use a new stream identity for a deliberate fresh scan.

Each stream permits 200 chunks per run and retains at most 1,000 conferences. Requests have a 30-second timeout. Budget exhaustion preserves progress and a later invocation continues it. Increase `maxChunks` and `maxPendingConferences` in `config.ts` deliberately for larger sources. A pending queue over its configured limit fails rather than silently dropping parents. The executor owns request retries, cancellation, and load acknowledgements. Run one ingestion process per ClickHouse target at a time.

Google deletes conference records and API transcript entries 30 days after a conference ends. The reader reports expiry during unfinished work as a coverage gap; it cannot recover expired API entries. Previously checked parents leave the work queue on expiry, while stored raw rows remain. It does not infer deletion from missing, inaccessible, or expired resources. See [conference retention](https://developers.google.com/workspace/meet/api/reference/rest/v2/conferenceRecords) and [artifact retention](https://developers.google.com/workspace/meet/api/guides/artifacts).

## Historical ranges

Explicit bounds apply to conference end times and use an isolated backfill checkpoint. Historical ranges skip ongoing-call discovery. Reuse the same backfill ID and bounds to resume; changing the bounds requires another ID. Artifact lists remain parent-scoped and cannot themselves be date-filtered. Expired history is unavailable even when a backfill range requests it.

```sh
bunx chkit ingest run --tag provider:google-meet --backfill october --from 2026-10-01T00:00:00Z --to 2026-10-05T00:00:00Z
```

Checkpoint validation rejects changed source/window scope and invalid nested positions. Migrate state explicitly or use a new stream identity when changing these settings.

## Upgrading from 0.1.x

Version 0.2.0 keeps the existing conference and transcript destinations and adds an entry table. New transcript rows contain metadata; entries live in the separate table. Row identities now include `sourceId`, so upgraded observations do not replace legacy provider-name IDs. Old rows and their nested `entries` remain until an explicit identity/data migration. Keep older tables as archives or migrate identities deliberately before mixing datasets.

## Fixture tests

```sh
bunx chkit add google-meet --with-tests
bun test src/integrations/google-meet/tests/basic.test.ts
```

Fixtures verify nested resumption, retained parents with late transcripts, end-time and ongoing discovery, rejected tokens, failed loads, isolated backfill bounds, malformed state, expiry gaps, factory configuration, independent resource selection, and request-time token rotation without live credentials.

The [Google Meet integration guide](https://chkit.obsessiondb.com/integrations/google-meet/) covers installation and sync behavior.
