# Lemlist raw ingestion

Sync seven Lemlist resources into independent raw ClickHouse tables. Provider records retain their native fields; transformations, campaign/contact joins, and reporting belong in ClickHouse.

Set `LEMLIST_API_KEY` in the runtime environment and configure a direct ClickHouse connection. Edit `config.ts` for the account namespace, page size, initial date, overlap, and interval length. Native JSON requires ClickHouse 25.3 or later.

`pipeline.ts` groups seven independently selectable streams in one account pipeline. Each resource owns its checkpoint and discovery; execution order is not a dependency. `sources/` contains the resource readers; `client.ts` supplies authenticated requests and `paginate()`. `index.ts` exports the pipeline and raw schema. Use `createLemlistPipeline(config, deps)` to bind reader settings and optional HTTP dependencies. Page size must be between 1 and 100. The exported raw tables use the installation's `lemlistConfig.database` at schema discovery; factories do not change storage names.

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
- `contacts` → `lemlist_contacts_raw`
- `companies` → `lemlist_companies_raw`
- `campaign_leads` → `lemlist_campaign_leads_raw`
- `inbox_conversations` → `lemlist_inbox_conversations_raw`
- `inbox_messages` → `lemlist_inbox_messages_raw`

Contacts represent team-wide people; campaign leads are their distinct campaign-specific records and memberships. The [contact list](https://developer.lemlist.com/api-reference/endpoints/contacts/get-many-contacts) is a reduced representation, so the contacts reader fetches full same-resource records in batches of at most 100 IDs. Native custom fields and `campaigns[].campaignId/leadId` references remain intact. Companies are read through their complete paginated list.

Campaign leads discover every campaign themselves and use [the JSON export](https://developer.lemlist.com/api-reference/endpoints/campaigns/export-campaign-leads-v2) with `state=all`. The ordinary campaign lead list documents a 500-record limit and no continuation; it is not used. Export records are preserved under `raw.data`, with `source_id` and `campaign_id` alongside them. Exports do not guarantee `contactId`; join the native lead ID against contacts' campaign references in ClickHouse rather than matching email addresses.

Conversations independently discover all current team member IDs through `GET /team?version=v2`, then paginate each user's inbox. Set `inboxUserIds` to an explicit nonempty list to restrict this stream. An empty or omitted list means all discovered team members. A missing member list fails visibly; it is not an empty successful inbox. Conversation envelopes retain `source_id`, `user_id`, and untouched `data`.

Messages independently paginate all current contacts, including old contacts, then page each contact's complete accessible message history with `skip/limit`. `inboxUserIds` scopes only conversations; messages cover all accessible contacts in the account. Every message request explicitly sets `markAsRead=false`. Readers issue only GET requests and do not mark conversations read or perform inbox actions. Message envelopes retain `source_id`, `contact_id`, and untouched `data`.

## Sync and recovery

Activities use the provider's inclusive `minDate`/`maxDate` filters on `createdAt`. The initial range starts at `2000-01-01`; later runs replay one day before the last committed watermark. A large range is split into intervals of at most thirty days. Offset pagination stays local to each interval; an unfinished interval always starts at offset zero after failure. The checkpoint advances only after every page of an interval has been written successfully, including empty intervals. An explicit backfill resumes completed intervals in its own checkpoint namespace while retaining one day of overlap.

The upper bound does not freeze the provider dataset. Late arrivals or deletions can still change offset pages, and older activities can receive backfilled metadata. Do not treat activity offsets as change cursors or row chunks as immutable page identities. Periodic historical replay refreshes metadata and catches arrivals beyond the overlap:

```sh
bunx chkit ingest run --tag provider:lemlist --tag resource:activities --backfill reconcile-2026-10-04 --from 2000-01-01
bunx chkit ingest status --tag provider:lemlist --json
```

Use a new backfill ID for each complete reconciliation; reusing an ID resumes that backfill. A reused ID with an upper bound earlier than its committed frontier is rejected; use a new ID for a narrower historical range. Date intervals intentionally have inclusive shared boundaries; stable `_id` row keys reconcile repeated observations. Empty completion markers carry interval identities, while mutable row chunks do not.

The six resources besides activities use `fullSync()`: their list/export endpoints do not document reliable modification filters. Each successful execution, including empty results, is recorded in its own journal namespace. An interrupted stream repeats its own complete discovery and pagination from the beginning. Campaigns use `createdAt:asc` ordering; campaign leads revisit every campaign, and messages revisit every contact. Creation timestamps and inbox page numbers are not change tokens. These full reads ignore date backfill bounds and do not provide date-range backfills.

Offset and inbox pagination validate response shapes, bounds, advertised totals, and repeated pages; malformed or incomplete results fail before successful completion. Full reads are live lists rather than provider snapshots, so ongoing source changes can require another replay. Lead exports arrive as one JSON array per campaign and are yielded in bounded chunks; a large export still requires memory for the provider's complete response. API-key rate limits are handled by executor retries; pipeline defaults serialize streams and requests.

Raw observations do not infer deletions. Removed contacts, companies, campaign leads, conversations, messages, campaigns, or activities remain stored; full sync does not automatically delete missing IDs. Content and availability remain limited to the API key's accessible records. Run one ingestion process per ClickHouse target at a time.

## Identities and upgrading

Version 0.2.0 adds five raw destinations to the two original tables. Generate and review additive migrations before running the new streams. Existing activities/campaigns stream IDs, timestamp state, raw fields and native `_id` row keys stay unchanged; those original tables belong to one installation/account.

Contacts and companies preserve untouched provider records under `raw.data` with `source_id`; their row IDs encode `[sourceId, providerId]`. Campaign lead, conversation, and message row IDs encode `[sourceId, parentId, providerId]`. Conversation parent IDs are user IDs, preserving distinct user inbox observations even when the native conversation ID matches. Provider IDs remain unchanged inside `raw.data`. Changing the account requires new stream namespaces and destinations; changing the conversation user scope should use a new source namespace or explicitly reconcile its prior observations.

## Fixture tests

```sh
bunx chkit add lemlist --with-tests
bun test src/integrations/lemlist/tests/basic.test.ts
```

The portable suites check all seven resources alone and in reverse order, complete contact hydration, exports beyond 500 leads, user/contact pagination, unread preservation, empty completion, malformed continuations, source/destination replay, account configuration, and existing activity interval/backfill recovery without live credentials.

```sh
bun test src/integrations/lemlist/tests
```
