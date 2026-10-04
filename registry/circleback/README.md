# Circleback raw ingestion example

This is a small editable starting point based on the Circleback source in [obsessiondb/brain](https://github.com/obsessiondb/brain/tree/main/scripts/brain-sync). It stores provider responses as native JSON without Brain's memory or sales projections.

Set `CIRCLEBACK_API_KEY` in the runtime environment and configure a direct ClickHouse connection. Edit the reader in `index.ts` to select meetings and decide whether to fetch transcripts. Native JSON requires ClickHouse 25.3 or later.

```sh
bunx chkit check
bunx chkit generate --name add_circleback
# Review the migration before applying it.
bunx chkit migrate --apply
bunx chkit ingest run --tag provider:circleback
```

## Resources

- `meetings` → `circleback_meetings_raw`

## Sync and recovery

Every new scan cycle reads all accessible meetings using `ownership=All` and the provider's `Link` continuations. The documented listing has no modification-time filter, and no durable lifetime is promised for its opaque page cursor. Failed scans restart pagination from the first page and skip only parents whose metadata and transcript observation were already acknowledged by the destination in that active cycle. Unfinished parent enrichment is replayed. Exhausting the listing clears the active cycle, so the following run observes every accessible meeting again. Changes to parents skipped during recovery are refreshed in that next cycle. The reader does not assume a meeting's `updatedAt` tracks transcript availability.

The checkpoint includes the explicit source/filter `scope`, the active cycle's start time and acknowledged `completedMeetingIds`, `completedAt` for the last fully exhausted cycle, and `unavailableTranscripts` diagnostics with distinct statuses and times checked. Each parent observation and its recovery state commit together after destination acknowledgement. A final empty marker records scan completion, including empty scans. Loaded observations can remain visible after a later failure, while `completedAt` stays at the previous complete scan.

Transcript `403` responses retain `forbidden`; `404` responses retain `not_found`. Both preserve a null transcript with `_chkit_transcript_status` in raw JSON. Neither status is interpreted as proof of temporary processing. A new cycle retries listed meetings even if their metadata did not change. Unavailable IDs absent from a later listing remain diagnostics because absence is not proof of deletion. These diagnostics are not an executable work queue: no independent request is made for an ID absent from the listing. They are retried when the meeting is listed again; an explicit reconciliation policy may resolve IDs that remain inaccessible. Listing permission failures and other failed requests fail the stream.

The `maxRetainedMeetings` setting defaults to `10_000`, bounding active parent IDs and unavailable diagnostics. Exceeding a bound fails visibly and keeps committed recovery progress; resolve old diagnostics or raise the setting deliberately for a larger account. When changing authenticated accounts, change `sourceIdentity`, the stream ID and the destination identity. A changed source/filter scope is rejected rather than reusing another source's progress.

```sh
bunx chkit ingest status --tag provider:circleback --json
```

Removed meetings remain stored. Full scans over a changing API are not atomic provider snapshots. Run one ingestion process per ClickHouse target at a time.

## Fixture tests

```sh
bunx chkit add circleback --with-tests
bun test src/integrations/circleback/tests/basic.test.ts
```

The portable suite covers continuation links, unavailable-to-available transcripts, sink failure, bounded cycle recovery, unavailable diagnostics and first-page replay without live credentials.
