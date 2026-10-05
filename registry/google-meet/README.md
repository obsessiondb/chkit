# Google Meet raw ingestion

This editable reader stores provider responses as native JSON and journals fixed discovery windows plus pending conference and artifact progress. It builds on the overlapping-window pattern in [obsessiondb/brain](https://github.com/obsessiondb/brain/tree/main/scripts/brain-sync) and retains parents so late artifacts survive discovery advancing.

Set `GOOGLE_MEET_ACCESS_TOKEN` with `meetings.space.readonly` in the runtime environment and configure a direct ClickHouse connection. Review `sourceId`, `streamPrefix`, `lookbackDays`, `overlapDays`, `windowDays`, `database`, and limits in `config.ts`. Keep `sourceId` and stream IDs tied to one authenticated Google account. The API does not expose a source identity check in these list responses; changing the token's account requires a separate source/checkpoint. Native JSON requires ClickHouse 25.3 or later. Tokens are read at request time and are not refreshed by this reader. Meet requires user authentication; the token covers records accessible to that user, not an automatic workspace-wide export. See [authorization](https://developers.google.com/workspace/meet/api/guides/authenticate-authorize).

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
- `participants` → `google_meet_participants_raw` (attendance records with `conference_name`)
- `participant-sessions` → `google_meet_participant_sessions_raw` (join/leave sessions with `conference_name` and `participant_name`)
- `recordings` → `google_meet_recordings_raw` (recording metadata and Drive references with `conference_name`)
- `transcripts` → `google_meet_transcripts_raw` (transcript metadata with `conference_name`)
- `transcript-entries` → `google_meet_transcript_entries_raw` (one entry per row with `conference_name` and `transcript_name`)

A conference record represents one call. A participant represents attendance within that call; each join from a device has its own participant session. Signed-in, anonymous, and phone identity objects remain native participant fields. Recording rows contain state, times, and `driveDestination` references; the reader does not download MP4 files. Transcript rows contain metadata and document references, while transcript entries contain individual speech segments. See [participants](https://developers.google.com/workspace/meet/api/reference/rest/v2/conferenceRecords.participants), [sessions](https://developers.google.com/workspace/meet/api/reference/rest/v2/conferenceRecords.participants.participantSessions), and [recordings](https://developers.google.com/workspace/meet/api/reference/rest/v2/conferenceRecords.recordings).

Every resource uses `[sourceId, provider.name]` as its row identity. Entries are emitted page by page rather than buffering a full transcript inside one JSON row. Join metadata and entries through their provider resource names. These raw destinations keep the latest observed value; they do not capture later edits to the Google Docs transcript document.

## Pipeline and streams

One installation exports one `google_meetPipeline` containing six independently selectable streams. `pipeline.ts` wires resource streams to destinations; `sources/resources.ts` shares provider traversal code while every stream keeps its own pending work and checkpoint. `client.ts` owns validated HTTP requests. The ingestion library owns retries, cancellation, budgets, and load acknowledgements.

Every child stream discovers its own parent conferences. The session stream also pages its own participants. Selecting a child does not require another stream to run first, and a child failure does not delay conference publication. Nested pagination follows Meet's parent-scoped endpoints; it does not create a pipeline or stream for every conference or transcript.

```sh
bunx chkit ingest run --tag provider:google-meet --tag resource:conferences
bunx chkit ingest run --tag provider:google-meet --tag resource:participants
bunx chkit ingest run --tag provider:google-meet --tag resource:participant-sessions
bunx chkit ingest run --tag provider:google-meet --tag resource:recordings
bunx chkit ingest run --tag provider:google-meet --tag resource:transcripts
bunx chkit ingest run --tag provider:google-meet --tag resource:transcript-entries
```

`sourceId` scopes raw identities and checkpoint query state. `streamPrefix` scopes pipeline and journal IDs; the defaults preserve existing `google-meet.*` streams. Use a separate source label and stream prefix for another installation. `createGoogleMeetPipeline` in `pipeline.ts` snapshots reader settings and binds injectable fetch/token dependencies. It uses the exported raw destinations; edit `database` in the installation's `config.ts` before schema imports to change their placement. Database placement is a setup-time schema setting, excluded from runtime reader configuration.

The default pipeline runs one stream and request at a time. Stream selection permits separate schedules and execution budgets; every stream's journal progress remains independent.

## Discovery and pending work

Each stream independently discovers completed conferences through `end_time` bounds and ongoing conferences through `end_time IS NULL`. This includes long-running calls whose start predates the lookback. Initial discovery defaults to the retained 30-day period; later runs overlap seven days. A cycle's bounds are persisted before requesting its first page, so pauses keep the same window. `windowDays` caps forward advancement per cycle.

All five child streams retain discovered conference names until `expireTime`, independently of the discovery watermark. Every completed cycle checks those parents again, including conferences with empty child lists and files still being generated. Attendance readers fetch complete participant/session lists without start/leave-time filtering, so late joins and subsequently populated leave times stay eligible. Recording and transcript readers revisit native metadata and entries after discovery advances. These reads capture late child changes outside the seven-day discovery overlap without relying on conference metadata updates. Retention, access, and polling frequency still determine coverage; this is polling, not a provider change feed. Meet exposes no modification/change token. Participant/session time filters describe attendance times rather than update times, and recordings/transcripts/entries have no date filters. See [conference filtering](https://developers.google.com/workspace/meet/api/reference/rest/v2/conferenceRecords/list) and [artifact behavior](https://developers.google.com/workspace/meet/api/guides/artifacts).

## Checkpoints and recovery

Acknowledged pages checkpoint discovery and each resource’s parent and child-page positions. Session readers retain one participant-name page and its current session token; entry readers retain one transcript page and its current entry token. A failed child load retains its preceding page position. Rejected page tokens restart their scoped collection once and may replay observations; repeated rejection and malformed pagination fail visibly. Candidate state is complete and advances only after its rows have sink evidence.

Recovery counts remain saved for an unfinished discovery phase or child collection, including nested participant sessions and transcript entries, until its terminal boundary has destination acknowledgement. A budget pause after recovery or a successful nonterminal replay page keeps its count. A second rejection for that unfinished collection fails even in a fresh scheduled execution. Edit `maxChunks` in `config.ts` to change the stream chunk cap, choose sufficient `--max-duration`, and run frequently enough to finish before tokens expire. After fixing those conditions and reviewing coverage, migrate saved state explicitly or use a new stream identity for a deliberate fresh scan.

Each stream permits 200 chunks per run and retains at most 1,000 conferences. Requests have a 30-second timeout. Budget exhaustion preserves progress and a later invocation continues it. Increase `maxChunks` and `maxPendingConferences` in `config.ts` deliberately for larger sources. A pending queue over its configured limit fails rather than silently dropping parents. The executor owns request retries, cancellation, and load acknowledgements. Run one ingestion process per ClickHouse target at a time.

Google deletes conference records and API transcript entries 30 days after a conference ends. The reader reports expiry during unfinished work as a coverage gap; it cannot recover expired API entries. Previously checked parents leave the work queue on expiry, while stored raw rows remain. It does not infer deletion from missing, inaccessible, or expired resources. See [conference retention](https://developers.google.com/workspace/meet/api/reference/rest/v2/conferenceRecords) and [artifact retention](https://developers.google.com/workspace/meet/api/guides/artifacts).

## Historical ranges

Explicit bounds apply to conference end times and use an isolated backfill checkpoint. Historical ranges skip ongoing-call discovery. Reuse the same backfill ID and bounds to resume; changing the bounds requires another ID. Child reads remain parent-scoped. Bounds select conference end times, not child creation, attendance, or modification times; all children of selected and retained conferences remain eligible. Expired history is unavailable even when a backfill range requests it.

```sh
bunx chkit ingest run --tag provider:google-meet --backfill october --from 2026-10-01T00:00:00Z --to 2026-10-05T00:00:00Z
```

Checkpoint validation rejects changed source/window scope and invalid nested positions. Migrate state explicitly or use a new stream identity when changing these settings.

## Upgrading from 0.1.x

Version 0.2.0 keeps the existing conference and transcript destinations and adds participant, session, recording, and entry tables. Existing conference and transcript stream IDs remain stable; added resource streams start with their own discovery and checkpoints. New transcript rows contain metadata; entries live in the separate table. Row identities now include `sourceId`, so upgraded observations do not replace legacy provider-name IDs. Old rows and their nested `entries` remain until an explicit identity/data migration. Keep older tables as archives or migrate identities deliberately before mixing datasets.

## Fixture tests

```sh
bunx chkit add google-meet --with-tests
bun test src/integrations/google-meet/tests/basic.test.ts
```

Fixtures verify all six streams independently and together, paged participant/session and transcript/entry recovery, late attendance and recordings from retained conferences, source failures, lost sink acknowledgements, changed replay content, fixed discovery bounds, persisted token-recovery debt, expiry gaps, factory configuration, and request-time token rotation without live credentials.

The [Google Meet integration guide](https://chkit.obsessiondb.com/integrations/google-meet/) covers installation and sync behavior.
