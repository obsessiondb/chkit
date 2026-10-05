# Circleback raw ingestion

This editable integration stores Circleback provider objects in five independent raw resource streams within one account pipeline.

Set `CIRCLEBACK_API_KEY` in the runtime environment. Create a key in Circleback **Settings → API keys** and configure the project's direct ClickHouse connection. Native JSON requires ClickHouse 25.3 or later. The [official API reference](https://circleback.ai/docs/api) describes authentication, access and account rate limits.

Edit `config.ts` for the stable `sourceId`, meeting `ownership`, and setup-time `database`. `ownership: 'All'` includes meetings shared with the authenticated user. People, companies, and action items use their own authenticated-user API collections; these APIs do not promise an organization-wide export.

```sh
bunx chkit check
bunx chkit generate --name add_circleback
# Review the migration before applying it.
bunx chkit migrate --apply
bunx chkit ingest run --tag provider:circleback
```

## Resources

| Resource tag | Raw table | Retrieval |
|---|---|---|
| `resource:meetings` | `circleback_meetings_raw` | All accessible meeting pages with configured ownership. |
| `resource:meeting_transcripts` | `circleback_meeting_transcripts_raw` | Own complete meeting discovery, then a whole transcript snapshot per meeting. |
| `resource:action_items` | `circleback_action_items_raw` | All pages of both `PENDING` and `DONE`, with `assigneeType=Anyone`. |
| `resource:people` | `circleback_people_raw` | All attendee person pages and their same-person detail responses. |
| `resource:companies` | `circleback_companies_raw` | All company pages and their same-company detail responses. |

`pipeline.ts` composes the streams; `sources/` contains each raw schema and reader. `client.ts` owns authenticated requests, validation, scoped row mapping, and native `paginate()` Link traversal. `index.ts` exports the pipeline and all five tables. Selecting one resource or reversing stream order requires no other stream to run. Meeting publication does not depend on transcript retrieval.

Provider fields stay under `raw.data`; meeting objects retain provider-returned notes, attendee and action-item summaries, insights, and recording links. Transcripts and independently listed action items are not fetched to assemble a meeting document. The requested projection is `tags: string[]`: every returned tag name is retained, while tag definitions have no separate stream. Recordings and other binary links are preserved without downloading their content.

