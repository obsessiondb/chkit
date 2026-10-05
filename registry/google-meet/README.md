# Google Meet raw ingestion

This editable reader rereads recent conferences and their raw resources, using ordinary pagination and coarse discovery-page checkpoints.

Set `GOOGLE_MEET_ACCESS_TOKEN` with `meetings.space.readonly` access and configure a direct ClickHouse connection. Review `sourceId`, `streamPrefix`, `lookbackHours`, `pageSize`, `maxChunks`, and `database` in `config.ts`. Keep source identity tied to one Google account; these list responses do not identify the authenticated account. Tokens are read at request time and are not refreshed by the reader. Meet requires user authentication and returns records accessible to that user. Native JSON requires ClickHouse 25.3 or later. See [authorization](https://developers.google.com/workspace/meet/api/guides/authenticate-authorize).

```sh
bunx chkit check
bunx chkit generate --name add_google_meet
# Review the migration before applying it.
bunx chkit migrate --apply
bunx chkit ingest run --tag provider:google-meet
bunx chkit ingest status --tag provider:google-meet
```

## Resources and streams

One installation pipeline contains six independent streams and destinations:

- `conferences` → `google_meet_conferences_raw`
- `participants` → `google_meet_participants_raw`
- `participant-sessions` → `google_meet_participant_sessions_raw`
- `recordings` → `google_meet_recordings_raw`
- `transcripts` → `google_meet_transcripts_raw`
- `transcript-entries` → `google_meet_transcript_entries_raw`

Every child stream discovers its own conferences. Sessions also discover participants; entries also discover transcripts. Select resources independently, in any order. Parent publication does not wait for children.

```sh
bunx chkit ingest run --tag provider:google-meet --tag resource:transcript-entries
bunx chkit ingest run --tag provider:google-meet --tag resource:participant-sessions
```

`pipeline.ts` binds configuration, strategies and destinations. `sources/resources.ts` contains ordinary resource traversal; `client.ts` validates requests and uses `paginate`. The plugin owns request retries, cancellation, destination acknowledgement and checkpoint persistence.

`sourceId` scopes raw identities and queries; `streamPrefix` determines journal IDs. Use separate values for another installation. `createGoogleMeetPipeline` snapshots configuration and injectable HTTP/token dependencies. Raw destinations are setup-time exports: edit `database` before schema imports to change placement. The default pipeline runs one stream and request at a time.

## Recent coverage

Initial discovery covers the preceding 24 hours by conference end time. Later runs begin at the last completed watermark minus `lookbackHours` (24 by default), so they reread recent calls and catch up after missed runs. Ongoing calls are discovered separately through `end_time IS NULL`, including calls that started before the lookback. Explicit historical bounds skip ongoing calls.

Each selected conference's child collections are read completely. There is no retained-conference catalog, delayed-work queue, or automatic historical reconciliation. A transcript or recording that appears after its conference leaves the selected window requires a wider configured lookback or explicit backfill. Meet conference timestamps are not child modification timestamps. This is a deliberate recent polling policy. See [conference filters](https://developers.google.com/workspace/meet/api/reference/rest/v2/conferenceRecords/list) and [artifacts](https://developers.google.com/workspace/meet/api/guides/artifacts).

## Checkpoints and replay

A checkpoint contains source scope, completed watermark, optional historical bounds, and an unfinished discovery window with phase/page token. The window is saved before discovery starts. Each discovery page and all its children finish before a state-only boundary advances its token; the executor commits that boundary only after the preceding rows land.

A failed or interrupted page replays its child collections from their beginning under the original bounds. Completed discovery pages remain skipped. Child pages, indices and queues are not saved. The default discovery `pageSize` is one conference and `maxChunks` is 200. A page's children plus its completion marker must fit a run's chunk/time budget; increase `maxChunks` or `--max-duration` if one conference is too large. Requests have a 30-second timeout.

A rejected page token restarts its collection once. Discovery reset debt is saved across executions and clears after the phase finishes. Child token recovery is bounded within its current read; a replayed parent starts fresh child collections. Repeated rejection and malformed/cyclic continuation fail visibly.

Checkpoint strategy version 2 rejects incompatible state rather than reinterpreting it. Changing source or discovery settings requires deliberate state migration or a new `streamPrefix`. Run one ingestion process per target at a time.

## Raw updates and relationships

Raw identity is `[sourceId, provider.name]`. Children add `conference_name`; sessions add `participant_name`, and entries add `transcript_name`. All provider fields stay raw. Join resources and assemble transcripts later in ClickHouse.

Participants represent attendance; sessions represent individual joins/leaves. Recordings preserve metadata and Drive references without downloading files. Transcripts preserve metadata and document references; entry rows preserve individual speech segments. API entries do not reflect later edits to the separate Google Docs document.

Tables use `ReplacingMergeTree(_chkit_ingested_at)`. Every observed payload is inserted with the same stable resource ID; later ingestion wins. A transcript changing from `ENDED` to `FILE_GENERATED` therefore replaces its earlier observation. An empty transcript list emits no placeholder, so a later transcript inserts normally. No body hash or insert-only staging is needed. Use `FINAL` for latest observations.

Missing, inaccessible or expired resources do not imply deletion. Google removes conference records and API entries after its retention period; expired history cannot be recovered, and stored raw observations remain. See [conference retention](https://developers.google.com/workspace/meet/api/reference/rest/v2/conferenceRecords).

## Historical ranges and upgrades

Backfill bounds select conference end times, not child modification times. All children of selected conferences are read. Reuse the same backfill ID and bounds to resume; changed bounds require a new ID.

```sh
bunx chkit ingest run --tag provider:google-meet --backfill october --from 2026-10-01T00:00:00Z --to 2026-10-05T00:00:00Z
```

Version 0.2.0 preserves the existing conference/transcript destinations and adds participant, session, recording and entry tables. Entries are separate rows rather than embedded transcript arrays. New row IDs include `sourceId`; legacy provider-name IDs remain until an explicit identity/data migration. Keep old rows as archives or migrate them deliberately.

## Fixture verification

```sh
bunx chkit add google-meet --with-tests
bun test src/integrations/google-meet/tests/basic.test.ts
```

Fixtures cover independent resources, unfinished-page replay, completed-page resume, sink acknowledgement loss, changed bodies under stable IDs, recent late transcripts, empty pages, bounded token resets, fixed windows, scoped settings, historical isolation and request-time tokens.

The [Google Meet integration guide](https://chkit.obsessiondb.com/integrations/google-meet/) covers installation and sync behavior.
