# Linear raw ingestion example

One workspace pipeline syncs nine independent resource streams into native JSON tables. Readers preserve provider fields and relationship IDs; joins, business mappings, and derived metrics belong in ClickHouse. Issue labels are the explicitly selected exception: their complete names are stored as strings on each issue.

Set `LINEAR_API_KEY` in the runtime environment and configure a direct ClickHouse connection. Edit the GraphQL queries and raw table declarations in `sources/` to request fields and configure destinations. Native JSON requires ClickHouse 25.3 or later.

`config.ts` supplies source identity, initial timestamp, and overlap. `createLinearPipeline(config, deps)` snapshots configuration and binds injectable `fetch` and token readers. `pipeline.ts` groups resources without dependency ordering. Destination schemas stay in their source modules rather than runtime configuration.

Keep stream IDs and destinations tied to one Linear workspace. The reader does not resolve the authenticated workspace identity: changing the token to another workspace requires a new source ID and destinations before ingestion, so old checkpoints cannot skip its history. Adding requested fields later requires reconciliation to populate older observations.

```sh
bunx chkit check
bunx chkit generate --name add_linear
# Review the migration before applying it.
bunx chkit migrate --apply
bunx chkit ingest run --tag provider:linear
```

## Resources

| Stream suffix | Raw table | Selection |
| --- | --- | --- |
| `issues` | `linear_issues_raw` | Updated-time window |
| `comments` | `linear_comments_raw` | Own updated-time window |
| `projects` | `linear_projects_raw` | Updated-time window |
| `project_updates` | `linear_project_updates_raw` | Own updated-time window |
| `cycles` | `linear_cycles_raw` | Updated-time window |
| `users` | `linear_users_raw` | Updated-time window, including disabled users |
| `teams` | `linear_teams_raw` | Updated-time window |
| `issue_relations` | `linear_issue_relations_raw` | Full accessible relation collection |
| `issue_history` | `linear_issue_history_raw` | All accessible history after independent issue discovery |

The default IDs are `linear` for the pipeline and `linear.<resource>` for each stream. Each owns its journal progress. Run a resource separately with:

```sh
bunx chkit ingest run --tag provider:linear --tag resource:comments
bunx chkit ingest run --tag provider:linear --tag resource:issue_history
```

Repeated tags use AND matching. The default `maxStreams: 1` executes selected streams sequentially to limit API usage. Selection and failure in one stream do not make another stream's discovery depend on it. Give expensive history reads their own schedule and execution budget; individual issues remain records inside the resource stream.

## Stored data and joins

Each table uses the provider record ID as its row identity and retains requested fields directly in `raw`. Relationships remain provider-shaped references such as `project: { id }`, `cycle: { id }`, or `issue: { id }`. Join those IDs to other raw tables in ClickHouse.

Issues contain metadata, state details, relationship IDs, and a fully paginated `labels` string array. Comments, project updates, relations, and history are individual records in their own tables. Comments retain nullable parent IDs and user references, including comments on project updates or other parent types. Issue history retains native transition fields and its issue reference; cycle movement and status-duration calculations happen downstream.

Workflow state, project status, and label definition streams are outside this package's current scope. Project/team memberships and other paginated associations are not fetched as truncated nested collections. Bounded inline state/status metadata remains raw.

## Sync and recovery

Seven root collections use bounded `updatedAt` filters, `orderBy: updatedAt`, and `includeArchived: true`. Users also request `includeDisabled: true`. Each initial window starts at the configured date, defaulting to the Unix epoch. Subsequent windows replay five minutes before that stream's committed watermark. Comments use their own collection and update timestamp; a comment on an old issue does not require the issue stream to run or its parent timestamp to change.

Relay cursors only continue the current read. `paginate()` owns request retries and rejects repeated continuations; readers validate connections, identities, timestamps, and GraphQL errors, including partial responses. Issues complete all label pages before publishing their label strings. A label retrieval failure leaves only the issues window incomplete.

Newest-first pages do not define a safe timestamp frontier. A window checkpoint advances to its upper cutoff only after all pages and destination writes succeed, including an empty successful window. An interrupted or failed window replays from its lower bound. Mutable row chunks omit explicit immutable IDs so changed provider fields stay eligible on replay.

Issue relations have a root listing without a reliable timestamp filter. Issue history has no workspace-level feed or timestamp filter: its reader independently paginates every accessible issue ID, then each issue's history. Both use the library's `fullSync()` completion checkpoints. Each invocation starts its collection again, and interrupted work replays from the beginning. Their successful completion is journaled even when empty; no parent stream watermark, saved mutable offset, or per-issue scan ledger is used. Full-sync resources ignore date bounds and provide no date-range backfill.

The API does not guarantee atomic snapshots. Deleted records and removed relations remain stored; missing observations do not generate tombstones. A label rename is not assumed to update every issue's timestamp. Periodic reconciliation refreshes older observations and changes beyond overlap:

```sh
bunx chkit ingest run --tag provider:linear --tag resource:issues --backfill reconcile-2026-10-05 --from 1970-01-01
bunx chkit ingest status --tag provider:linear --json
```

Use a new backfill ID for each reconciliation. Timestamp replay reads current observations, while the separate history stream reads the provider's accessible event records; neither reconstructs an atomic historical workspace snapshot. Run one ingestion process per ClickHouse target at a time.

## Upgrading existing data

Version `0.2.0` adds eight raw destinations and keeps issue row IDs and the default `linear.issues` stream ID stable. Published `0.1.0` installations may retain nested comment payloads in issue JSON. Those observations are neither removed nor moved automatically: populate the new destinations through their own initial reads and reconcile or deliberately migrate legacy data. Application queries should join the comments table; old embedded fields can remain until their issue is observed again or migrated.

## Fixture tests

```sh
bunx chkit add linear --with-tests
bun test src/integrations/linear/tests/basic.test.ts
```

Portable fixtures exercise independent selection and checkpoints, raw fields and join IDs, complete label names, old-parent comment and history coverage, continuation validation, retries, source/sink failure replay, mutable full reads, and empty completion without live credentials.