People perform one [detail GET per listed profile](https://circleback.ai/docs/api/people/get-person), preserving native fields and `externalLinks`; returned IDs must match discovery. Companies similarly request one detail per listed domain. These same-resource reads add to each full run's request cost and require matching access.

```sh
bunx chkit ingest run --tag provider:circleback --tag resource:meeting_transcripts
bunx chkit ingest status --tag provider:circleback --json
```

## Full reads and recovery

The [provider's list endpoints](https://circleback.ai/docs/api) return arrays with RFC 8288 `Link` continuations. They expose no reliable modification feed or durable sync token. Each stream uses `fullSync()` and ordinary pagination, revisiting its complete accessible collection on every run. Cursor-only next links retain the stream's fixed ownership, assignee and status filters; conflicting filters, malformed pages, unsafe URLs and cyclic continuations fail visibly.

Successful completion follows destination acknowledgement and includes empty reads. A failed or interrupted stream replays from its first page on the next run. Loaded rows may remain visible after a later failure; other streams keep their own successful completion. There is no custom parent ledger or scan checkpoint. Full reads ignore date backfill bounds and provide no date-range backfill.

Transcript discovery has its own full meeting listing. It rechecks old meetings without relying on a meeting's `updatedAt`, capturing transcripts that become available later. IDs absent from the current listing are not an executable retry queue. A changed or inaccessible source cannot establish deletion; absent records stay stored.

The [action-item listing](https://circleback.ai/docs/api/action-items/list-action-items) defaults to the authenticated assignee and incomplete items. The integration explicitly reads any assignee across both native completion statuses. `PENDING` and `DONE` are the exhaustive statuses in the [official OpenAPI](https://circleback.ai/docs/api/openapi.json), also documented by the [update endpoint](https://circleback.ai/docs/api/action-items/update-action-item). An unexpected status or ignored partition fails visibly. Mutable lists and status partitions are not atomic snapshots; a later full run reconciles edits and moves between partitions.

Requests forward cancellation, time out after 30 seconds, and use one executor-owned retry wrapper. HTTP failures retain provider responses; `429` honors `Retry-After`. Authentication and listing permission failures fail their resource. Run one ingestion process per ClickHouse target at a time and repeat runs with an external scheduler.

## Identities and company joins

Every row keeps `raw.source_id`. Stable row IDs are JSON-encoded arrays:

| Resource | Row identity |
|---|---|
| Meetings | `[sourceId, meeting.id]` |
| Transcript snapshot | `[sourceId, meetingId]` |
| Transcript read outcome | `[sourceId, meetingId, 'availability']` |
| Action items | `[sourceId, actionItem.id]` |
| People | `[sourceId, person.id]` |
| Companies | `[sourceId, company.domain]` |

Numeric provider IDs such as `assignee.profileId` and `person.companyId` remain numbers in `data`; `meetingIds` retain their native strings. Keep source identity in joins. Company identity always uses the provider domain, so a numeric ID appearing later does not change its row key.

The [company list](https://circleback.ai/docs/api/companies/list-companies) permits an optional native numeric `id`; [company detail](https://circleback.ai/docs/api/companies/get-company) includes people and external links. The companies stream preserves both listing and detail fields under `data`. Its `company_id` envelope field is the listed/detail native ID or a consistent non-null `people[].companyId`; conflicting native IDs fail. A valid empty company without a numeric ID still syncs with `company_id: null`. No numeric ID is synthesized. Join `person.data.companyId` to `company.company_id` only when present, together with `source_id`; unknown numeric identity is a documented join gap.

Keep `sourceId` stable. Switching accounts or meeting filters requires a distinct source ID and deliberately configured destination. `createCirclebackPipeline(config, deps)` binds a snapshot of reader configuration and optional HTTP dependencies. Its runtime config does not redefine exported tables; change `database` or installed raw table definitions before schema discovery and migration generation.

Version 0.1.0 used direct meeting JSON and unscoped meeting row IDs. The 0.2.0 layout introduces source envelopes, scoped row keys, string tags and four additional tables. Reingest into a fresh configured destination or migrate earlier observations deliberately; old unscoped rows are not automatically rewritten or deleted.

## Transcript snapshots and availability

The transcript table contains two explicitly distinguished observations per meeting:

- `kind: 'transcript'`: the last successfully retrieved full segment array under `data`, with `status: 'available'`.
- `kind: 'availability'`: the latest read outcome, `available`, `forbidden` for HTTP 403, or `not_found` for HTTP 404.

A 403/404 updates the outcome key and preserves earlier successful text. It proves neither deletion nor temporary processing. A valid HTTP 200 empty array replaces the prior snapshot with `[]`; malformed HTTP 200 content fails without publishing success. Segment speaker, text, timestamps and additional fields stay intact, with no synthetic segment IDs.

Use `FINAL` for latest observations and filter successful snapshots explicitly:

```sql
SELECT
  raw.source_id::String AS source_id,
  raw.meeting_id::String AS meeting_id,
  JSONExtractRaw(toJSONString(raw), 'data') AS transcript
FROM default.circleback_meeting_transcripts_raw FINAL
WHERE raw.kind::String = 'transcript';
```

Latest outcomes are the `kind = 'availability'` rows in the same table. Join them to snapshots on `source_id` and `meeting_id`; an outcome can be forbidden while a previous successful snapshot remains readable. The [integration guide](https://chkit.obsessiondb.com/integrations/circleback/) shows that query.

## Fixture tests

```sh
bunx chkit add circleback --with-tests
bun test src/integrations/circleback/tests/basic.test.ts
```

Portable fixtures use injected HTTP and in-memory ingestion adapters without credentials or a live database. They cover five isolated and reordered resources, full-sync failure/replay, empty completion, scoped identities, tag names, all action statuses, company joins, late transcripts, permission-loss retention, malformed responses, and pagination safety.
